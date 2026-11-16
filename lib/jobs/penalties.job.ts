import { prisma } from '@/lib/prisma'
import {
  EAjoMemberStatus,
  EAjoStatus,
  LoanStatus,
  SavingsStatus,
  SavingsType,
} from '@/generated/prisma/enums'
import { lagosToday, parseDateOnly, toLagosDateString } from '@/lib/domain/dates'
import { recalculateLateness } from '@/lib/services/lateness.service'

export interface PenaltiesJobOptions {
  asOf?: Date | string
  batchSize?: number
  actorId?: string | null
}

export interface PenaltiesJobSummary {
  asOf: string
  loansProcessed: number
  eajoMembersProcessed: number
  savingsPlansProcessed: number
  accrualsCreated: number
  accrualsReversed: number
  forfeitedPeriodsCount: number
  unforfeitedPeriodsCount: number
  eligibleForRecoveryLoanIds: string[]
}

/**
 * Catch-up, idempotent daily penalty and forfeiture job (§2.2, §2.5, §2.8, §2.9, P3-06).
 * Evaluates all active/overdue loans, active E-Ajo participations, and active regular savings plans
 * in chunks up to `asOf` (defaults to `lagosToday()`).
 */
export async function runPenaltiesJob(
  options: PenaltiesJobOptions = {},
): Promise<PenaltiesJobSummary> {
  const asOfStr = options.asOf
    ? toLagosDateString(parseDateOnly(options.asOf))
    : lagosToday()
  const batchSize = options.batchSize ?? 50
  const actorId = options.actorId ?? null

  let loansProcessed = 0
  let eajoMembersProcessed = 0
  let savingsPlansProcessed = 0
  let accrualsCreated = 0
  let accrualsReversed = 0
  let forfeitedPeriodsCount = 0
  let unforfeitedPeriodsCount = 0
  const eligibleForRecoveryLoanIds: string[] = []

  // 1. Process active/overdue loans in chunks
  let loanCursor: string | undefined
  while (true) {
    const loans = await prisma.loan.findMany({
      where: {
        status: {
          in: [LoanStatus.DISBURSED, LoanStatus.ACTIVE, LoanStatus.OVERDUE],
        },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(loanCursor ? { skip: 1, cursor: { id: loanCursor } } : {}),
    })
    if (loans.length === 0) break

    for (const loan of loans) {
      const res = await recalculateLateness({
        obligationType: 'LOAN',
        obligationId: loan.id,
        asOf: asOfStr,
        actorId,
      })
      loansProcessed++
      accrualsCreated += res.accrualsCreated
      accrualsReversed += res.accrualsReversed
      if (res.eligibleForRecovery) {
        eligibleForRecoveryLoanIds.push(loan.id)
      }
    }

    loanCursor = loans[loans.length - 1].id
    if (loans.length < batchSize) break
  }

  // 2. Process active E-Ajo participations in chunks
  let eajoCursor: string | undefined
  while (true) {
    const members = await prisma.eAjoMember.findMany({
      where: {
        status: EAjoMemberStatus.ACTIVE,
        group: {
          status: EAjoStatus.ACTIVE,
        },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(eajoCursor ? { skip: 1, cursor: { id: eajoCursor } } : {}),
    })
    if (members.length === 0) break

    for (const m of members) {
      const res = await recalculateLateness({
        obligationType: 'EAJO',
        obligationId: m.id,
        asOf: asOfStr,
        actorId,
      })
      eajoMembersProcessed++
      accrualsCreated += res.accrualsCreated
      accrualsReversed += res.accrualsReversed
    }

    eajoCursor = members[members.length - 1].id
    if (members.length < batchSize) break
  }

  // 3. Process active regular savings plans in chunks
  let savingsCursor: string | undefined
  while (true) {
    const plans = await prisma.savings.findMany({
      where: {
        savingsType: SavingsType.REGULAR,
        status: SavingsStatus.ACTIVE,
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(savingsCursor ? { skip: 1, cursor: { id: savingsCursor } } : {}),
    })
    if (plans.length === 0) break

    for (const plan of plans) {
      const res = await recalculateLateness({
        obligationType: 'SAVINGS',
        obligationId: plan.id,
        asOf: asOfStr,
        actorId,
      })
      savingsPlansProcessed++
      forfeitedPeriodsCount += res.forfeitedPeriodsCount
      unforfeitedPeriodsCount += res.unforfeitedPeriodsCount
    }

    savingsCursor = plans[plans.length - 1].id
    if (plans.length < batchSize) break
  }

  return {
    asOf: asOfStr,
    loansProcessed,
    eajoMembersProcessed,
    savingsPlansProcessed,
    accrualsCreated,
    accrualsReversed,
    forfeitedPeriodsCount,
    unforfeitedPeriodsCount,
    eligibleForRecoveryLoanIds,
  }
}
