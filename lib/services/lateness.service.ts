import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import {
  AllocationStatus,
  AllocationTargetType,
  LedgerAccountType,
  LoanStatus,
  PaymentComponentType,
  PaymentStatus,
  PaymentSubmissionStatus,
  PenaltyCapType,
  SavingsType,
} from '@/generated/prisma/enums'
import {
  lagosToday,
  parseDateOnly,
  toLagosDateString,
} from '@/lib/domain/dates'
import { roundMoney, toDecimal } from '@/lib/domain/money'
import {
  evaluateRecoveryEligibility,
  planEAjoParticipantPenaltyLateness,
  planLoanPenaltyLateness,
  type ExistingEAjoAccrualSlice,
  type ExistingLoanAccrualSlice,
  type ShieldSubmissionSlice,
  type ValueDatedAllocationSlice,
} from '@/lib/domain/lateness'
import {
  postJournalEntry,
  postLoanPenalty,
  reverseJournalEntry,
} from '@/lib/services/ledger.service'
import { lockMembers } from '@/lib/db/concurrency'
import { AuditAction, recordAuditEvent } from '@/lib/services/audit.service'
import { refreshLoanAfterPayment } from '@/lib/services/loans.service'
import { refreshEAjoParticipant } from '@/lib/services/eajo.service'
import {
  recalculateSavingsPeriodForfeiture,
  refreshSavingsPeriodStatus,
} from '@/lib/services/savings.service'

export interface RecalculateLatenessParams {
  obligationType: 'LOAN' | 'EAJO' | 'SAVINGS'
  obligationId: string
  asOf?: Date | string
  actorId?: string | null
  /**
   * Optional submission IDs to ignore when computing the review shield
   * (e.g. a submission currently being confirmed or rejected).
   */
  excludeSubmissionIds?: string[]
  /**
   * When true, active accruals on dates > asOf are also reversed with VALUE_DATE_RECALC
   * (used during pre-allocation confirmation sync so accruals on >= valueDate are cleared).
   */
  reverseAccrualsAfterAsOf?: boolean
  skipStatusRefresh?: boolean
}

export interface RecalculateLatenessResult {
  obligationType: 'LOAN' | 'EAJO' | 'SAVINGS'
  obligationId: string
  asOf: string
  accrualsCreated: number
  accrualsReversed: number
  penaltiesAssessedNet: Prisma.Decimal
  forfeitedPeriodsCount: number
  savingsForfeitedCount: number
  unforfeitedPeriodsCount: number
  statusesUpdated: number
  eligibleForRecovery: boolean
}

/**
 * Loads active (SUBMITTED) submission shield slices targeting a given obligation.
 */
async function loadShieldSubmissionSlices(
  tx: Prisma.TransactionClient,
  params: {
    memberId: string
    targetType: AllocationTargetType
    targetId: string
    excludeSubmissionIds?: string[]
  },
): Promise<ShieldSubmissionSlice[]> {
  const targets = await tx.submissionTarget.findMany({
    where: {
      targetType: params.targetType,
      targetId: params.targetId,
      submission: {
        memberId: params.memberId,
        status: PaymentSubmissionStatus.SUBMITTED,
        ...(params.excludeSubmissionIds?.length
          ? { id: { notIn: params.excludeSubmissionIds } }
          : {}),
      },
    },
    include: {
      submission: {
        select: {
          paidOn: true,
        },
      },
    },
  })

  return targets.map((t) => ({
    periodId: t.targetPeriodId ?? null,
    paidOn: t.submission.paidOn,
  }))
}

/**
 * Recomputes lateness, penalty accruals, penalty reversals, savings forfeitures,
 * period/obligation statuses, and recovery-case eligibility in an existing transaction.
 * Idempotent: running twice with the same state produces zero additional mutations.
 */
export async function recalculateLatenessInTx(
  tx: Prisma.TransactionClient,
  params: RecalculateLatenessParams,
): Promise<RecalculateLatenessResult> {
  const asOfStr = params.asOf
    ? toLagosDateString(parseDateOnly(params.asOf))
    : lagosToday()

  if (params.obligationType === 'LOAN') {
    return recalculateLoanLatenessInTx(tx, params.obligationId, asOfStr, params)
  }
  if (params.obligationType === 'EAJO') {
    return recalculateEAjoLatenessInTx(tx, params.obligationId, asOfStr, params)
  }
  return recalculateSavingsLatenessInTx(tx, params.obligationId, asOfStr, params)
}

/**
 * Standalone transactional wrapper for recalculateLatenessInTx.
 */
export async function recalculateLateness(
  params: RecalculateLatenessParams,
): Promise<RecalculateLatenessResult> {
  return prisma.$transaction(async (tx) => recalculateLatenessInTx(tx, params), {
    maxWait: 10000,
    timeout: 30000,
  })
}

async function recalculateLoanLatenessInTx(
  tx: Prisma.TransactionClient,
  loanId: string,
  asOfStr: string,
  params: RecalculateLatenessParams,
): Promise<RecalculateLatenessResult> {
  const loan = await tx.loan.findUniqueOrThrow({
    where: { id: loanId },
    include: {
      instalments: {
        orderBy: { instalmentNumber: 'asc' },
        include: {
          penalties: true,
        },
      },
    },
  })

  await lockMembers(tx, [loan.userId])

  const DisbursedStatuses: LoanStatus[] = [
    LoanStatus.DISBURSED,
    LoanStatus.ACTIVE,
    LoanStatus.OVERDUE,
    LoanStatus.COMPLETED,
    LoanStatus.DEFAULTED,
  ]
  if (!DisbursedStatuses.includes(loan.status)) {
    return {
      obligationType: 'LOAN',
      obligationId: loanId,
      asOf: asOfStr,
      accrualsCreated: 0,
      accrualsReversed: 0,
      penaltiesAssessedNet: new Prisma.Decimal(0),
      forfeitedPeriodsCount: 0,
      savingsForfeitedCount: 0,
      unforfeitedPeriodsCount: 0,
      statusesUpdated: 0,
      eligibleForRecovery: false,
    }
  }

  // Load all active payment allocations for this loan with their payment valueDates
  const rawAllocations = await tx.paymentAllocation.findMany({
    where: {
      targetType: AllocationTargetType.LOAN,
      targetId: loanId,
      status: AllocationStatus.ACTIVE,
      payment: {
        status: PaymentStatus.CONFIRMED,
      },
    },
    include: {
      payment: {
        select: {
          valueDate: true,
        },
      },
    },
  })

  const activeAllocations: ValueDatedAllocationSlice[] = rawAllocations.map(
    (a) => ({
      periodId: a.periodId,
      componentType: a.componentType,
      amount: a.amount,
      valueDate: a.payment.valueDate,
    }),
  )

  const shieldSubmissions = await loadShieldSubmissionSlices(tx, {
    memberId: loan.userId,
    targetType: AllocationTargetType.LOAN,
    targetId: loanId,
    excludeSubmissionIds: params.excludeSubmissionIds,
  })

  const existingAccruals: ExistingLoanAccrualSlice[] = []
  for (const inst of loan.instalments) {
    for (const p of inst.penalties) {
      existingAccruals.push({
        id: p.id,
        loanInstalmentId: p.loanInstalmentId,
        penaltyDate: p.penaltyDate,
        amount: p.amount,
        reversedAt: p.reversedAt,
        journalEntryId: p.journalEntryId,
      })
    }
  }

  const disbursedPrincipal = loan.approvedAmount ?? loan.requestedAmount
  const dailyRatePercent = loan.latePenaltyDailyPercent ?? new Prisma.Decimal(0)
  const capType = loan.penaltyCapType ?? PenaltyCapType.PERCENT_OF_PRINCIPAL
  const capValue = loan.penaltyCapValue ?? new Prisma.Decimal(100)

  const plan = planLoanPenaltyLateness({
    disbursedPrincipal,
    dailyRatePercent,
    capType,
    capValue,
    asOf: asOfStr,
    instalments: loan.instalments.map((i) => ({
      id: i.id,
      instalmentNumber: i.instalmentNumber,
      dueDate: i.dueDate,
      principalDue: i.principalDue,
      interestDue: i.interestDue,
    })),
    activeAllocations,
    existingAccruals,
    shieldSubmissions,
    reverseAccrualsAfterAsOf: params.reverseAccrualsAfterAsOf,
  })

  let accrualsReversed = 0
  let accrualsCreated = 0
  let statusesUpdated = 0

  // 1. Reverse invalid accruals
  for (const rev of plan.toReverse) {
    if (rev.journalEntryId) {
      const je = await tx.journalEntry.findUnique({
        where: { id: rev.journalEntryId },
        include: { reversedBy: true },
      })
      if (je && !je.reversedBy) {
        await reverseJournalEntry(tx, {
          originalJournalEntryId: rev.journalEntryId,
          idempotencyKey: `loan-penalty-rev:${rev.accrualId}:${Date.now()}`,
          reason: rev.reason,
          postedById: params.actorId ?? null,
          effectiveDate: parseDateOnly(rev.penaltyDate),
        })
      }
    }

    await tx.loanPenaltyAccrual.update({
      where: { id: rev.accrualId },
      data: {
        reversedAt: new Date(),
        reversalReason: rev.reason,
      },
    })
    accrualsReversed++
  }

  // 2. Create missing accruals (or re-activate previously reversed rows on the same date)
  for (const acc of plan.toAccrue) {
    const penaltyDateObj = parseDateOnly(acc.penaltyDate)
    const je = await postLoanPenalty(tx, {
      amount: acc.amount,
      memberId: loan.userId,
      loanId: loan.id,
      effectiveDate: penaltyDateObj,
      idempotencyKey: `loan-penalty:${acc.loanInstalmentId}:${acc.penaltyDate}:${Date.now()}`,
      postedById: params.actorId ?? null,
      description: `Late penalty for loan ${loan.id} instalment #${acc.instalmentNumber} on ${acc.penaltyDate}`,
    })

    const existingRow = await tx.loanPenaltyAccrual.findUnique({
      where: {
        loanInstalmentId_penaltyDate: {
          loanInstalmentId: acc.loanInstalmentId,
          penaltyDate: penaltyDateObj,
        },
      },
    })

    if (existingRow) {
      await tx.loanPenaltyAccrual.update({
        where: { id: existingRow.id },
        data: {
          amount: acc.amount,
          reversedAt: null,
          reversalReason: null,
          journalEntryId: je.id,
        },
      })
    } else {
      await tx.loanPenaltyAccrual.create({
        data: {
          loanInstalmentId: acc.loanInstalmentId,
          penaltyDate: penaltyDateObj,
          amount: acc.amount,
          journalEntryId: je.id,
        },
      })
    }
    accrualsCreated++
  }

  // 3. Recompute each instalment's principalPaid, interestPaid, penaltyPaid, penaltyAssessed from DB
  for (const inst of loan.instalments) {
    const instAllocs = activeAllocations.filter((a) => a.periodId === inst.id)
    let principalPaid = new Prisma.Decimal(0)
    let interestPaid = new Prisma.Decimal(0)
    let penaltyPaid = new Prisma.Decimal(0)
    for (const a of instAllocs) {
      const amt = toDecimal(a.amount)
      if (a.componentType === PaymentComponentType.PRINCIPAL) {
        principalPaid = principalPaid.plus(amt)
      } else if (a.componentType === PaymentComponentType.INTEREST) {
        interestPaid = interestPaid.plus(amt)
      } else if (a.componentType === PaymentComponentType.PENALTY) {
        penaltyPaid = penaltyPaid.plus(amt)
      }
    }
    principalPaid = roundMoney(principalPaid)
    interestPaid = roundMoney(interestPaid)
    penaltyPaid = roundMoney(penaltyPaid)

    const allPenalties = await tx.loanPenaltyAccrual.findMany({
      where: {
        loanInstalmentId: inst.id,
      },
      select: { amount: true, reversedAt: true },
    })
    const activePenalties = allPenalties.filter((p) => p.reversedAt === null)
    const penaltyAssessed =
      allPenalties.length === 0 && dailyRatePercent.lte(0)
        ? roundMoney(toDecimal(inst.penaltyAssessed))
        : roundMoney(
            activePenalties.reduce(
              (sum, p) => sum.plus(p.amount),
              new Prisma.Decimal(0),
            ),
          )

    if (
      !toDecimal(inst.principalPaid).eq(principalPaid) ||
      !toDecimal(inst.interestPaid).eq(interestPaid) ||
      !toDecimal(inst.penaltyPaid).eq(penaltyPaid) ||
      !toDecimal(inst.penaltyAssessed).eq(penaltyAssessed)
    ) {
      await tx.loanInstalment.update({
        where: { id: inst.id },
        data: {
          principalPaid,
          interestPaid,
          penaltyPaid,
          penaltyAssessed,
        },
      })
      statusesUpdated++
    }
  }

  // 4. Refresh loan & instalment statuses, outstandingBalance, totalRepaid, and guarantee release
  if (!params.skipStatusRefresh) {
    await refreshLoanAfterPayment(tx, loan.id, {
      actorId: params.actorId ?? null,
      today: asOfStr,
    })
  }

  // 5. Evaluate recovery-case eligibility (dueDate + 15, unshielded)
  const updatedInstalments = await tx.loanInstalment.findMany({
    where: { loanId: loan.id },
    orderBy: { instalmentNumber: 'asc' },
  })

  let eligibleForRecovery = false
  for (const inst of updatedInstalments) {
    const outPrincipal = Prisma.Decimal.max(
      0,
      toDecimal(inst.principalDue).minus(inst.principalPaid),
    )
    const outInterest = Prisma.Decimal.max(
      0,
      toDecimal(inst.interestDue).minus(inst.interestPaid),
    )
    const outPenalty = Prisma.Decimal.max(
      0,
      toDecimal(inst.penaltyAssessed)
        .minus(inst.penaltyPaid)
        .minus(inst.penaltyWaived),
    )
    const outstandingAmount = outPrincipal.plus(outInterest).plus(outPenalty)
    const instShieldDates = shieldSubmissions
      .filter((s) => s.periodId === null || s.periodId === inst.id)
      .map((s) => s.paidOn)

    const rec = evaluateRecoveryEligibility({
      dueDate: inst.dueDate,
      outstandingAmount,
      asOf: asOfStr,
      shieldPaidOnDates: instShieldDates,
    })
    if (rec.isEligible) {
      eligibleForRecovery = true
      break
    }
  }

  if (accrualsCreated > 0 || accrualsReversed > 0) {
    await recordAuditEvent(
      {
        actorId: params.actorId ?? null,
        affectedUserId: loan.userId,
        action: AuditAction.PENALTY_RECALCULATED,
        entityType: 'Loan',
        entityId: loan.id,
        outcome: 'SUCCESS',
        metadata: {
          asOf: asOfStr,
          accrualsCreated,
          accrualsReversed,
          eligibleForRecovery,
        },
      },
      tx,
    )
  }

  return {
    obligationType: 'LOAN',
    obligationId: loanId,
    asOf: asOfStr,
    accrualsCreated,
    accrualsReversed,
    penaltiesAssessedNet: plan.finalPenaltiesAssessedNet,
    forfeitedPeriodsCount: 0,
    savingsForfeitedCount: 0,
    unforfeitedPeriodsCount: 0,
    statusesUpdated,
    eligibleForRecovery,
  }
}

async function recalculateEAjoLatenessInTx(
  tx: Prisma.TransactionClient,
  eajoMemberId: string,
  asOfStr: string,
  params: RecalculateLatenessParams,
): Promise<RecalculateLatenessResult> {
  const member = await tx.eAjoMember.findUniqueOrThrow({
    where: { id: eajoMemberId },
    include: {
      group: true,
      contributionPeriods: {
        orderBy: { periodNumber: 'asc' },
        include: {
          penalties: true,
        },
      },
    },
  })

  await lockMembers(tx, [member.userId])

  const rawAllocations = await tx.paymentAllocation.findMany({
    where: {
      targetType: AllocationTargetType.EAJO,
      targetId: eajoMemberId,
      status: AllocationStatus.ACTIVE,
      payment: {
        status: PaymentStatus.CONFIRMED,
      },
    },
    include: {
      payment: {
        select: {
          valueDate: true,
        },
      },
    },
  })

  const activeAllocations: ValueDatedAllocationSlice[] = rawAllocations.map(
    (a) => ({
      periodId: a.periodId,
      componentType: a.componentType,
      amount: a.amount,
      valueDate: a.payment.valueDate,
    }),
  )

  const shieldSubmissions = await loadShieldSubmissionSlices(tx, {
    memberId: member.userId,
    targetType: AllocationTargetType.EAJO,
    targetId: eajoMemberId,
    excludeSubmissionIds: params.excludeSubmissionIds,
  })

  const existingAccruals: ExistingEAjoAccrualSlice[] = []
  for (const period of member.contributionPeriods) {
    for (const p of period.penalties) {
      existingAccruals.push({
        id: p.id,
        eajoContributionPeriodId: p.eajoContributionPeriodId,
        penaltyDate: p.penaltyDate,
        amount: p.amount,
        reversedAt: p.reversedAt,
        journalEntryId: p.journalEntryId,
      })
    }
  }

  const capBase = roundMoney(
    toDecimal(member.group.contributionAmount).mul(member.group.totalSlots),
  )
  const dailyRatePercent =
    member.latePenaltyDailyPercent ??
    member.group.latePenaltyDailyPercent ??
    new Prisma.Decimal(0)
  const capType =
    member.penaltyCapType ??
    member.group.penaltyCapType ??
    PenaltyCapType.PERCENT_OF_PRINCIPAL
  const capValue =
    member.penaltyCapValue ??
    member.group.penaltyCapValue ??
    new Prisma.Decimal(100)

  const plan = planEAjoParticipantPenaltyLateness({
    capBase,
    dailyRatePercent,
    capType,
    capValue,
    asOf: asOfStr,
    periods: member.contributionPeriods.map((p) => ({
      id: p.id,
      periodNumber: p.periodNumber,
      dueDate: p.dueDate,
      contributionDue: p.contributionDue,
    })),
    activeAllocations,
    existingAccruals,
    shieldSubmissions,
    reverseAccrualsAfterAsOf: params.reverseAccrualsAfterAsOf,
  })

  let accrualsReversed = 0
  let accrualsCreated = 0
  let statusesUpdated = 0

  for (const rev of plan.toReverse) {
    if (rev.journalEntryId) {
      const je = await tx.journalEntry.findUnique({
        where: { id: rev.journalEntryId },
        include: { reversedBy: true },
      })
      if (je && !je.reversedBy) {
        await reverseJournalEntry(tx, {
          originalJournalEntryId: rev.journalEntryId,
          idempotencyKey: `eajo-penalty-rev:${rev.accrualId}:${Date.now()}`,
          reason: rev.reason,
          postedById: params.actorId ?? null,
          effectiveDate: parseDateOnly(rev.penaltyDate),
        })
      }
    }

    await tx.eAjoPenaltyAccrual.update({
      where: { id: rev.accrualId },
      data: {
        reversedAt: new Date(),
        reversalReason: rev.reason,
      },
    })
    accrualsReversed++
  }

  for (const acc of plan.toAccrue) {
    const penaltyDateObj = parseDateOnly(acc.penaltyDate)
    const je = await postJournalEntry(tx, {
      sourceType: 'EAJO_PENALTY',
      sourceId: acc.eajoContributionPeriodId,
      idempotencyKey: `eajo-penalty:${acc.eajoContributionPeriodId}:${acc.penaltyDate}:${Date.now()}`,
      description: `E-Ajo late penalty for period #${acc.periodNumber} on ${acc.penaltyDate}`,
      effectiveDate: penaltyDateObj,
      postedById: params.actorId ?? null,
      lines: [
        {
          accountType: LedgerAccountType.EAJO_PENALTY_RECEIVABLE,
          debit: acc.amount,
          credit: 0,
          memberId: member.userId,
          accountRefType: 'EAJO',
          accountRefId: member.id,
        },
        {
          accountType: LedgerAccountType.PENALTY_INCOME,
          debit: 0,
          credit: acc.amount,
          memberId: member.userId,
          accountRefType: 'EAJO',
          accountRefId: member.id,
        },
      ],
    })

    const existingRow = await tx.eAjoPenaltyAccrual.findUnique({
      where: {
        eajoContributionPeriodId_penaltyDate: {
          eajoContributionPeriodId: acc.eajoContributionPeriodId,
          penaltyDate: penaltyDateObj,
        },
      },
    })

    if (existingRow) {
      await tx.eAjoPenaltyAccrual.update({
        where: { id: existingRow.id },
        data: {
          amount: acc.amount,
          reversedAt: null,
          reversalReason: null,
          journalEntryId: je.id,
        },
      })
    } else {
      await tx.eAjoPenaltyAccrual.create({
        data: {
          eajoContributionPeriodId: acc.eajoContributionPeriodId,
          penaltyDate: penaltyDateObj,
          amount: acc.amount,
          journalEntryId: je.id,
        },
      })
    }
    accrualsCreated++
  }

  for (const period of member.contributionPeriods) {
    const periodAllocs = activeAllocations.filter((a) => a.periodId === period.id)
    let contributionPaid = new Prisma.Decimal(0)
    let penaltyPaid = new Prisma.Decimal(0)
    for (const a of periodAllocs) {
      const amt = toDecimal(a.amount)
      if (
        a.componentType === PaymentComponentType.CONTRIBUTION ||
        a.componentType === PaymentComponentType.PRINCIPAL
      ) {
        contributionPaid = contributionPaid.plus(amt)
      } else if (a.componentType === PaymentComponentType.PENALTY) {
        penaltyPaid = penaltyPaid.plus(amt)
      }
    }
    contributionPaid = roundMoney(contributionPaid)
    penaltyPaid = roundMoney(penaltyPaid)

    const allPenalties = await tx.eAjoPenaltyAccrual.findMany({
      where: {
        eajoContributionPeriodId: period.id,
      },
      select: { amount: true, reversedAt: true },
    })
    const activePenalties = allPenalties.filter((p) => p.reversedAt === null)
    const penaltyAssessed =
      allPenalties.length === 0 && dailyRatePercent.lte(0)
        ? roundMoney(toDecimal(period.penaltyAssessed))
        : roundMoney(
            activePenalties.reduce(
              (sum, p) => sum.plus(p.amount),
              new Prisma.Decimal(0),
            ),
          )

    if (
      !toDecimal(period.contributionPaid).eq(contributionPaid) ||
      !toDecimal(period.penaltyPaid).eq(penaltyPaid) ||
      !toDecimal(period.penaltyAssessed).eq(penaltyAssessed)
    ) {
      await tx.eAjoContributionPeriod.update({
        where: { id: period.id },
        data: {
          contributionPaid,
          penaltyPaid,
          penaltyAssessed,
        },
      })
      statusesUpdated++
    }
  }

  // Refresh E-Ajo participant and period statuses
  if (!params.skipStatusRefresh) {
    await refreshEAjoParticipant(tx, member.id, {
      today: asOfStr,
      actorId: params.actorId ?? null,
    })
  }

  if (accrualsCreated > 0 || accrualsReversed > 0) {
    await recordAuditEvent(
      {
        actorId: params.actorId ?? null,
        affectedUserId: member.userId,
        action: AuditAction.PENALTY_RECALCULATED,
        entityType: 'EAjoMember',
        entityId: member.id,
        outcome: 'SUCCESS',
        metadata: {
          asOf: asOfStr,
          accrualsCreated,
          accrualsReversed,
        },
      },
      tx,
    )
  }

  return {
    obligationType: 'EAJO',
    obligationId: eajoMemberId,
    asOf: asOfStr,
    accrualsCreated,
    accrualsReversed,
    penaltiesAssessedNet: plan.finalPenaltiesAssessedNet,
    forfeitedPeriodsCount: 0,
    savingsForfeitedCount: 0,
    unforfeitedPeriodsCount: 0,
    statusesUpdated,
    eligibleForRecovery: false,
  }
}

async function recalculateSavingsLatenessInTx(
  tx: Prisma.TransactionClient,
  savingsId: string,
  asOfStr: string,
  params: RecalculateLatenessParams,
): Promise<RecalculateLatenessResult> {
  const savings = await tx.savings.findUniqueOrThrow({
    where: { id: savingsId },
    include: {
      periods: {
        orderBy: { periodNumber: 'asc' },
      },
    },
  })

  await lockMembers(tx, [savings.userId])

  if (savings.savingsType !== SavingsType.REGULAR || savings.periods.length === 0) {
    return {
      obligationType: 'SAVINGS',
      obligationId: savingsId,
      asOf: asOfStr,
      accrualsCreated: 0,
      accrualsReversed: 0,
      penaltiesAssessedNet: new Prisma.Decimal(0),
      forfeitedPeriodsCount: 0,
      savingsForfeitedCount: 0,
      unforfeitedPeriodsCount: 0,
      statusesUpdated: 0,
      eligibleForRecovery: false,
    }
  }

  // Recompute each period's amountPaid from active allocations to prevent drift
  const rawAllocations = await tx.paymentAllocation.findMany({
    where: {
      targetType: AllocationTargetType.SAVINGS,
      targetId: savingsId,
      status: AllocationStatus.ACTIVE,
      payment: {
        status: PaymentStatus.CONFIRMED,
      },
    },
  })

  const paidByPeriod = new Map<string, Prisma.Decimal>()
  for (const a of rawAllocations) {
    if (!a.periodId) continue
    const prev = paidByPeriod.get(a.periodId) ?? new Prisma.Decimal(0)
    paidByPeriod.set(a.periodId, prev.plus(a.amount))
  }

  let forfeitedPeriodsCount = 0
  let unforfeitedPeriodsCount = 0
  let statusesUpdated = 0

  for (const period of savings.periods) {
    const amountPaid = roundMoney(paidByPeriod.get(period.id) ?? new Prisma.Decimal(0))
    const wasForfeited = period.interestForfeited
    const prevStatus = period.status

    if (!toDecimal(period.amountPaid).eq(amountPaid)) {
      await tx.savingsPeriod.update({
        where: { id: period.id },
        data: { amountPaid },
      })
    }

    const updatedForfeitureState = await recalculateSavingsPeriodForfeiture(
      tx,
      period.id,
      asOfStr,
      params.actorId ?? null,
    )
    const updatedPeriod = await refreshSavingsPeriodStatus(tx, period.id, asOfStr)

    const isNowForfeited =
      updatedForfeitureState !== null
        ? updatedForfeitureState === 'FORFEITED'
        : wasForfeited

    if (!wasForfeited && isNowForfeited) {
      forfeitedPeriodsCount++
    } else if (wasForfeited && !isNowForfeited) {
      unforfeitedPeriodsCount++
    }

    if (
      (updatedPeriod && prevStatus !== updatedPeriod.status) ||
      wasForfeited !== isNowForfeited
    ) {
      statusesUpdated++
    }
  }

  if (forfeitedPeriodsCount > 0 || unforfeitedPeriodsCount > 0) {
    await recordAuditEvent(
      {
        actorId: params.actorId ?? null,
        affectedUserId: savings.userId,
        action: AuditAction.PENALTY_RECALCULATED,
        entityType: 'Savings',
        entityId: savings.id,
        outcome: 'SUCCESS',
        metadata: {
          asOf: asOfStr,
          forfeitedPeriodsCount,
          unforfeitedPeriodsCount,
        },
      },
      tx,
    )
  }

  return {
    obligationType: 'SAVINGS',
    obligationId: savingsId,
    asOf: asOfStr,
    accrualsCreated: 0,
    accrualsReversed: 0,
    penaltiesAssessedNet: new Prisma.Decimal(0),
    forfeitedPeriodsCount,
    savingsForfeitedCount: forfeitedPeriodsCount,
    unforfeitedPeriodsCount,
    statusesUpdated,
    eligibleForRecovery: false,
  }
}
