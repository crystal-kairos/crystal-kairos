import { Prisma } from '@/generated/prisma/client'
import {
  AllocationStatus,
  AllocationTargetType,
  EAjoMemberStatus,
  EAjoStatus,
  LedgerAccountType,
  LoanStatus,
  PaymentComponentType,
  PaymentPeriodStatus,
  PaymentSource,
  PaymentStatus,
  PaymentSubmissionStatus,
  SavingsStatus,
  SavingsType,
  WalletWithdrawalStatus,
} from '@/generated/prisma/enums'
import { prisma } from '@/lib/prisma'
import { AppError } from '@/lib/errors/app-error'
import { roundMoney } from '@/lib/domain/money'
import {
  addDays,
  formatDateOnly,
  lagosToday,
  parseDateOnly,
  toLagosDateString,
} from '@/lib/domain/dates'
import { lockMembers } from '@/lib/db/concurrency'
import { lockSequence } from '@/lib/db/sequence'
import { formatSequentialNumber, nextSequenceAfter } from '@/lib/domain/payment-reference'
import {
  recordAuditEvent,
  AuditAction,
  AuditOutcome,
} from '@/lib/services/audit.service'
import {
  AllocationPeriodItem,
  CalculatedAllocation,
  calculatePaymentAllocation,
  summarizePaymentBreakdown,
  WalletPriorityMode,
} from '@/lib/services/allocation.service'
import { postJournalEntry } from '@/lib/services/ledger.service'
import {
  applyLoanAllocation,
  getFeeOutstanding,
  getLoanAllocationPeriods,
  refreshFeeAssessment,
} from '@/lib/services/loans.service'
import {
  applySavingsPlanCapacity,
  onSavingsAllocationsConfirmed,
  prepareSavingsTargetsForConfirmation,
} from '@/lib/services/savings.service'
import {
  afterEAjoAllocationsChanged,
  getEAjoContributionCreditAccounts,
} from '@/lib/services/eajo.service'
import { recalculateLatenessInTx } from '@/lib/services/lateness.service'

export interface WalletSummary {
  memberId: string
  totalBalance: Prisma.Decimal
  heldBalance: Prisma.Decimal
  availableBalance: Prisma.Decimal
}

export interface WalletTargetInput {
  targetType: 'LOAN' | 'EAJO' | 'SAVINGS' | 'FEE'
  targetId: string
  targetPeriodId?: string | null
  allocatedAmount?: number | string | Prisma.Decimal
}

export interface ApplyWalletParams {
  memberId: string
  mode: WalletPriorityMode
  targets?: WalletTargetInput[]
  requestedAmount?: number | string | Prisma.Decimal
  amount?: number | string | Prisma.Decimal
  targetType?: 'LOAN' | 'EAJO' | 'SAVINGS' | 'FEE'
  targetId?: string
  periodId?: string | null
  asOf?: Date | string
  actorId?: string | null
  idempotencyKey?: string
}

/**
 * Calculates a member's total wallet liability balance directly from immutable journal lines (§2.12).
 * Liability balance = Total Credits (money credited to member) - Total Debits (money spent/withdrawn by member).
 */
export async function getWalletBalance(
  memberId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<Prisma.Decimal> {
  const aggregate = await tx.journalLine.aggregate({
    where: {
      memberId,
      accountType: LedgerAccountType.MEMBER_WALLET_LIABILITY,
    },
    _sum: {
      debit: true,
      credit: true,
    },
  })

  const totalCredits = aggregate._sum.credit || new Prisma.Decimal(0)
  const totalDebits = aggregate._sum.debit || new Prisma.Decimal(0)

  return roundMoney(totalCredits.minus(totalDebits))
}

/**
 * Calculates total held funds against the member's wallet (§2.11, P3-08):
 * Sum of all pending/approved wallet cash-out requests awaiting disbursement.
 */
export async function getWalletHolds(
  memberId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<Prisma.Decimal> {
  const aggregate = await tx.walletWithdrawal.aggregate({
    where: {
      memberId,
      status: {
        in: [WalletWithdrawalStatus.REQUESTED, WalletWithdrawalStatus.APPROVED],
      },
    },
    _sum: {
      amount: true,
    },
  })

  return roundMoney(aggregate._sum.amount || new Prisma.Decimal(0))
}

/**
 * Returns a comprehensive wallet summary including total, held, and available balance.
 * Available balance = Total Balance - Held Balance.
 */
export async function getWalletSummary(
  memberId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<WalletSummary> {
  const totalBalance = await getWalletBalance(memberId, tx)
  const heldBalance = await getWalletHolds(memberId, tx)
  const availableBalance = roundMoney(totalBalance.minus(heldBalance))

  return {
    memberId,
    totalBalance,
    heldBalance,
    availableBalance,
  }
}

/**
 * Asserts that a member has sufficient available wallet funds to cover an obligation.
 * Throws INSUFFICIENT_WALLET_BALANCE if the requested amount exceeds available balance.
 */
export async function assertSufficientWallet(
  memberId: string,
  requiredAmount: Prisma.Decimal | number | string,
  tx: Prisma.TransactionClient = prisma,
): Promise<WalletSummary> {
  const dAmount = roundMoney(requiredAmount)
  const summary = await getWalletSummary(memberId, tx)

  if (summary.availableBalance.lt(dAmount)) {
    throw new AppError(
      'INSUFFICIENT_WALLET_BALANCE',
      `Insufficient available wallet balance. Required: ₦${dAmount.toFixed(2)}, Available: ₦${summary.availableBalance.toFixed(2)} (Total: ₦${summary.totalBalance.toFixed(2)}, Held: ₦${summary.heldBalance.toFixed(2)}).`,
      { statusCode: 422 },
    )
  }

  return summary
}

/**
 * Requests a member-initiated wallet withdrawal, placing a hold on available wallet funds (§2.11).
 * Transaction-scoped advisory lock taken on memberId to prevent concurrent overdrafts.
 */
export async function requestWalletWithdrawal(
  tx: Prisma.TransactionClient,
  params: {
    memberId: string
    amount: Prisma.Decimal | number | string
    bankAccountId: string
    idempotencyKey: string
  },
) {
  const dAmount = roundMoney(params.amount)
  if (dAmount.lte(0)) {
    throw new AppError('VALIDATION_ERROR', 'Withdrawal amount must be greater than zero.')
  }

  // 1. Idempotency replay check
  const existing = await tx.walletWithdrawal.findUnique({
    where: { idempotencyKey: params.idempotencyKey },
    include: { bankAccount: true },
  })
  if (existing) {
    return existing
  }

  // 2. Concurrency advisory lock
  await lockMembers(tx, [params.memberId])

  // 3. Verify bank account ownership
  const bankAccount = await tx.bankAccount.findFirst({
    where: {
      id: params.bankAccountId,
      userId: params.memberId,
    },
  })
  if (!bankAccount) {
    throw new AppError('NOT_FOUND', 'Verified destination bank account not found for member.')
  }

  // 4. Assert sufficient available wallet
  await assertSufficientWallet(params.memberId, dAmount, tx)

  // 5. Generate sequential withdrawal number
  const count = await tx.walletWithdrawal.count()
  const withdrawalNumber = `WTH-${String(count + 1).padStart(6, '0')}`

  // 6. Create withdrawal hold record
  const withdrawal = await tx.walletWithdrawal.create({
    data: {
      withdrawalNumber,
      memberId: params.memberId,
      amount: dAmount,
      bankAccountId: params.bankAccountId,
      status: WalletWithdrawalStatus.REQUESTED,
      idempotencyKey: params.idempotencyKey,
    },
    include: { bankAccount: true },
  })

  await recordAuditEvent(
    {
      actorId: params.memberId,
      affectedUserId: params.memberId,
      action: AuditAction.WALLET_WITHDRAWAL_REQUESTED,
      entityType: 'WalletWithdrawal',
      entityId: withdrawal.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: {
        withdrawalNumber,
        amount: Number(dAmount),
        bankAccountId: params.bankAccountId,
        accountNumber: bankAccount.accountNumber,
      },
    },
    tx,
  ).catch(() => {})

  return withdrawal
}

/**
 * Checks whether a specific obligation or period is currently shielded by a SUBMITTED submission.
 */
async function getShieldedPeriodAndTargetIds(
  tx: Prisma.TransactionClient,
  memberId: string,
  asOfDateStr: string,
): Promise<{
  shieldedTargetKeys: Set<string>
  shieldedPeriodIds: Set<string>
}> {
  const pendingTargets = await tx.submissionTarget.findMany({
    where: {
      submission: {
        memberId,
        status: PaymentSubmissionStatus.SUBMITTED,
      },
    },
    include: {
      submission: {
        select: { paidOn: true, submittedAt: true },
      },
    },
  })

  const shieldedTargetKeys = new Set<string>()
  const shieldedPeriodIds = new Set<string>()

  for (const t of pendingTargets) {
    const paidOnStr = formatDateOnly(t.submission.paidOn)
    const subDateStr = formatDateOnly(t.submission.submittedAt)
    if (paidOnStr <= asOfDateStr || subDateStr <= asOfDateStr) {
      if (t.targetPeriodId) {
        shieldedPeriodIds.add(t.targetPeriodId)
      } else {
        shieldedTargetKeys.add(`${t.targetType}:${t.targetId}`)
      }
    }
  }

  return { shieldedTargetKeys, shieldedPeriodIds }
}

/**
 * Applies available wallet funds to member obligations inside an existing transaction (§2.11, D-12, Appendix C6).
 * - mode === 'AUTO': due-date automatic wallet application. Applies ONLY to due (dueDate <= asOf) unshielded
 *   LOAN and EAJO obligations in priority order LOAN -> EAJO (oldest dueDate first). NEVER auto-applies to SAVINGS.
 * - mode === 'MEMBER': member-initiated wallet application. Can pay selected LOAN, EAJO, SAVINGS, or FEE targets
 *   early (before due date) or across all open obligations in priority order LOAN -> EAJO -> SAVINGS.
 */
export async function applyWalletInTx(
  tx: Prisma.TransactionClient,
  params: ApplyWalletParams,
) {
  const asOfStr = params.asOf
    ? toLagosDateString(parseDateOnly(params.asOf))
    : lagosToday()
  const valueDate = parseDateOnly(asOfStr)
  const actorId = params.actorId ?? params.memberId

  // 1. Acquire member-level advisory lock first to serialize concurrent wallet usage
  await lockMembers(tx, [params.memberId])

  const effectiveRequestedAmount = params.requestedAmount ?? params.amount
  const effectiveTargets: WalletTargetInput[] | undefined =
    params.targets ??
    (params.targetType && params.targetId
      ? [
          {
            targetType: params.targetType,
            targetId: params.targetId,
            targetPeriodId: params.periodId ?? null,
            allocatedAmount: effectiveRequestedAmount,
          },
        ]
      : undefined)

  // 2. Idempotency check
  if (params.idempotencyKey) {
    const existingPayment = await tx.payment.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
      include: { allocations: true },
    })
    if (existingPayment) {
      const walletSummaryAfter = await getWalletSummary(params.memberId, tx)
      return {
        payment: existingPayment,
        appliedAmount: roundMoney(existingPayment.totalConfirmedAmount),
        allocations: existingPayment.allocations,
        breakdown: summarizePaymentBreakdown(existingPayment.allocations),
        walletSummaryAfter,
        idempotentReplay: true,
      }
    }
  }

  // 3. Check available wallet balance
  const summaryBefore = await getWalletSummary(params.memberId, tx)

  if (params.mode === 'MEMBER' && effectiveRequestedAmount !== undefined) {
    const reqDec = roundMoney(effectiveRequestedAmount)
    if (reqDec.lte(0)) {
      throw new AppError('VALIDATION_ERROR', 'Requested wallet payment amount must be greater than zero.')
    }
    if (summaryBefore.availableBalance.lt(reqDec)) {
      throw new AppError(
        'INSUFFICIENT_WALLET_BALANCE',
        `Insufficient available wallet balance. Required: ₦${reqDec.toFixed(2)}, Available: ₦${summaryBefore.availableBalance.toFixed(2)}.`,
        { statusCode: 422 },
      )
    }
  } else if (summaryBefore.availableBalance.lte(0)) {
    if (params.mode === 'AUTO') {
      return {
        payment: null,
        appliedAmount: new Prisma.Decimal(0),
        allocations: [],
        breakdown: summarizePaymentBreakdown([]),
        walletSummaryAfter: summaryBefore,
        idempotentReplay: false,
      }
    }
    throw new AppError(
      'INSUFFICIENT_WALLET_BALANCE',
      'Insufficient available wallet balance.',
      { statusCode: 422 },
    )
  }

  const maxSpendDecimal =
    effectiveRequestedAmount !== undefined
      ? Prisma.Decimal.min(
          summaryBefore.availableBalance,
          roundMoney(effectiveRequestedAmount),
        )
      : summaryBefore.availableBalance

  const periodItems: AllocationPeriodItem[] = []
  let savingsPlanCapacities: Awaited<
    ReturnType<typeof prepareSavingsTargetsForConfirmation>
  >['planCapacities'] = []

  if (params.mode === 'AUTO') {
    const { shieldedTargetKeys, shieldedPeriodIds } =
      await getShieldedPeriodAndTargetIds(tx, params.memberId, asOfStr)

    // Find active/overdue loans for member
    const loans = await tx.loan.findMany({
      where: {
        userId: params.memberId,
        status: {
          in: [LoanStatus.DISBURSED, LoanStatus.ACTIVE, LoanStatus.OVERDUE],
        },
      },
      select: { id: true },
    })

    for (const loan of loans) {
      if (shieldedTargetKeys.has(`LOAN:${loan.id}`)) continue
      // Pre-sync penalties up to addDays(asOfStr, -1) so penalties prior to valueDate are included
      await recalculateLatenessInTx(tx, {
        obligationType: 'LOAN',
        obligationId: loan.id,
        asOf: addDays(asOfStr, -1),
        actorId,
        reverseAccrualsAfterAsOf: true,
      })
      const items = await getLoanAllocationPeriods(tx, {
        memberId: params.memberId,
        loanId: loan.id,
      })
      for (const item of items) {
        const dueStr = formatDateOnly(item.dueDate)
        if (dueStr <= asOfStr && !shieldedPeriodIds.has(item.periodId)) {
          periodItems.push(item)
        }
      }
    }

    // Find active E-Ajo memberships for member
    const eajoMembers = await tx.eAjoMember.findMany({
      where: {
        userId: params.memberId,
        status: EAjoMemberStatus.ACTIVE,
        group: {
          status: EAjoStatus.ACTIVE,
        },
      },
      select: { id: true },
    })

    for (const em of eajoMembers) {
      if (shieldedTargetKeys.has(`EAJO:${em.id}`)) continue
      await recalculateLatenessInTx(tx, {
        obligationType: 'EAJO',
        obligationId: em.id,
        asOf: addDays(asOfStr, -1),
        actorId,
        reverseAccrualsAfterAsOf: true,
      })

      const periods = await tx.eAjoContributionPeriod.findMany({
        where: {
          eajoMemberId: em.id,
          status: { not: PaymentPeriodStatus.COMPLETED },
        },
        orderBy: { periodNumber: 'asc' },
      })

      for (const p of periods) {
        const dueStr = formatDateOnly(p.dueDate)
        if (dueStr > asOfStr || shieldedPeriodIds.has(p.id)) continue

        const penDue = Math.max(
          0,
          Number(p.penaltyAssessed) - Number(p.penaltyPaid) - Number(p.penaltyWaived),
        )
        const contribDue = Math.max(
          0,
          Number(p.contributionDue) - Number(p.contributionPaid),
        )
        if (penDue + contribDue > 0) {
          periodItems.push({
            periodId: p.id,
            targetType: 'EAJO',
            targetId: em.id,
            periodNumber: p.periodNumber,
            dueDate: p.dueDate,
            penaltyDue: penDue,
            interestDue: 0,
            principalDue: contribDue,
          })
        }
      }
    }
  } else {
    // mode === 'MEMBER'
    const explicitTargets = effectiveTargets ?? []

    if (explicitTargets.length > 0) {
      // Pre-sync lateness on targeted LOAN and EAJO obligations as of valueDate - 1
      const syncedLoanIds = new Set<string>()
      const syncedEAjoIds = new Set<string>()
      for (const t of explicitTargets) {
        if (t.targetType === 'LOAN' && !syncedLoanIds.has(t.targetId)) {
          syncedLoanIds.add(t.targetId)
          await recalculateLatenessInTx(tx, {
            obligationType: 'LOAN',
            obligationId: t.targetId,
            asOf: addDays(asOfStr, -1),
            actorId,
            reverseAccrualsAfterAsOf: true,
          })
        } else if (t.targetType === 'EAJO' && !syncedEAjoIds.has(t.targetId)) {
          syncedEAjoIds.add(t.targetId)
          await recalculateLatenessInTx(tx, {
            obligationType: 'EAJO',
            obligationId: t.targetId,
            asOf: addDays(asOfStr, -1),
            actorId,
            reverseAccrualsAfterAsOf: true,
          })
        }
      }

      const savingsTargets = explicitTargets
        .filter((t) => t.targetType === 'SAVINGS')
        .map((t) => ({
          targetType: AllocationTargetType.SAVINGS,
          targetId: t.targetId,
          targetPeriodId: t.targetPeriodId ?? null,
          requestedAmount: roundMoney(t.allocatedAmount ?? maxSpendDecimal),
        }))

      if (savingsTargets.length > 0) {
        const savingsPrep = await prepareSavingsTargetsForConfirmation(tx, {
          memberId: params.memberId,
          targets: savingsTargets,
          valueDate,
          actorId,
        })
        periodItems.push(...savingsPrep.periodItems)
        savingsPlanCapacities = savingsPrep.planCapacities
      }

      for (const target of explicitTargets) {
        if (target.targetType === 'LOAN') {
          const loanPeriods = await getLoanAllocationPeriods(tx, {
            memberId: params.memberId,
            loanId: target.targetId,
            instalmentId: target.targetPeriodId ?? null,
          })
          periodItems.push(...loanPeriods)
        } else if (target.targetType === 'EAJO') {
          const periods = await tx.eAjoContributionPeriod.findMany({
            where: {
              eajoMemberId: target.targetId,
              ...(target.targetPeriodId ? { id: target.targetPeriodId } : {}),
              status: { not: PaymentPeriodStatus.COMPLETED },
            },
            orderBy: { periodNumber: 'asc' },
          })
          for (const p of periods) {
            const penDue = Math.max(
              0,
              Number(p.penaltyAssessed) - Number(p.penaltyPaid) - Number(p.penaltyWaived),
            )
            const contribDue = Math.max(
              0,
              Number(p.contributionDue) - Number(p.contributionPaid),
            )
            if (penDue + contribDue > 0) {
              periodItems.push({
                periodId: p.id,
                targetType: 'EAJO',
                targetId: target.targetId,
                periodNumber: p.periodNumber,
                dueDate: p.dueDate,
                penaltyDue: penDue,
                interestDue: 0,
                principalDue: contribDue,
              })
            }
          }
        } else if (target.targetType === 'FEE') {
          const { fee, outstanding } = await getFeeOutstanding(tx, target.targetId)
          if (fee.memberId === params.memberId && outstanding.gt(0)) {
            periodItems.push({
              periodId: fee.id,
              targetType: 'FEE',
              targetId: fee.id,
              periodNumber: 1,
              dueDate: fee.assessedAt,
              penaltyDue: 0,
              interestDue: 0,
              principalDue: outstanding.toNumber(),
            })
          }
        }
      }
    } else {
      // No explicit targets: gather all open LOAN, EAJO, and REGULAR SAVINGS periods for member
      const loans = await tx.loan.findMany({
        where: {
          userId: params.memberId,
          status: {
            in: [LoanStatus.DISBURSED, LoanStatus.ACTIVE, LoanStatus.OVERDUE],
          },
        },
        select: { id: true },
      })
      for (const loan of loans) {
        await recalculateLatenessInTx(tx, {
          obligationType: 'LOAN',
          obligationId: loan.id,
          asOf: addDays(asOfStr, -1),
          actorId,
          reverseAccrualsAfterAsOf: true,
        })
        const items = await getLoanAllocationPeriods(tx, {
          memberId: params.memberId,
          loanId: loan.id,
        })
        periodItems.push(...items)
      }

      const eajoMembers = await tx.eAjoMember.findMany({
        where: {
          userId: params.memberId,
          status: EAjoMemberStatus.ACTIVE,
          group: { status: EAjoStatus.ACTIVE },
        },
        select: { id: true },
      })
      for (const em of eajoMembers) {
        await recalculateLatenessInTx(tx, {
          obligationType: 'EAJO',
          obligationId: em.id,
          asOf: addDays(asOfStr, -1),
          actorId,
          reverseAccrualsAfterAsOf: true,
        })
        const periods = await tx.eAjoContributionPeriod.findMany({
          where: {
            eajoMemberId: em.id,
            status: { not: PaymentPeriodStatus.COMPLETED },
          },
          orderBy: { periodNumber: 'asc' },
        })
        for (const p of periods) {
          const penDue = Math.max(
            0,
            Number(p.penaltyAssessed) - Number(p.penaltyPaid) - Number(p.penaltyWaived),
          )
          const contribDue = Math.max(
            0,
            Number(p.contributionDue) - Number(p.contributionPaid),
          )
          if (penDue + contribDue > 0) {
            periodItems.push({
              periodId: p.id,
              targetType: 'EAJO',
              targetId: em.id,
              periodNumber: p.periodNumber,
              dueDate: p.dueDate,
              penaltyDue: penDue,
              interestDue: 0,
              principalDue: contribDue,
            })
          }
        }
      }

      const savingsPlans = await tx.savings.findMany({
        where: {
          userId: params.memberId,
          savingsType: SavingsType.REGULAR,
          status: SavingsStatus.ACTIVE,
        },
        include: {
          periods: {
            where: { status: { not: PaymentPeriodStatus.COMPLETED } },
            orderBy: { periodNumber: 'asc' },
          },
        },
      })
      for (const sp of savingsPlans) {
        for (const p of sp.periods) {
          const due = Math.max(0, Number(p.amountDue) - Number(p.amountPaid))
          if (due > 0) {
            periodItems.push({
              periodId: p.id,
              targetType: 'SAVINGS',
              targetId: sp.id,
              periodNumber: p.periodNumber,
              dueDate: p.dueDate,
              penaltyDue: 0,
              interestDue: 0,
              principalDue: due,
            })
          }
        }
      }
    }
  }

  // Deduplicate periodItems by periodId in case caller passed overlapping targets
  const seenPeriodIds = new Set<string>()
  const uniquePeriodItems: AllocationPeriodItem[] = []
  for (const item of periodItems) {
    if (!seenPeriodIds.has(item.periodId)) {
      seenPeriodIds.add(item.periodId)
      uniquePeriodItems.push(item)
    }
  }

  // Calculate allocations in priority order
  const hasSavingsCapacityTargets = savingsPlanCapacities.length > 0
  const allocResult = calculatePaymentAllocation({
    amount: Number(maxSpendDecimal),
    memberId: params.memberId,
    periods: uniquePeriodItems,
    preserveCrossProductPriority: true,
    mode: params.mode,
    creditExcessToWallet: hasSavingsCapacityTargets,
  })

  const rawAllocations: CalculatedAllocation[] = hasSavingsCapacityTargets
    ? applySavingsPlanCapacity(allocResult.allocations, savingsPlanCapacities).allocations
    : allocResult.allocations

  // Strip out any WALLET_TOPUP allocations (since funds are already in the wallet)
  const finalAllocations = rawAllocations.filter(
    (a) =>
      a.targetType !== AllocationTargetType.WALLET &&
      a.componentType !== PaymentComponentType.WALLET_TOPUP &&
      a.amount > 0,
  )

  if (finalAllocations.length === 0) {
    const walletSummaryAfter = await getWalletSummary(params.memberId, tx)
    return {
      payment: null,
      appliedAmount: new Prisma.Decimal(0),
      allocations: [],
      breakdown: summarizePaymentBreakdown([]),
      walletSummaryAfter,
      idempotentReplay: false,
    }
  }

  const totalSpent = roundMoney(
    finalAllocations.reduce((sum, a) => sum + a.amount, 0),
  )

  // Assert sufficient available wallet for totalSpent
  await assertSufficientWallet(params.memberId, totalSpent, tx)

  // Generate sequential PAY-NNNNNN
  await lockSequence(tx, 'PAY')
  const latestPay = await tx.payment.findFirst({
    orderBy: { paymentNumber: 'desc' },
    select: { paymentNumber: true },
  })
  const nextPaySeq = nextSequenceAfter(latestPay?.paymentNumber ?? null)
  const paymentNumber = formatSequentialNumber('PAY', nextPaySeq)

  const idempotencyKey =
    params.idempotencyKey ?? `wallet-pay:${params.memberId}:${paymentNumber}:${Date.now()}`

  const payment = await tx.payment.create({
    data: {
      paymentNumber,
      source: PaymentSource.WALLET,
      memberId: params.memberId,
      totalConfirmedAmount: totalSpent,
      valueDate,
      status: PaymentStatus.CONFIRMED,
      confirmedById: actorId,
      idempotencyKey,
    },
  })

  // Determine E-Ajo credit accounts (liability before payout vs advance receivable after payout)
  const eajoTargetIds = Array.from(
    new Set(
      finalAllocations
        .filter((a) => a.targetType === AllocationTargetType.EAJO)
        .map((a) => a.targetId),
    ),
  )
  const eajoCreditAccounts = await getEAjoContributionCreditAccounts(
    tx,
    eajoTargetIds,
  )

  // Build journal lines: Debit MEMBER_WALLET_LIABILITY, Credit respective obligation accounts
  const journalLines: Array<{
    accountType: LedgerAccountType
    debit: Prisma.Decimal | number
    credit: Prisma.Decimal | number
    memberId?: string
    accountRefType?: string
    accountRefId?: string
  }> = [
    {
      accountType: LedgerAccountType.MEMBER_WALLET_LIABILITY,
      debit: totalSpent,
      credit: 0,
      memberId: params.memberId,
    },
  ]

  for (const alloc of finalAllocations) {
    let creditAccount: LedgerAccountType = LedgerAccountType.SAVINGS_PRINCIPAL_LIABILITY

    if (alloc.targetType === AllocationTargetType.SAVINGS) {
      creditAccount = LedgerAccountType.SAVINGS_PRINCIPAL_LIABILITY
    } else if (alloc.targetType === AllocationTargetType.LOAN) {
      if (alloc.componentType === PaymentComponentType.PENALTY) {
        creditAccount = LedgerAccountType.LOAN_PENALTY_RECEIVABLE
      } else if (alloc.componentType === PaymentComponentType.INTEREST) {
        creditAccount = LedgerAccountType.LOAN_INTEREST_RECEIVABLE
      } else {
        creditAccount = LedgerAccountType.LOAN_RECEIVABLE_PRINCIPAL
      }
    } else if (alloc.targetType === AllocationTargetType.EAJO) {
      if (alloc.componentType === PaymentComponentType.PENALTY) {
        creditAccount = LedgerAccountType.EAJO_PENALTY_RECEIVABLE
      } else {
        creditAccount =
          eajoCreditAccounts.get(alloc.targetId) ??
          LedgerAccountType.EAJO_CONTRIBUTION_LIABILITY
      }
    } else if (alloc.targetType === AllocationTargetType.FEE) {
      creditAccount = LedgerAccountType.FEE_INCOME
    }

    journalLines.push({
      accountType: creditAccount,
      debit: 0,
      credit: alloc.amount,
      memberId: params.memberId,
      accountRefType: alloc.targetType,
      accountRefId: alloc.targetId,
    })
  }

  const journalEntry = await postJournalEntry(tx, {
    sourceType: 'WALLET_APPLICATION',
    sourceId: payment.id,
    idempotencyKey: `wallet-je:${payment.id}`,
    description: `Wallet application ${paymentNumber} (${params.mode})`,
    effectiveDate: valueDate,
    postedById: actorId,
    lines: journalLines,
  })

  // Persist PaymentAllocation rows and update period/obligation counters
  const createdAllocations = []
  const touchedLoanIds = new Set<string>()
  const touchedFeeIds = new Set<string>()
  const touchedEAjoIds = new Set<string>()
  const touchedSavingsIds = new Set<string>()

  for (const alloc of finalAllocations) {
    const pAlloc = await tx.paymentAllocation.create({
      data: {
        paymentId: payment.id,
        targetType: alloc.targetType,
        targetId: alloc.targetId,
        periodId: alloc.periodId,
        componentType: alloc.componentType,
        amount: alloc.amount,
        status: AllocationStatus.ACTIVE,
        journalEntryId: journalEntry.id,
      },
    })
    createdAllocations.push(pAlloc)

    if (alloc.targetType === AllocationTargetType.LOAN && alloc.periodId) {
      await applyLoanAllocation(tx, alloc)
      touchedLoanIds.add(alloc.targetId)
    } else if (alloc.targetType === AllocationTargetType.FEE) {
      touchedFeeIds.add(alloc.targetId)
    } else if (alloc.targetType === AllocationTargetType.EAJO && alloc.periodId) {
      const updateData: Prisma.EAjoContributionPeriodUpdateInput = {}
      if (alloc.componentType === PaymentComponentType.PENALTY) {
        updateData.penaltyPaid = { increment: alloc.amount }
      } else if (alloc.componentType === PaymentComponentType.CONTRIBUTION) {
        updateData.contributionPaid = { increment: alloc.amount }
      }
      await tx.eAjoContributionPeriod.update({
        where: { id: alloc.periodId },
        data: updateData,
      })
      touchedEAjoIds.add(alloc.targetId)
    } else if (alloc.targetType === AllocationTargetType.SAVINGS) {
      touchedSavingsIds.add(alloc.targetId)
    }
  }

  for (const feeId of touchedFeeIds) {
    await refreshFeeAssessment(tx, feeId, actorId)
  }

  if (touchedSavingsIds.size > 0) {
    await onSavingsAllocationsConfirmed(tx, {
      paymentId: payment.id,
      memberId: params.memberId,
      valueDate,
      actorId,
    })
  }

  if (touchedEAjoIds.size > 0) {
    await afterEAjoAllocationsChanged(tx, Array.from(touchedEAjoIds), {
      actorId,
      today: asOfStr,
    })
  }

  // Run recalculateLateness on all touched obligations so penalties, forfeitures, and statuses are synced
  const recalcAsOf = params.asOf ? asOfStr : lagosToday()
  for (const loanId of touchedLoanIds) {
    await recalculateLatenessInTx(tx, {
      obligationType: 'LOAN',
      obligationId: loanId,
      asOf: recalcAsOf,
      actorId,
    })
  }
  for (const eajoId of touchedEAjoIds) {
    await recalculateLatenessInTx(tx, {
      obligationType: 'EAJO',
      obligationId: eajoId,
      asOf: recalcAsOf,
      actorId,
    })
  }
  for (const savingsId of touchedSavingsIds) {
    await recalculateLatenessInTx(tx, {
      obligationType: 'SAVINGS',
      obligationId: savingsId,
      asOf: recalcAsOf,
      actorId,
    })
  }

  await recordAuditEvent(
    {
      actorId,
      affectedUserId: params.memberId,
      action: AuditAction.WALLET_ALLOCATED,
      entityType: 'Payment',
      entityId: payment.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: {
        paymentNumber,
        mode: params.mode,
        totalSpent: Number(totalSpent),
        asOf: asOfStr,
        allocationsCount: createdAllocations.length,
      },
    },
    tx,
  )

  const walletSummaryAfter = await getWalletSummary(params.memberId, tx)

  return {
    payment,
    appliedAmount: totalSpent,
    allocations: createdAllocations,
    breakdown: summarizePaymentBreakdown(createdAllocations),
    walletSummaryAfter,
    idempotentReplay: false,
  }
}

/**
 * Standalone transactional wrapper for applyWalletInTx.
 */
export async function applyWallet(params: ApplyWalletParams) {
  return prisma.$transaction((tx) => applyWalletInTx(tx, params), {
    maxWait: 10000,
    timeout: 30000,
  })
}
