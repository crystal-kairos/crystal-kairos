/**
 * Savings workflows (P3-03): subscription with rate snapshot, first-deposit start, schedules,
 * principal lots, monthly interest accrual, per-period forfeiture, maturity and withdrawal.
 *
 * Policies: §1.3, §2.5, §2.6, §2.10, §2.12, §4.1; decisions D-08, D-09, D-17, D-22;
 * assumptions A-04 … A-08.
 *
 * Every read-then-write on a member's savings runs inside a transaction that first takes the
 * member advisory lock (`lockMembers`); status changes use conditional transitions.
 */
import { randomInt, randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import {
  AllocationStatus,
  AllocationTargetType,
  DisbursementPurpose,
  DisbursementStatus,
  LedgerAccountType,
  PaymentComponentType,
  PaymentPeriodStatus,
  PaymentSubmissionStatus,
  SavingsFrequency,
  SavingsStatus,
  SavingsType,
  SavingsWithdrawalKind,
  SubmissionPurpose,
  AdminPermission,
} from '@/generated/prisma/enums'
import { AppError } from '@/lib/errors/app-error'
import { lockMembers, transition } from '@/lib/db/concurrency'
import { roundMoney, sumDecimals, toDecimal, type DecimalValue } from '@/lib/domain/money'
import {
  addDays,
  diffDays,
  generateDailySavingsDueDates,
  generateMonthlySavingsDueDates,
  generateWeeklySavingsDueDates,
  isBefore,
  isSameOrBefore,
  lagosToday,
  parseDateOnly,
  toLagosDateString,
} from '@/lib/domain/dates'
import {
  accrualDatesForLot,
  evaluatePeriodForfeiture,
  lotInterest,
  monthlyPosting,
  savingsMaturityDate,
  toIsoDate,
  type PeriodForfeitureState,
} from '@/lib/domain/savings-interest'
import { formatSequentialNumber, nextSequenceAfter } from '@/lib/domain/payment-reference'
import {
  postJournalEntry,
  postSavingsInterestAccrual,
  postSavingsMaturityPayout,
  reverseJournalEntry,
} from '@/lib/services/ledger.service'
import { recordAuditEvent, AuditAction, AuditOutcome } from '@/lib/services/audit.service'
import { assertSavingsWithdrawalAllowed } from '@/lib/services/guarantees.service'
import { createPaymentSubmission } from '@/lib/services/payments.service'
import type { AllocationPeriodItem, CalculatedAllocation } from '@/lib/services/allocation.service'
import { enforceDualControl, type StaffActor } from '@/lib/authz/guards'

type Tx = Prisma.TransactionClient
type Db = typeof prisma

export const SAVINGS_INTEREST_METHOD = 'SIMPLE_HELD_TERM_FRACTION'

export const LotForfeitReason = {
  PERIOD_LATE: 'PERIOD_LATE',
  EARLY_WITHDRAWAL: 'EARLY_WITHDRAWAL',
  VOIDED: 'VOIDED',
} as const

/** Statuses whose principal is still held as savings (and may accrue/receive deposits). */
const OPEN_PLAN_STATUSES: SavingsStatus[] = [SavingsStatus.ACTIVE, SavingsStatus.MATURED]

/** Notification produced by a workflow; sent only after the transaction commits. */
export interface SavingsNotice {
  memberId: string
  subject: string
  message: string
}

function asDb(tx: Tx): Db {
  return tx as unknown as Db
}

/**
 * Submission, payment and disbursement numbers are "highest + 1", so two members acting at the
 * same moment can collide on the unique number. The whole transaction is retried; nothing was
 * committed by the failed attempt.
 */
async function withSequenceRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (error) {
      const e = error as { code?: string; meta?: { target?: unknown }; message?: string }
      const target = JSON.stringify(e?.meta?.target ?? '') + (e?.message ?? '')
      const isSequenceClash =
        e?.code === 'P2002' && /submissionNumber|disbursementNumber|paymentNumber/.test(target)
      if (!isSequenceClash || i >= attempts) throw error
      await new Promise((r) => setTimeout(r, 15 * i + randomInt(20)))
    }
  }
}

function dateOnly(d: Date | string): Date {
  return parseDateOnly(d)
}

// ============================================================================
// Subscription (D-08, D-09)
// ============================================================================

export interface SubscribeInput {
  memberId: string
  productId: string
  durationMonths: number
  /** FIXED: the target amount. REGULAR: the amount per period. STAGGERED: ignored. */
  targetAmount?: DecimalValue | null
  /** REGULAR only: DAILY | WEEKLY | MONTHLY. */
  frequency?: SavingsFrequency | null
}

/**
 * Creates a PENDING plan with a snapshotted term rate. No admin approval, schedule, start
 * date or maturity date until the first deposit is confirmed (D-08).
 * Eligibility (profile complete, approved, active, not staff) is checked by the caller.
 */
export async function subscribeToSavingsPlan(input: SubscribeInput, db: Db = prisma) {
  const duration = Number(input.durationMonths)
  if (!Number.isInteger(duration) || duration < 1 || duration > 12) {
    throw new AppError('VALIDATION_ERROR', 'Choose a term between 1 and 12 months.', {
      statusCode: 400,
      fieldErrors: { durationMonths: ['Choose a term between 1 and 12 months.'] },
    })
  }

  return db.$transaction(async (tx) => {
    await lockMembers(tx, [input.memberId])

    const product = await tx.savingsProduct.findUnique({ where: { id: input.productId } })
    if (!product || !product.isActive) {
      throw new AppError('NOT_FOUND', 'This savings plan is not available.', { statusCode: 404 })
    }

    const termRate = await tx.savingsProductTermRate.findFirst({
      where: { productId: product.id, durationMonths: duration, isActive: true },
      orderBy: { version: 'desc' },
    })
    if (!termRate) {
      throw new AppError('TERM_NOT_OFFERED', 'This plan does not offer the selected term.', {
        statusCode: 422,
        fieldErrors: { durationMonths: ['This plan does not offer the selected term.'] },
      })
    }

    let targetAmount: Prisma.Decimal | null = null
    let frequency: SavingsFrequency = SavingsFrequency.ONCE
    if (product.type === SavingsType.FIXED || product.type === SavingsType.REGULAR) {
      if (input.targetAmount === undefined || input.targetAmount === null) {
        throw new AppError('VALIDATION_ERROR', 'Enter an amount.', {
          statusCode: 400,
          fieldErrors: { targetAmount: ['Enter an amount.'] },
        })
      }
      targetAmount = roundMoney(input.targetAmount)
      if (targetAmount.lte(0)) {
        throw new AppError('VALIDATION_ERROR', 'The amount must be greater than zero.', {
          statusCode: 400,
          fieldErrors: { targetAmount: ['The amount must be greater than zero.'] },
        })
      }
    }
    if (product.type === SavingsType.REGULAR) {
      const allowed: SavingsFrequency[] = [
        SavingsFrequency.DAILY,
        SavingsFrequency.WEEKLY,
        SavingsFrequency.MONTHLY,
      ]
      if (!input.frequency || !allowed.includes(input.frequency)) {
        throw new AppError('VALIDATION_ERROR', 'Choose how often you will save.', {
          statusCode: 400,
          fieldErrors: { frequency: ['Choose daily, weekly or monthly.'] },
        })
      }
      frequency = input.frequency
    }

    const savings = await tx.savings.create({
      data: {
        userId: input.memberId,
        productId: product.id,
        savingsType: product.type,
        targetAmount,
        frequency,
        durationMonths: duration,
        ratePercentSnapshot: termRate.ratePercent,
        rateVersionSnapshot: termRate.version,
        interestMethod: SAVINGS_INTEREST_METHOD,
        status: SavingsStatus.PENDING,
      },
    })

    await recordAuditEvent(
      {
        actorId: input.memberId,
        affectedUserId: input.memberId,
        action: AuditAction.SAVINGS_PLAN_CREATED,
        entityType: 'Savings',
        entityId: savings.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: {
          productId: product.id,
          savingsType: product.type,
          durationMonths: duration,
          ratePercentSnapshot: termRate.ratePercent.toString(),
          rateVersionSnapshot: termRate.version,
          targetAmount: targetAmount?.toString() ?? null,
          frequency,
        },
      },
      tx,
    )

    return savings
  })
}

// ============================================================================
// Deposit submissions (P2-07 flow)
// ============================================================================

export interface SubmitSavingsDepositInput {
  memberId: string
  savingsId: string
  amount: DecimalValue
  paidOn: Date | string
  /** REGULAR (ACTIVE) plans: the period(s) this receipt pays. */
  periodIds?: string[]
  receiptFileId: string
  fileHash?: string
  bankReference?: string
  payerAccountName?: string
  receivingBankAccountId?: string
  narration?: string
  resubmissionOfId?: string
}

/**
 * Creates a PaymentSubmission for a savings plan. Only an authorised confirmation moves money.
 */
export async function submitSavingsDeposit(input: SubmitSavingsDepositInput, db: Db = prisma) {
  const amount = roundMoney(input.amount)
  if (amount.lte(0)) {
    throw new AppError('INVALID_AMOUNT', 'The amount must be greater than zero.', { statusCode: 400 })
  }

  return withSequenceRetry(() => db.$transaction(async (tx) => {
    await lockMembers(tx, [input.memberId])

    const plan = await tx.savings.findFirst({
      where: { id: input.savingsId, userId: input.memberId },
    })
    if (!plan) {
      throw new AppError('NOT_FOUND', 'Savings plan not found.', { statusCode: 404 })
    }

    let purpose: SubmissionPurpose
    let targets: { targetType: AllocationTargetType; targetId: string; targetPeriodId?: string; requestedAmount: Prisma.Decimal }[]

    if (plan.status === SavingsStatus.PENDING) {
      // Only one first-deposit receipt may be in review at a time.
      const pending = await tx.submissionTarget.findFirst({
        where: {
          targetType: AllocationTargetType.SAVINGS,
          targetId: plan.id,
          submission: { status: PaymentSubmissionStatus.SUBMITTED },
        },
      })
      if (pending) {
        throw new AppError(
          'FIRST_DEPOSIT_IN_REVIEW',
          'Your first deposit is already being reviewed. Wait for the result before uploading another receipt.',
          { statusCode: 409 },
        )
      }
      purpose = SubmissionPurpose.SAVINGS_FIRST_DEPOSIT
      targets = [{ targetType: AllocationTargetType.SAVINGS, targetId: plan.id, requestedAmount: amount }]
    } else if (plan.status === SavingsStatus.ACTIVE) {
      if (plan.savingsType === SavingsType.REGULAR) {
        const periodIds = [...new Set(input.periodIds ?? [])]
        if (periodIds.length === 0) {
          throw new AppError('VALIDATION_ERROR', 'Choose at least one period to pay.', {
            statusCode: 400,
            fieldErrors: { periodIds: ['Choose at least one period to pay.'] },
          })
        }
        const periods = await tx.savingsPeriod.findMany({
          where: { id: { in: periodIds }, savingsId: plan.id },
          orderBy: { dueDate: 'asc' },
        })
        if (periods.length !== periodIds.length) {
          throw new AppError('NOT_FOUND', 'One of the selected periods does not belong to this plan.', {
            statusCode: 404,
          })
        }
        const open = periods.filter((p) => toDecimal(p.amountDue).gt(p.amountPaid))
        if (open.length !== periods.length) {
          throw new AppError('PERIOD_ALREADY_PAID', 'One of the selected periods is already fully paid.', {
            statusCode: 409,
          })
        }
        purpose = SubmissionPurpose.SAVINGS_PERIOD
        targets = open.map((p) => ({
          targetType: AllocationTargetType.SAVINGS,
          targetId: plan.id,
          targetPeriodId: p.id,
          requestedAmount: toDecimal(p.amountDue).minus(p.amountPaid),
        }))
      } else {
        if (
          plan.savingsType === SavingsType.FIXED &&
          plan.targetAmount &&
          toDecimal(plan.currentBalance).gte(plan.targetAmount)
        ) {
          throw new AppError(
            'SAVINGS_TARGET_REACHED',
            'This plan has reached its target. No more deposits can be accepted.',
            { statusCode: 409 },
          )
        }
        purpose = SubmissionPurpose.SAVINGS_DEPOSIT
        targets = [{ targetType: AllocationTargetType.SAVINGS, targetId: plan.id, requestedAmount: amount }]
      }
    } else {
      throw new AppError('INVALID_STATE', 'Deposits are not accepted for this plan in its current state.', {
        statusCode: 409,
      })
    }

    const { submission, warnings } = await createPaymentSubmission(
      {
        memberId: input.memberId,
        claimedAmount: amount,
        paidOn: input.paidOn,
        purpose,
        receivingBankAccountId: input.receivingBankAccountId,
        bankReference: input.bankReference,
        payerAccountName: input.payerAccountName,
        receiptFileId: input.receiptFileId,
        fileHash: input.fileHash,
        narration: input.narration,
        targets,
      },
      asDb(tx),
    )

    if (input.resubmissionOfId) {
      const original = await tx.paymentSubmission.findFirst({
        where: {
          id: input.resubmissionOfId,
          memberId: input.memberId,
          status: PaymentSubmissionStatus.REJECTED,
        },
        select: { id: true },
      })
      if (original) {
        await tx.paymentSubmission.update({
          where: { id: submission.id },
          data: { resubmissionOfId: original.id },
        })
      }
    }

    await tx.storedFile.updateMany({
      where: { id: input.receiptFileId },
      data: {
        ownerUserId: input.memberId,
        associatedType: 'PaymentSubmission',
        associatedId: submission.id,
      },
    })

    const today = lagosToday()
    for (const t of targets) {
      if (t.targetPeriodId) await refreshSavingsPeriodStatus(tx, t.targetPeriodId, today)
    }

    await recordAuditEvent(
      {
        actorId: input.memberId,
        affectedUserId: input.memberId,
        action: AuditAction.SAVINGS_DEPOSIT_SUBMITTED,
        entityType: 'Savings',
        entityId: plan.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: {
          submissionId: submission.id,
          purpose,
          amount: amount.toString(),
          periodCount: targets.filter((t) => t.targetPeriodId).length,
        },
      },
      tx,
    )

    return { submission, warnings }
  }))
}

// ============================================================================
// Payment confirmation hooks (called by payments.service inside its transaction)
// ============================================================================

export interface SavingsPlanCapacity {
  savingsId: string
  /** Maximum principal the plan may take from this payment; null = unlimited (STAGGERED). */
  capacity: Prisma.Decimal | null
}

export interface PreparedSavingsTargets {
  periodItems: AllocationPeriodItem[]
  planCapacities: SavingsPlanCapacity[]
  activatedPlanIds: string[]
}

/**
 * Builds the savings part of an allocation. A PENDING plan is activated here with the
 * payment's value date as its start date (D-08, A-06): maturity and the regular schedule are
 * derived from it, and the deposit is applied to period 1. Fixed plans take up to the
 * remaining target; staggered plans take any amount. Anything else goes to the wallet.
 */
export async function prepareSavingsTargetsForConfirmation(
  tx: Tx,
  params: {
    memberId: string
    targets: { targetType: AllocationTargetType; targetId: string; targetPeriodId: string | null }[]
    valueDate: Date
    actorId: string
  },
): Promise<PreparedSavingsTargets> {
  const result: PreparedSavingsTargets = { periodItems: [], planCapacities: [], activatedPlanIds: [] }
  const savingsTargets = params.targets.filter((t) => t.targetType === AllocationTargetType.SAVINGS)
  const planIds = [...new Set(savingsTargets.map((t) => t.targetId))]

  for (const planId of planIds) {
    let plan = await tx.savings.findFirst({ where: { id: planId, userId: params.memberId } })
    if (!plan) continue

    if (plan.status === SavingsStatus.PENDING) {
      // ASSUMPTION A-06: the first deposit's value date is the start date and it pays period 1.
      plan = await activateSavingsPlan(tx, plan.id, params.valueDate, params.actorId)
      result.activatedPlanIds.push(plan.id)
      if (plan.savingsType === SavingsType.REGULAR) {
        const first = await tx.savingsPeriod.findFirst({
          where: { savingsId: plan.id, periodNumber: 1 },
        })
        if (first) result.periodItems.push(toPeriodItem(first))
        continue
      }
    } else if (plan.status !== SavingsStatus.ACTIVE) {
      continue // matured / closed plans take no more principal: the amount goes to the wallet
    }

    if (plan.savingsType === SavingsType.REGULAR) {
      const periodIds = savingsTargets
        .filter((t) => t.targetId === plan!.id && t.targetPeriodId)
        .map((t) => t.targetPeriodId as string)
      const periods = await tx.savingsPeriod.findMany({
        where: { id: { in: periodIds }, savingsId: plan.id },
      })
      for (const p of periods) result.periodItems.push(toPeriodItem(p))
    } else if (plan.savingsType === SavingsType.FIXED) {
      const remaining = plan.targetAmount
        ? Prisma.Decimal.max(0, toDecimal(plan.targetAmount).minus(plan.currentBalance))
        : new Prisma.Decimal(0)
      result.planCapacities.push({ savingsId: plan.id, capacity: remaining })
    } else {
      result.planCapacities.push({ savingsId: plan.id, capacity: null })
    }
  }
  return result
}

function toPeriodItem(p: {
  id: string
  savingsId: string
  periodNumber: number
  dueDate: Date
  amountDue: Prisma.Decimal
  amountPaid: Prisma.Decimal
}): AllocationPeriodItem {
  return {
    periodId: p.id,
    targetType: 'SAVINGS',
    targetId: p.savingsId,
    periodNumber: p.periodNumber,
    dueDate: p.dueDate,
    penaltyDue: 0,
    interestDue: 0,
    principalDue: Math.max(0, toDecimal(p.amountDue).minus(p.amountPaid).toNumber()),
  }
}

/**
 * Moves the wallet excess of an allocation into fixed/staggered plans up to their capacity
 * (§2.10 rule 3: excess goes "to the wallet (or the plan, for savings)"). Pure.
 */
export function applySavingsPlanCapacity(
  allocations: CalculatedAllocation[],
  planCapacities: SavingsPlanCapacity[],
): { allocations: CalculatedAllocation[]; excessToWallet: number } {
  const walletIdx = allocations.findIndex((a) => a.targetType === AllocationTargetType.WALLET)
  if (walletIdx === -1 || planCapacities.length === 0) {
    const excess = walletIdx === -1 ? 0 : allocations[walletIdx].amount
    return { allocations, excessToWallet: excess }
  }
  const out = allocations.filter((_, i) => i !== walletIdx)
  const wallet = allocations[walletIdx]
  let remaining = roundMoney(wallet.amount)
  for (const cap of planCapacities) {
    if (remaining.lte(0)) break
    const take = cap.capacity === null ? remaining : Prisma.Decimal.min(remaining, cap.capacity)
    if (take.lte(0)) continue
    out.push({
      targetType: AllocationTargetType.SAVINGS,
      targetId: cap.savingsId,
      periodId: null,
      componentType: PaymentComponentType.PRINCIPAL,
      amount: take.toNumber(),
    })
    remaining = remaining.minus(take)
  }
  if (remaining.gt(0)) out.push({ ...wallet, amount: remaining.toNumber() })
  return { allocations: out, excessToWallet: remaining.toNumber() }
}

/**
 * After the payment's allocations exist: one immutable lot per savings principal allocation,
 * plan balances and period amounts updated, forfeiture and period statuses recomputed.
 */
export async function onSavingsAllocationsConfirmed(
  tx: Tx,
  params: { paymentId: string; memberId: string; valueDate: Date; actorId: string },
) {
  const allocations = await tx.paymentAllocation.findMany({
    where: {
      paymentId: params.paymentId,
      targetType: AllocationTargetType.SAVINGS,
      componentType: PaymentComponentType.PRINCIPAL,
      status: AllocationStatus.ACTIVE,
    },
    orderBy: { createdAt: 'asc' },
  })
  const touchedPeriods = new Set<string>()
  const valueDate = dateOnly(params.valueDate)

  for (const alloc of allocations) {
    const existing = await tx.savingsLot.findUnique({ where: { allocationId: alloc.id } })
    if (existing) continue // idempotent replay

    const lot = await tx.savingsLot.create({
      data: {
        savingsId: alloc.targetId,
        allocationId: alloc.id,
        principal: alloc.amount,
        valueDate,
        savingsPeriodId: alloc.periodId,
      },
    })
    await tx.savings.update({
      where: { id: alloc.targetId },
      data: {
        currentBalance: { increment: alloc.amount },
        totalDeposited: { increment: alloc.amount },
      },
    })
    if (alloc.periodId) {
      await tx.savingsPeriod.update({
        where: { id: alloc.periodId },
        data: { amountPaid: { increment: alloc.amount } },
      })
      touchedPeriods.add(alloc.periodId)
    }
    await recordAuditEvent(
      {
        actorId: params.actorId,
        affectedUserId: params.memberId,
        action: AuditAction.SAVINGS_LOT_CREATED,
        entityType: 'SavingsLot',
        entityId: lot.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: {
          savingsId: alloc.targetId,
          paymentId: params.paymentId,
          principal: alloc.amount.toString(),
          valueDate: toIsoDate(valueDate),
          savingsPeriodId: alloc.periodId,
        },
      },
      tx,
    )
  }

  const today = lagosToday()
  for (const periodId of touchedPeriods) {
    await recalculateSavingsPeriodForfeiture(tx, periodId, today, params.actorId)
    await refreshSavingsPeriodStatus(tx, periodId, today)
  }
}

/** Refreshes period statuses targeted by a submission (e.g. after confirmation or rejection). */
export async function refreshSavingsSubmissionTargets(tx: Tx, submissionId: string, actorId: string | null) {
  const targets = await tx.submissionTarget.findMany({
    where: { submissionId, targetType: AllocationTargetType.SAVINGS },
  })
  const today = lagosToday()
  for (const t of targets) {
    if (!t.targetPeriodId) continue
    await recalculateSavingsPeriodForfeiture(tx, t.targetPeriodId, today, actorId)
    await refreshSavingsPeriodStatus(tx, t.targetPeriodId, today)
  }
}

/** Rejection hook: the review shield is lifted, so forfeiture is caught up (A-11). */
export async function onSavingsSubmissionRejected(submissionId: string, actorId: string, db: Db = prisma) {
  const submission = await db.paymentSubmission.findUnique({
    where: { id: submissionId },
    select: { memberId: true },
  })
  if (!submission) return
  await db.$transaction(async (tx) => {
    await lockMembers(tx, [submission.memberId])
    await refreshSavingsSubmissionTargets(tx, submissionId, actorId)
  })
}

/**
 * Reversal hook (minimal; the full cascade is P3-09): voids the payment's savings lots,
 * reverses their accrued interest and recomputes balances and periods. Reversing a plan's
 * first deposit is refused until P3-09 implements the manual-correction path (§2.10 step 4).
 */
export async function onSavingsAllocationsReversed(
  tx: Tx,
  params: { paymentId: string; memberId: string; actorId: string; reason: string },
) {
  const lots = await tx.savingsLot.findMany({
    where: { allocation: { paymentId: params.paymentId }, voidedAt: null },
  })
  for (const lot of lots) {
    const firstLot = await tx.savingsLot.findFirst({
      where: { savingsId: lot.savingsId },
      orderBy: [{ valueDate: 'asc' }, { createdAt: 'asc' }],
    })
    if (firstLot?.id === lot.id) {
      throw new AppError(
        'SAVINGS_FIRST_DEPOSIT_REVERSAL',
        'Reversing the first deposit of a savings plan needs a manual correction by the owner.',
        { statusCode: 409 },
      )
    }
  }
  const today = lagosToday()
  const periods = new Set<string>()
  for (const lot of lots) {
    await reverseLotAccruals(tx, lot.id, 'PAYMENT_REVERSED', params.actorId)
    await tx.savingsLot.update({
      where: { id: lot.id },
      data: {
        voidedAt: new Date(),
        interestBearing: false,
        forfeitedAt: new Date(),
        forfeitReason: LotForfeitReason.VOIDED,
      },
    })
    await tx.savings.update({
      where: { id: lot.savingsId },
      data: { currentBalance: { decrement: lot.principal } },
    })
    if (lot.savingsPeriodId) {
      await tx.savingsPeriod.update({
        where: { id: lot.savingsPeriodId },
        data: { amountPaid: { decrement: lot.principal } },
      })
      periods.add(lot.savingsPeriodId)
    }
    await recordAuditEvent(
      {
        actorId: params.actorId,
        affectedUserId: params.memberId,
        action: AuditAction.SAVINGS_LOT_VOIDED,
        entityType: 'SavingsLot',
        entityId: lot.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: { paymentId: params.paymentId, reason: params.reason },
      },
      tx,
    )
  }
  for (const periodId of periods) {
    await recalculateSavingsPeriodForfeiture(tx, periodId, today, params.actorId)
    await refreshSavingsPeriodStatus(tx, periodId, today)
  }
}

// ============================================================================
// Activation and schedule (§2.6)
// ============================================================================

export function generateRegularSavingsDueDates(
  frequency: SavingsFrequency,
  startDate: Date | string,
  durationMonths: number,
): Date[] {
  switch (frequency) {
    case SavingsFrequency.DAILY:
      return generateDailySavingsDueDates(startDate, durationMonths)
    case SavingsFrequency.WEEKLY:
      return generateWeeklySavingsDueDates(startDate, durationMonths)
    case SavingsFrequency.MONTHLY:
      return generateMonthlySavingsDueDates(startDate, durationMonths)
    default:
      throw new AppError('INVALID_FREQUENCY', 'Regular savings need a daily, weekly or monthly frequency.')
  }
}

/** PENDING → ACTIVE on the first confirmed deposit (conditional transition, idempotent schedule). */
async function activateSavingsPlan(tx: Tx, savingsId: string, valueDate: Date, actorId: string) {
  const plan = await tx.savings.findUniqueOrThrow({ where: { id: savingsId } })
  const startDate = dateOnly(valueDate)
  const maturityDate = savingsMaturityDate(startDate, plan.durationMonths)

  await transition(
    tx.savings,
    plan.id,
    SavingsStatus.PENDING,
    { status: SavingsStatus.ACTIVE, startDate, maturityDate },
    'This savings plan was already activated.',
  )

  if (plan.savingsType === SavingsType.REGULAR) {
    const existing = await tx.savingsPeriod.count({ where: { savingsId: plan.id } })
    if (existing === 0) {
      const dueDates = generateRegularSavingsDueDates(plan.frequency, startDate, plan.durationMonths)
      const amountDue = roundMoney(plan.targetAmount ?? 0)
      await tx.savingsPeriod.createMany({
        data: dueDates.map((dueDate, idx) => ({
          savingsId: plan.id,
          periodNumber: idx + 1,
          dueDate,
          amountDue,
        })),
        skipDuplicates: true,
      })
    }
  }

  await recordAuditEvent(
    {
      actorId,
      affectedUserId: plan.userId,
      action: AuditAction.SAVINGS_PLAN_ACTIVATED,
      entityType: 'Savings',
      entityId: plan.id,
      outcome: AuditOutcome.SUCCESS,
      beforeState: { status: SavingsStatus.PENDING },
      afterState: {
        status: SavingsStatus.ACTIVE,
        startDate: toIsoDate(startDate),
        maturityDate: toIsoDate(maturityDate),
      },
    },
    tx,
  )
  return tx.savings.findUniqueOrThrow({ where: { id: plan.id } })
}

// ============================================================================
// Period status and forfeiture (§1.3, §2.5, §2.10)
// ============================================================================

/**
 * Derives a period's status from its allocations, open submissions and the Lagos date:
 * COMPLETED > IN_REVIEW > OVERDUE > REJECTED > ONGOING > PENDING. WAIVED is never touched.
 */
export async function refreshSavingsPeriodStatus(tx: Tx, periodId: string, today: string = lagosToday()) {
  const period = await tx.savingsPeriod.findUnique({ where: { id: periodId } })
  if (!period || period.status === PaymentPeriodStatus.WAIVED) return period

  const due = toDecimal(period.amountDue)
  const paid = toDecimal(period.amountPaid)
  let status: PaymentPeriodStatus
  if (paid.gte(due)) {
    status = PaymentPeriodStatus.COMPLETED
  } else {
    const latestSubmission = await tx.submissionTarget.findFirst({
      where: { targetPeriodId: periodId, targetType: AllocationTargetType.SAVINGS },
      orderBy: { submission: { submittedAt: 'desc' } },
      select: { submission: { select: { status: true } } },
    })
    const inReview = await tx.submissionTarget.count({
      where: {
        targetPeriodId: periodId,
        targetType: AllocationTargetType.SAVINGS,
        submission: { status: PaymentSubmissionStatus.SUBMITTED },
      },
    })
    if (inReview > 0) status = PaymentPeriodStatus.IN_REVIEW
    else if (isBefore(period.dueDate, today)) status = PaymentPeriodStatus.OVERDUE
    else if (latestSubmission?.submission.status === PaymentSubmissionStatus.REJECTED)
      status = PaymentPeriodStatus.REJECTED
    else if (paid.gt(0)) status = PaymentPeriodStatus.ONGOING
    else status = PaymentPeriodStatus.PENDING
  }
  if (status !== period.status) {
    return tx.savingsPeriod.update({ where: { id: periodId }, data: { status } })
  }
  return period
}

/**
 * Recomputes a regular-savings period's forfeiture from value dates and the review shield,
 * and makes its lots' `interestBearing` flags agree. Forfeiting reverses the lots' accrued
 * interest; clearing a forfeiture (value-date correction) restores the lots, and the next
 * accrual run catches their interest up. Idempotent.
 */
// ASSUMPTION A-07 (per-period forfeiture at day +8) and A-11 (review shield).
export async function recalculateSavingsPeriodForfeiture(
  tx: Tx,
  periodId: string,
  asOf: string = lagosToday(),
  actorId: string | null = null,
): Promise<PeriodForfeitureState | null> {
  const period = await tx.savingsPeriod.findUnique({
    where: { id: periodId },
    include: { savings: { select: { id: true, userId: true, status: true } } },
  })
  if (!period) return null
  if (period.status === PaymentPeriodStatus.WAIVED) return null
  // Closed plans keep their final state; early withdrawal handles its own forfeiture.
  if (!OPEN_PLAN_STATUSES.includes(period.savings.status)) return null

  const allocations = await tx.paymentAllocation.findMany({
    where: {
      periodId,
      targetType: AllocationTargetType.SAVINGS,
      status: AllocationStatus.ACTIVE,
    },
    select: { amount: true, payment: { select: { valueDate: true } } },
  })
  const pending = await tx.submissionTarget.findMany({
    where: {
      targetPeriodId: periodId,
      targetType: AllocationTargetType.SAVINGS,
      submission: { status: PaymentSubmissionStatus.SUBMITTED },
    },
    select: { submission: { select: { paidOn: true } } },
  })

  // The evaluation day is never earlier than a known payment value date (a value date is
  // never after the day it is confirmed, so this only matters for back-dated runs).
  let evalDate = asOf
  for (const a of allocations) {
    if (isBefore(evalDate, a.payment.valueDate)) evalDate = toIsoDate(a.payment.valueDate)
  }
  const state = evaluatePeriodForfeiture({
    dueDate: period.dueDate,
    amountDue: period.amountDue,
    allocations: allocations.map((a) => ({ amount: a.amount, valueDate: a.payment.valueDate })),
    pendingSubmissionPaidOn: pending.map((p) => p.submission.paidOn),
    asOf: evalDate,
  })
  const forfeited = state === 'FORFEITED'
  const lots = await tx.savingsLot.findMany({ where: { savingsPeriodId: periodId, voidedAt: null } })

  if (forfeited) {
    for (const lot of lots.filter((l) => l.interestBearing)) {
      await reverseLotAccruals(tx, lot.id, 'PERIOD_INTEREST_FORFEITED', actorId)
      await tx.savingsLot.update({
        where: { id: lot.id },
        data: { interestBearing: false, forfeitedAt: new Date(), forfeitReason: LotForfeitReason.PERIOD_LATE },
      })
    }
  } else {
    for (const lot of lots.filter((l) => !l.interestBearing && l.forfeitReason === LotForfeitReason.PERIOD_LATE)) {
      await tx.savingsLot.update({
        where: { id: lot.id },
        data: { interestBearing: true, forfeitedAt: null, forfeitReason: null },
      })
    }
  }

  if (forfeited !== period.interestForfeited) {
    await tx.savingsPeriod.update({ where: { id: periodId }, data: { interestForfeited: forfeited } })
    await recordAuditEvent(
      {
        actorId,
        affectedUserId: period.savings.userId,
        action: forfeited
          ? AuditAction.SAVINGS_PERIOD_INTEREST_FORFEITED
          : AuditAction.SAVINGS_PERIOD_INTEREST_RESTORED,
        entityType: 'SavingsPeriod',
        entityId: periodId,
        outcome: AuditOutcome.SUCCESS,
        metadata: {
          savingsId: period.savingsId,
          periodNumber: period.periodNumber,
          dueDate: toIsoDate(period.dueDate),
          evaluatedOn: evalDate,
          state,
        },
      },
      tx,
    )
  }
  return state
}

// ============================================================================
// Interest accrual (§2.5, §2.12)
// ============================================================================

/** Reverses every active accrual of a lot (journal reversal + `reversedAt`). Idempotent. */
async function reverseLotAccruals(tx: Tx, lotId: string, reason: string, actorId: string | null) {
  const accruals = await tx.savingsInterestAccrual.findMany({
    where: { lotId, reversedAt: null },
    orderBy: { accrualDate: 'desc' },
  })
  for (const a of accruals) {
    if (a.journalEntryId) {
      await reverseJournalEntry(tx, {
        originalJournalEntryId: a.journalEntryId,
        idempotencyKey: `savings-accrual-reversal:${a.id}`,
        reason,
        postedById: actorId,
        effectiveDate: parseDateOnly(lagosToday()),
      })
    }
    await tx.savingsInterestAccrual.update({
      where: { id: a.id },
      data: { reversedAt: new Date(), reversalReason: reason },
    })
  }
  return accruals.length
}

/**
 * Posts the monthly linear accrual for every interest-bearing lot of a plan, for every
 * accrual date (month ends and maturity) up to `asOf` that has no row yet. Catch-up safe and
 * idempotent: unique (lotId, accrualDate) plus a journal idempotency key per lot and date.
 * The caller holds the member lock.
 */
// ASSUMPTION A-07: linear accrual per lot, posted monthly (month ends + maturity).
export async function accrueSavingsPlanInterest(
  tx: Tx,
  savingsId: string,
  asOf: string = lagosToday(),
  actorId: string | null = null,
): Promise<{ postings: number; amount: Prisma.Decimal }> {
  const plan = await tx.savings.findUnique({ where: { id: savingsId } })
  let postings = 0
  let amount = new Prisma.Decimal(0)
  if (!plan || !plan.startDate || !plan.maturityDate) return { postings, amount }
  if (!OPEN_PLAN_STATUSES.includes(plan.status)) return { postings, amount }

  const lots = await tx.savingsLot.findMany({
    where: { savingsId, voidedAt: null, interestBearing: true },
    include: { accruals: true },
  })

  for (const lot of lots) {
    const dates = accrualDatesForLot({
      lotValueDate: lot.valueDate,
      maturityDate: plan.maturityDate,
      asOf,
    })
    const rows = [...lot.accruals]
    for (const d of dates) {
      const iso = toIsoDate(d)
      if (rows.some((r) => toIsoDate(r.accrualDate) === iso)) continue
      const previous = sumDecimals(
        rows.filter((r) => !r.reversedAt && isBefore(r.accrualDate, d)).map((r) => r.amount),
      )
      const posting = monthlyPosting({
        principal: lot.principal,
        ratePercent: plan.ratePercentSnapshot,
        lotValueDate: lot.valueDate,
        planStartDate: plan.startDate,
        maturityDate: plan.maturityDate,
        asOf: d,
        previousPostings: previous,
      })
      if (posting.lte(0)) continue
      const entry = await postSavingsInterestAccrual(tx, {
        amount: posting,
        memberId: plan.userId,
        savingsId: plan.id,
        effectiveDate: d,
        idempotencyKey: `savings-accrual:${lot.id}:${iso}`,
        postedById: actorId,
        description: `Savings interest accrual ${iso} for lot ${lot.id}`,
      })
      const row = await tx.savingsInterestAccrual.create({
        data: { lotId: lot.id, accrualDate: d, amount: posting, journalEntryId: entry.id },
      })
      rows.push(row)
      postings += 1
      amount = amount.plus(posting)
    }

    // True-up after maturity: if an accrual date's row was reversed (forfeiture later cleared),
    // that date is never re-posted, so the shortfall is posted on `asOf` (see OQ-12).
    if (isSameOrBefore(plan.maturityDate, asOf) && isBefore(lot.valueDate, plan.maturityDate)) {
      const target = roundMoney(
        lotInterest({
          principal: lot.principal,
          ratePercent: plan.ratePercentSnapshot,
          lotValueDate: lot.valueDate,
          planStartDate: plan.startDate,
          maturityDate: plan.maturityDate,
        }),
      )
      const active = sumDecimals(rows.filter((r) => !r.reversedAt).map((r) => r.amount))
      const shortfall = target.minus(active)
      const asOfDate = parseDateOnly(asOf)
      if (shortfall.gt(0) && !rows.some((r) => toIsoDate(r.accrualDate) === asOf)) {
        const entry = await postSavingsInterestAccrual(tx, {
          amount: shortfall,
          memberId: plan.userId,
          savingsId: plan.id,
          effectiveDate: asOfDate,
          idempotencyKey: `savings-accrual:${lot.id}:${asOf}`,
          postedById: actorId,
          description: `Savings interest catch-up ${asOf} for lot ${lot.id}`,
        })
        rows.push(
          await tx.savingsInterestAccrual.create({
            data: { lotId: lot.id, accrualDate: asOfDate, amount: shortfall, journalEntryId: entry.id },
          }),
        )
        postings += 1
        amount = amount.plus(shortfall)
      }
    }
  }

  if (postings > 0) {
    await recordAuditEvent(
      {
        actorId,
        affectedUserId: plan.userId,
        action: AuditAction.SAVINGS_INTEREST_ACCRUED,
        entityType: 'Savings',
        entityId: plan.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: { asOf, postings, amount: amount.toString() },
      },
      tx,
    )
  }
  return { postings, amount }
}

/** Sum of a plan's active (non-reversed) accrual postings = SAVINGS_INTEREST_PAYABLE for it. */
export async function getAccruedInterest(tx: Tx | Db, savingsId: string): Promise<Prisma.Decimal> {
  const agg = await tx.savingsInterestAccrual.aggregate({
    where: { reversedAt: null, lot: { savingsId, voidedAt: null } },
    _sum: { amount: true },
  })
  return roundMoney(agg._sum.amount ?? 0)
}

// ============================================================================
// Expiry and maturity
// ============================================================================

/** PENDING plans with no receipt in review after the window are cancelled. */
// ASSUMPTION A-05: window = savingsFirstDepositWindowDays (default 14); a receipt in review blocks expiry.
export async function expirePendingSavingsPlan(
  tx: Tx,
  savingsId: string,
  params: { asOf: string; windowDays: number },
): Promise<SavingsNotice | null> {
  const plan = await tx.savings.findUnique({ where: { id: savingsId } })
  if (!plan || plan.status !== SavingsStatus.PENDING) return null
  const createdOn = toLagosDateString(plan.createdAt)
  if (diffDays(createdOn, params.asOf) <= params.windowDays) return null

  const inReview = await tx.submissionTarget.count({
    where: {
      targetType: AllocationTargetType.SAVINGS,
      targetId: plan.id,
      submission: { status: PaymentSubmissionStatus.SUBMITTED },
    },
  })
  if (inReview > 0) return null

  await transition(tx.savings, plan.id, SavingsStatus.PENDING, {
    status: SavingsStatus.CANCELLED,
    cancelledAt: new Date(),
    cancellationReason: `No first deposit submitted within ${params.windowDays} days`,
  })
  await recordAuditEvent(
    {
      actorId: null,
      affectedUserId: plan.userId,
      action: AuditAction.SAVINGS_PLAN_EXPIRED,
      entityType: 'Savings',
      entityId: plan.id,
      outcome: AuditOutcome.SUCCESS,
      beforeState: { status: SavingsStatus.PENDING },
      afterState: { status: SavingsStatus.CANCELLED },
      metadata: { createdOn, asOf: params.asOf, windowDays: params.windowDays },
    },
    tx,
  )
  return {
    memberId: plan.userId,
    subject: 'Your savings plan was cancelled',
    message: `Your savings plan was cancelled because no first deposit was submitted within ${params.windowDays} days. You can subscribe again at any time; a new plan uses the current rate.`,
  }
}

/** ACTIVE → MATURED on/after the maturity date; accrual is completed up to maturity first. */
// ASSUMPTION A-08: no rollover and no automatic payout; the plan stays MATURED until a withdrawal.
export async function matureSavingsPlan(
  tx: Tx,
  savingsId: string,
  asOf: string,
  actorId: string | null = null,
): Promise<SavingsNotice | null> {
  const plan = await tx.savings.findUnique({ where: { id: savingsId } })
  if (!plan || plan.status !== SavingsStatus.ACTIVE || !plan.maturityDate) return null
  if (!isSameOrBefore(plan.maturityDate, asOf)) return null

  await accrueSavingsPlanInterest(tx, plan.id, toIsoDate(plan.maturityDate), actorId)
  await transition(tx.savings, plan.id, SavingsStatus.ACTIVE, {
    status: SavingsStatus.MATURED,
    maturedAt: new Date(),
  })
  const interest = await getAccruedInterest(tx, plan.id)
  await recordAuditEvent(
    {
      actorId,
      affectedUserId: plan.userId,
      action: AuditAction.SAVINGS_PLAN_MATURED,
      entityType: 'Savings',
      entityId: plan.id,
      outcome: AuditOutcome.SUCCESS,
      beforeState: { status: SavingsStatus.ACTIVE },
      afterState: { status: SavingsStatus.MATURED },
      metadata: { maturityDate: toIsoDate(plan.maturityDate), principal: plan.currentBalance.toString(), interest: interest.toString() },
    },
    tx,
  )
  return {
    memberId: plan.userId,
    subject: 'Your savings plan has matured',
    message: `Your savings plan matured on ${toIsoDate(plan.maturityDate)}. Principal ₦${plan.currentBalance.toFixed(2)} and interest ₦${interest.toFixed(2)} are ready; request a withdrawal when you want to be paid. There is no automatic rollover.`,
  }
}

// ============================================================================
// Withdrawal (§1.3, §2.1, §2.5, §2.12)
// ============================================================================

async function resolvePayoutBankAccount(tx: Tx, memberId: string) {
  return tx.bankAccount.findFirst({
    where: { userId: memberId },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  })
}

/**
 * Member requests a withdrawal. Refused while the principal is locked by an own loan or
 * reserved for a guarantee (§2.1, D-02). Freezes the principal (WITHDRAWAL_PENDING) and
 * creates a Disbursement request; the plan becomes WITHDRAWN only when the payout is confirmed.
 */
export async function requestSavingsWithdrawal(
  params: { memberId: string; savingsId: string; asOf?: string },
  db: Db = prisma,
) {
  const asOf = params.asOf ?? lagosToday()
  return withSequenceRetry(() => db.$transaction(async (tx) => {
    await lockMembers(tx, [params.memberId])
    let plan = await tx.savings.findFirst({ where: { id: params.savingsId, userId: params.memberId } })
    if (!plan) throw new AppError('NOT_FOUND', 'Savings plan not found.', { statusCode: 404 })

    if (plan.status === SavingsStatus.WITHDRAWAL_PENDING) {
      throw new AppError('WITHDRAWAL_ALREADY_PENDING', 'A withdrawal for this plan is already being processed.', {
        statusCode: 409,
      })
    }
    if (!OPEN_PLAN_STATUSES.includes(plan.status)) {
      throw new AppError('INVALID_STATE', 'Only an active or matured plan can be withdrawn.', { statusCode: 409 })
    }
    // The maturity job may not have run yet today.
    if (plan.status === SavingsStatus.ACTIVE && plan.maturityDate && isSameOrBefore(plan.maturityDate, asOf)) {
      await matureSavingsPlan(tx, plan.id, asOf, params.memberId)
      plan = await tx.savings.findUniqueOrThrow({ where: { id: plan.id } })
    }

    const kind =
      plan.status === SavingsStatus.MATURED ? SavingsWithdrawalKind.MATURITY : SavingsWithdrawalKind.EARLY
    const principal = roundMoney(plan.currentBalance)
    if (kind === SavingsWithdrawalKind.MATURITY) {
      await accrueSavingsPlanInterest(tx, plan.id, asOf, params.memberId)
    }
    // Early withdrawal forfeits all accrued interest (reversed when the payout is confirmed).
    const interest =
      kind === SavingsWithdrawalKind.MATURITY ? await getAccruedInterest(tx, plan.id) : new Prisma.Decimal(0)
    const total = principal.plus(interest)
    if (total.lte(0)) {
      throw new AppError('NOTHING_TO_WITHDRAW', 'This plan has no confirmed principal to withdraw.', {
        statusCode: 422,
      })
    }

    // ASSUMPTION A-04: FULL own-savings lien — any approved/active own loan blocks withdrawal,
    // including the maturity payout; guarantee reservations block the reserved part.
    await assertSavingsWithdrawalAllowed(tx, { memberId: params.memberId, withdrawalAmount: principal })

    const bank = await resolvePayoutBankAccount(tx, params.memberId)
    if (!bank) {
      throw new AppError('BANK_ACCOUNT_REQUIRED', 'Add a bank account before requesting a withdrawal.', {
        statusCode: 422,
      })
    }

    const lastDisbursement = await tx.disbursement.findFirst({
      orderBy: { disbursementNumber: 'desc' },
      select: { disbursementNumber: true },
    })
    const disbursement = await tx.disbursement.create({
      data: {
        disbursementNumber: formatSequentialNumber('DSB', nextSequenceAfter(lastDisbursement?.disbursementNumber)),
        recipientUserId: params.memberId,
        purpose: DisbursementPurpose.SAVINGS_PAYOUT,
        amount: total,
        bankAccountId: bank.id,
        requestedById: params.memberId,
        status: DisbursementStatus.REQUESTED,
        valueDate: parseDateOnly(asOf),
        idempotencyKey: `savings-withdrawal:${plan.id}:${randomUUID()}`,
      },
    })

    await transition(tx.savings, plan.id, plan.status, {
      status: SavingsStatus.WITHDRAWAL_PENDING,
      withdrawalKind: kind,
      withdrawalRequestedAt: new Date(),
      withdrawalPrincipal: principal,
      withdrawalInterest: interest,
      withdrawalDisbursementId: disbursement.id,
    })

    await recordAuditEvent(
      {
        actorId: params.memberId,
        affectedUserId: params.memberId,
        action: AuditAction.SAVINGS_WITHDRAWAL_REQUESTED,
        entityType: 'Savings',
        entityId: plan.id,
        outcome: AuditOutcome.SUCCESS,
        beforeState: { status: plan.status },
        afterState: { status: SavingsStatus.WITHDRAWAL_PENDING },
        metadata: {
          kind,
          principal: principal.toString(),
          interest: interest.toString(),
          disbursementId: disbursement.id,
        },
      },
      tx,
    )
    return { savingsId: plan.id, disbursement, kind, principal, interest }
  }))
}

async function loadPendingWithdrawal(tx: Tx, savingsId: string) {
  const plan = await tx.savings.findUnique({
    where: { id: savingsId },
    include: { withdrawalDisbursement: true },
  })
  if (!plan) throw new AppError('NOT_FOUND', 'Savings plan not found.', { statusCode: 404 })
  if (plan.status !== SavingsStatus.WITHDRAWAL_PENDING || !plan.withdrawalDisbursement) {
    throw new AppError('STALE_STATE', 'This plan has no withdrawal awaiting action.', { statusCode: 409 })
  }
  return plan as typeof plan & { withdrawalDisbursement: NonNullable<typeof plan.withdrawalDisbursement> }
}

/** Staff approves the withdrawal payout (REQUESTED → APPROVED). */
export async function approveSavingsWithdrawal(params: { savingsId: string; staff: StaffActor }, db: Db = prisma) {
  return db.$transaction(async (tx) => {
    const preview = await tx.savings.findUnique({ where: { id: params.savingsId }, select: { userId: true } })
    if (!preview) throw new AppError('NOT_FOUND', 'Savings plan not found.', { statusCode: 404 })
    await lockMembers(tx, [preview.userId])
    const plan = await loadPendingWithdrawal(tx, params.savingsId)
    await transition(tx.disbursement, plan.withdrawalDisbursement.id, DisbursementStatus.REQUESTED, {
      status: DisbursementStatus.APPROVED,
      approvedById: params.staff.id,
    })
    await recordAuditEvent(
      {
        actorId: params.staff.id,
        actorRole: params.staff.role,
        affectedUserId: plan.userId,
        action: AuditAction.SAVINGS_WITHDRAWAL_APPROVED,
        entityType: 'Savings',
        entityId: plan.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: { disbursementId: plan.withdrawalDisbursement.id },
      },
      tx,
    )
    return { savingsId: plan.id, disbursementId: plan.withdrawalDisbursement.id }
  })
}

export interface ConfirmSavingsPayoutInput {
  savingsId: string
  staff: StaffActor
  valueDate: string
  bankReference: string
  evidenceFileId: string
}

/**
 * Staff confirms the payout with evidence, value date and bank reference
 * (APPROVED → PAID; WITHDRAWAL_PENDING → WITHDRAWN) and posts the ledger entry:
 * maturity: Dr principal + interest payable / Cr cash; early: Dr principal / Cr cash, and the
 * accrued interest is reversed (Dr interest payable / Cr interest expense) lot by lot.
 */
export async function confirmSavingsWithdrawalPayout(input: ConfirmSavingsPayoutInput, db: Db = prisma) {
  const bankReference = input.bankReference?.trim()
  if (!bankReference) {
    throw new AppError('BANK_REFERENCE_REQUIRED', 'Enter the bank transfer reference.', { statusCode: 400 })
  }
  const valueDate = parseDateOnly(input.valueDate)
  if (isBefore(lagosToday(), valueDate)) {
    throw new AppError('FUTURE_DATE_NOT_ALLOWED', 'The payout date cannot be in the future.', { statusCode: 400 })
  }

  return db.$transaction(async (tx) => {
    const preview = await tx.savings.findUnique({ where: { id: input.savingsId }, select: { userId: true } })
    if (!preview) throw new AppError('NOT_FOUND', 'Savings plan not found.', { statusCode: 404 })
    await lockMembers(tx, [preview.userId])
    const plan = await loadPendingWithdrawal(tx, input.savingsId)
    const disbursement = plan.withdrawalDisbursement
    if (disbursement.status !== DisbursementStatus.APPROVED) {
      throw new AppError('STALE_STATE', 'The withdrawal must be approved before the payout is confirmed.', {
        statusCode: 409,
      })
    }
    if (plan.withdrawalRequestedAt && isBefore(valueDate, toLagosDateString(plan.withdrawalRequestedAt))) {
      throw new AppError('INVALID_DATE', 'The payout date cannot be before the withdrawal request.', {
        statusCode: 400,
      })
    }

    // ASSUMPTION A-19: approver ≠ payer when two eligible staff exist; else OWNER, flagged SINGLE_OPERATOR.
    const dual = await enforceDualControl(
      {
        actor: input.staff,
        previousActorId: disbursement.approvedById,
        requiredPermission: AdminPermission.SAVINGS_MANAGE,
      },
      asDb(tx),
    )

    const evidence = await tx.storedFile.findUnique({ where: { id: input.evidenceFileId } })
    if (!evidence) {
      throw new AppError('EVIDENCE_REQUIRED', 'Upload the payout evidence.', { statusCode: 400 })
    }

    // Amounts must still match what the member asked for (no silent change).
    const principal = roundMoney(plan.currentBalance)
    const interest =
      plan.withdrawalKind === SavingsWithdrawalKind.MATURITY
        ? await getAccruedInterest(tx, plan.id)
        : new Prisma.Decimal(0)
    if (!principal.plus(interest).equals(roundMoney(disbursement.amount))) {
      throw new AppError(
        'STALE_STATE',
        'The plan balance changed since the withdrawal was requested. Cancel this withdrawal and ask the member to request it again.',
        { statusCode: 409 },
      )
    }

    // Approved bank-detail change (P3-02B): pay the member's current primary account.
    const currentBank = await resolvePayoutBankAccount(tx, plan.userId)
    const bankAccountId = currentBank?.id ?? disbursement.bankAccountId

    let journalEntryId: string
    if (plan.withdrawalKind === SavingsWithdrawalKind.MATURITY) {
      const entry = await postSavingsMaturityPayout(tx, {
        principal,
        interest,
        memberId: plan.userId,
        savingsId: plan.id,
        effectiveDate: valueDate,
        idempotencyKey: `disbursement:${disbursement.id}`,
        postedById: input.staff.id,
      })
      journalEntryId = entry.id
    } else {
      const lots = await tx.savingsLot.findMany({ where: { savingsId: plan.id, voidedAt: null } })
      for (const lot of lots) {
        await reverseLotAccruals(tx, lot.id, 'EARLY_WITHDRAWAL', input.staff.id)
        if (lot.interestBearing) {
          await tx.savingsLot.update({
            where: { id: lot.id },
            data: {
              interestBearing: false,
              forfeitedAt: new Date(),
              forfeitReason: LotForfeitReason.EARLY_WITHDRAWAL,
            },
          })
        }
      }
      const entry = await postJournalEntry(tx, {
        sourceType: 'SAVINGS_EARLY_WITHDRAWAL',
        sourceId: plan.id,
        idempotencyKey: `disbursement:${disbursement.id}`,
        description: `Early savings withdrawal ${disbursement.disbursementNumber}`,
        effectiveDate: valueDate,
        postedById: input.staff.id,
        lines: [
          {
            accountType: LedgerAccountType.SAVINGS_PRINCIPAL_LIABILITY,
            debit: principal,
            credit: 0,
            memberId: plan.userId,
            accountRefType: 'SAVINGS',
            accountRefId: plan.id,
          },
          { accountType: LedgerAccountType.COOPERATIVE_CASH, debit: 0, credit: principal },
        ],
      })
      journalEntryId = entry.id
    }

    await transition(tx.disbursement, disbursement.id, DisbursementStatus.APPROVED, {
      status: DisbursementStatus.PAID,
      disbursedById: input.staff.id,
      disbursedAt: new Date(),
      bankReference,
      valueDate,
      bankAccountId,
      journalEntryId,
    })
    await transition(tx.savings, plan.id, SavingsStatus.WITHDRAWAL_PENDING, {
      status: SavingsStatus.WITHDRAWN,
      withdrawnAt: new Date(),
      currentBalance: 0,
    })
    await tx.storedFile.update({
      where: { id: evidence.id },
      data: { ownerUserId: plan.userId, associatedType: 'Disbursement', associatedId: disbursement.id },
    })

    await recordAuditEvent(
      {
        actorId: input.staff.id,
        actorRole: input.staff.role,
        affectedUserId: plan.userId,
        action: AuditAction.SAVINGS_WITHDRAWAL_PAID,
        entityType: 'Savings',
        entityId: plan.id,
        outcome: AuditOutcome.SUCCESS,
        isSingleOperator: dual.singleOperator,
        beforeState: { status: SavingsStatus.WITHDRAWAL_PENDING },
        afterState: { status: SavingsStatus.WITHDRAWN },
        metadata: {
          kind: plan.withdrawalKind,
          disbursementId: disbursement.id,
          principal: principal.toString(),
          interest: interest.toString(),
          valueDate: toIsoDate(valueDate),
          bankAccountChanged: bankAccountId !== disbursement.bankAccountId,
          journalEntryId,
        },
      },
      tx,
    )
    return { savingsId: plan.id, disbursementId: disbursement.id, journalEntryId }
  })
}

/**
 * Member cancels, or staff rejects, a pending withdrawal: the disbursement is cancelled and the
 * plan returns to ACTIVE (before maturity) or MATURED (on/after maturity). Accrual resumes.
 */
export async function cancelSavingsWithdrawal(
  params: { savingsId: string; actorId: string; actorRole?: StaffActor['role'] | 'USER'; memberId?: string; reason: string },
  db: Db = prisma,
) {
  const reason = params.reason?.trim()
  if (!reason) throw new AppError('REASON_REQUIRED', 'A reason is required.', { statusCode: 400 })
  return db.$transaction(async (tx) => {
    const preview = await tx.savings.findUnique({ where: { id: params.savingsId }, select: { userId: true } })
    if (!preview || (params.memberId && preview.userId !== params.memberId)) {
      throw new AppError('NOT_FOUND', 'Savings plan not found.', { statusCode: 404 })
    }
    await lockMembers(tx, [preview.userId])
    const plan = await loadPendingWithdrawal(tx, params.savingsId)
    const allowed: DisbursementStatus[] = params.memberId
      ? [DisbursementStatus.REQUESTED] // a member may cancel only before approval
      : [DisbursementStatus.REQUESTED, DisbursementStatus.APPROVED]
    await transition(
      tx.disbursement,
      plan.withdrawalDisbursement.id,
      allowed,
      { status: DisbursementStatus.CANCELLED, rejectionReason: reason },
      'This withdrawal can no longer be cancelled.',
    )
    const today = lagosToday()
    const back =
      plan.maturityDate && isSameOrBefore(plan.maturityDate, today) ? SavingsStatus.MATURED : SavingsStatus.ACTIVE
    await transition(tx.savings, plan.id, SavingsStatus.WITHDRAWAL_PENDING, {
      status: back,
      maturedAt: back === SavingsStatus.MATURED ? (plan.maturedAt ?? new Date()) : plan.maturedAt,
      withdrawalKind: null,
      withdrawalRequestedAt: null,
      withdrawalPrincipal: null,
      withdrawalInterest: null,
      withdrawalDisbursementId: null,
    })
    await recordAuditEvent(
      {
        actorId: params.actorId,
        affectedUserId: plan.userId,
        action: AuditAction.SAVINGS_WITHDRAWAL_CANCELLED,
        entityType: 'Savings',
        entityId: plan.id,
        outcome: AuditOutcome.SUCCESS,
        beforeState: { status: SavingsStatus.WITHDRAWAL_PENDING },
        afterState: { status: back },
        metadata: { disbursementId: plan.withdrawalDisbursement.id, reason },
      },
      tx,
    )
    return { savingsId: plan.id, status: back }
  })
}

/** Days remaining before a PENDING plan expires (for display). */
export function pendingPlanExpiresOn(createdAt: Date, windowDays: number): string {
  return toIsoDate(addDays(toLagosDateString(createdAt), windowDays + 1))
}
