import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import {
  PaymentPeriodStatus,
  SavingsFrequency,
  SavingsMaturity,
  SavingsType,
} from '@/generated/prisma/enums'
import { roundMoney, toDecimal } from '@/lib/domain/money'
import {
  addMonthsClamped,
  formatDateOnly,
  generateDailySavingsDueDates,
  generateEAjoDueDates,
  generateMonthlySavingsDueDates,
  generateWeeklySavingsDueDates,
  isBefore,
  lagosToday,
  parseDateOnly,
} from '@/lib/domain/dates'
import { generateLoanSchedule } from '@/lib/domain/loan-schedule'
import { maturityToMonths } from '@/lib/savings'

export interface LoanInstalmentOutstanding {
  principalOutstanding: Prisma.Decimal
  interestOutstanding: Prisma.Decimal
  penaltyOutstanding: Prisma.Decimal
  totalOutstanding: Prisma.Decimal
}

export interface SavingsPeriodOutstanding {
  amountOutstanding: Prisma.Decimal
}

export interface EAjoPeriodOutstanding {
  contributionOutstanding: Prisma.Decimal
  penaltyOutstanding: Prisma.Decimal
  totalOutstanding: Prisma.Decimal
}

/**
 * Computes un-drifted outstanding balances for a loan instalment (§2.9, §2.10).
 */
export function getLoanInstalmentOutstanding(instalment: {
  principalDue: Prisma.Decimal | string | number
  principalPaid: Prisma.Decimal | string | number
  interestDue: Prisma.Decimal | string | number
  interestPaid: Prisma.Decimal | string | number
  penaltyAssessed: Prisma.Decimal | string | number
  penaltyPaid: Prisma.Decimal | string | number
  penaltyWaived: Prisma.Decimal | string | number
}): LoanInstalmentOutstanding {
  const pDue = toDecimal(instalment.principalDue)
  const pPaid = toDecimal(instalment.principalPaid)
  const iDue = toDecimal(instalment.interestDue)
  const iPaid = toDecimal(instalment.interestPaid)
  const penAssessed = toDecimal(instalment.penaltyAssessed)
  const penPaid = toDecimal(instalment.penaltyPaid)
  const penWaived = toDecimal(instalment.penaltyWaived)

  const principalOutstanding = Prisma.Decimal.max(0, pDue.minus(pPaid))
  const interestOutstanding = Prisma.Decimal.max(0, iDue.minus(iPaid))
  const penaltyOutstanding = Prisma.Decimal.max(
    0,
    penAssessed.minus(penPaid).minus(penWaived),
  )
  const totalOutstanding = principalOutstanding
    .plus(interestOutstanding)
    .plus(penaltyOutstanding)

  return {
    principalOutstanding,
    interestOutstanding,
    penaltyOutstanding,
    totalOutstanding,
  }
}

/**
 * Computes outstanding balance for a savings period.
 */
export function getSavingsPeriodOutstanding(period: {
  amountDue: Prisma.Decimal | string | number
  amountPaid: Prisma.Decimal | string | number
}): SavingsPeriodOutstanding {
  const due = toDecimal(period.amountDue)
  const paid = toDecimal(period.amountPaid)
  const amountOutstanding = Prisma.Decimal.max(0, due.minus(paid))
  return { amountOutstanding }
}

/**
 * Computes outstanding balance for an E-Ajo contribution period.
 */
export function getEAjoPeriodOutstanding(period: {
  contributionDue: Prisma.Decimal | string | number
  contributionPaid: Prisma.Decimal | string | number
  penaltyAssessed: Prisma.Decimal | string | number
  penaltyPaid: Prisma.Decimal | string | number
  penaltyWaived: Prisma.Decimal | string | number
}): EAjoPeriodOutstanding {
  const cDue = toDecimal(period.contributionDue)
  const cPaid = toDecimal(period.contributionPaid)
  const penAssessed = toDecimal(period.penaltyAssessed)
  const penPaid = toDecimal(period.penaltyPaid)
  const penWaived = toDecimal(period.penaltyWaived)

  const contributionOutstanding = Prisma.Decimal.max(0, cDue.minus(cPaid))
  const penaltyOutstanding = Prisma.Decimal.max(
    0,
    penAssessed.minus(penPaid).minus(penWaived),
  )
  const totalOutstanding = contributionOutstanding.plus(penaltyOutstanding)

  return {
    contributionOutstanding,
    penaltyOutstanding,
    totalOutstanding,
  }
}

/**
 * Determines period status based on outstanding balance, payment progress, and Lagos calendar boundaries.
 * A period is OVERDUE when dueDate < today and anything is outstanding and it is not review-shielded.
 */
export function computePeriodStatus(params: {
  dueDate: Date | string
  totalOutstanding: Prisma.Decimal
  totalPaid: Prisma.Decimal
  isShielded?: boolean
  today?: string
}): PaymentPeriodStatus {
  const today = params.today || lagosToday()

  if (params.totalOutstanding.lte(0)) {
    return PaymentPeriodStatus.COMPLETED
  }

  const isDuePast = isBefore(params.dueDate, today)

  if (isDuePast) {
    if (params.isShielded) {
      return PaymentPeriodStatus.IN_REVIEW
    }
    return PaymentPeriodStatus.OVERDUE
  }

  if (params.totalPaid.gt(0)) {
    return PaymentPeriodStatus.ONGOING
  }

  return PaymentPeriodStatus.PENDING
}

// ============================================
// SCHEDULE PERSISTENCE HELPERS
// ============================================

export interface GenerateAndPersistLoanScheduleParams {
  loanId: string
  principal: Prisma.Decimal | string | number
  termMonths: number
  monthlyInterestRatePercent: Prisma.Decimal | string | number
  disbursementValueDate: Date | string
}

/**
 * Generates and persists the standard loan instalment schedule idempotently.
 */
export async function generateAndPersistLoanSchedule(
  tx: Prisma.TransactionClient,
  params: GenerateAndPersistLoanScheduleParams,
) {
  // Idempotency check: if instalments already exist for this loan, return them
  const existing = await tx.loanInstalment.findMany({
    where: { loanId: params.loanId },
    orderBy: { instalmentNumber: 'asc' },
  })

  if (existing.length > 0) {
    return existing
  }

  const generated = generateLoanSchedule({
    principal: params.principal,
    termMonths: params.termMonths,
    monthlyInterestRatePercent: params.monthlyInterestRatePercent,
    anchorDate: params.disbursementValueDate,
  })

  const instalmentsData = generated.instalments.map((inst) => ({
    loanId: params.loanId,
    instalmentNumber: inst.instalmentNumber,
    dueDate: inst.dueDate,
    principalDue: inst.principalDue,
    interestDue: inst.interestDue,
    principalPaid: new Prisma.Decimal(0),
    interestPaid: new Prisma.Decimal(0),
    penaltyAssessed: new Prisma.Decimal(0),
    penaltyPaid: new Prisma.Decimal(0),
    penaltyWaived: new Prisma.Decimal(0),
    status: PaymentPeriodStatus.PENDING,
  }))

  await tx.loanInstalment.createMany({
    data: instalmentsData,
  })

  return tx.loanInstalment.findMany({
    where: { loanId: params.loanId },
    orderBy: { instalmentNumber: 'asc' },
  })
}

export interface GenerateAndPersistSavingsScheduleParams {
  savingsId: string
  savingsType: SavingsType
  frequency: SavingsFrequency
  maturity: SavingsMaturity
  targetAmount: Prisma.Decimal | string | number
  firstDepositValueDate: Date | string
}

/**
 * Generates and persists the savings schedule idempotently.
 */
export async function generateAndPersistSavingsSchedule(
  tx: Prisma.TransactionClient,
  params: GenerateAndPersistSavingsScheduleParams,
) {
  const existing = await tx.savingsPeriod.findMany({
    where: { savingsId: params.savingsId },
    orderBy: { periodNumber: 'asc' },
  })

  if (existing.length > 0) {
    return existing
  }

  const targetAmount = roundMoney(params.targetAmount)
  const durationMonths = maturityToMonths(params.maturity)
  let dueDates: Date[] = []

  if (params.savingsType === SavingsType.FIXED) {
    // FIXED savings is a single lump-sum upfront period due on start date
    dueDates = [parseDateOnly(params.firstDepositValueDate)]
  } else if (params.savingsType === SavingsType.REGULAR) {
    if (params.frequency === SavingsFrequency.MONTHLY) {
      dueDates = generateMonthlySavingsDueDates(
        params.firstDepositValueDate,
        durationMonths,
      )
    } else if (params.frequency === SavingsFrequency.WEEKLY) {
      dueDates = generateWeeklySavingsDueDates(
        params.firstDepositValueDate,
        durationMonths,
      )
    } else if (params.frequency === SavingsFrequency.DAILY) {
      dueDates = generateDailySavingsDueDates(
        params.firstDepositValueDate,
        durationMonths,
      )
    } else {
      // Default to monthly if unspecified
      dueDates = generateMonthlySavingsDueDates(
        params.firstDepositValueDate,
        durationMonths,
      )
    }
  } else {
    // STAGGERED savings: minimum 1 period anchored on first deposit
    dueDates = [parseDateOnly(params.firstDepositValueDate)]
  }

  const periodsData = dueDates.map((dueDate, idx) => ({
    savingsId: params.savingsId,
    periodNumber: idx + 1,
    dueDate,
    amountDue: targetAmount,
    amountPaid: new Prisma.Decimal(0),
    status: PaymentPeriodStatus.PENDING,
    interestForfeited: false,
  }))

  await tx.savingsPeriod.createMany({
    data: periodsData,
  })

  return tx.savingsPeriod.findMany({
    where: { savingsId: params.savingsId },
    orderBy: { periodNumber: 'asc' },
  })
}

export interface GenerateAndPersistEAjoScheduleParams {
  eAjoMemberId: string
  contributionAmount: Prisma.Decimal | string | number
  totalSlots: number
  groupStartDate: Date | string
}

/**
 * Generates and persists E-Ajo contribution periods idempotently.
 */
export async function generateAndPersistEAjoSchedule(
  tx: Prisma.TransactionClient,
  params: GenerateAndPersistEAjoScheduleParams,
) {
  const existing = await tx.eAjoContributionPeriod.findMany({
    where: { eajoMemberId: params.eAjoMemberId },
    orderBy: { periodNumber: 'asc' },
  })

  if (existing.length > 0) {
    return existing
  }

  const contributionDue = roundMoney(params.contributionAmount)
  const dueDates = generateEAjoDueDates(
    params.groupStartDate,
    params.totalSlots,
  )

  const periodsData = dueDates.map((dueDate, idx) => ({
    eajoMemberId: params.eAjoMemberId,
    periodNumber: idx + 1,
    dueDate,
    contributionDue,
    contributionPaid: new Prisma.Decimal(0),
    penaltyAssessed: new Prisma.Decimal(0),
    penaltyPaid: new Prisma.Decimal(0),
    penaltyWaived: new Prisma.Decimal(0),
    status: PaymentPeriodStatus.PENDING,
  }))

  await tx.eAjoContributionPeriod.createMany({
    data: periodsData,
  })

  return tx.eAjoContributionPeriod.findMany({
    where: { eajoMemberId: params.eAjoMemberId },
    orderBy: { periodNumber: 'asc' },
  })
}

// ============================================
// PENALTY ACCRUAL ATOMIC OPERATIONS
// ============================================

export interface RecordLoanPenaltyAccrualParams {
  loanInstalmentId: string
  penaltyDate: Date | string
  amount: Prisma.Decimal | string | number
  journalEntryId?: string | null
}

/**
 * Atomically records a loan penalty accrual and updates the instalment's penaltyAssessed amount.
 */
export async function recordLoanPenaltyAccrual(
  tx: Prisma.TransactionClient,
  params: RecordLoanPenaltyAccrualParams,
) {
  const penaltyAmount = roundMoney(params.amount)
  const penaltyDate = parseDateOnly(params.penaltyDate)

  // 1. Create accrual record (fails on unique constraint if already assessed for this date)
  const accrual = await tx.loanPenaltyAccrual.create({
    data: {
      loanInstalmentId: params.loanInstalmentId,
      penaltyDate,
      amount: penaltyAmount,
      journalEntryId: params.journalEntryId || null,
    },
  })

  // 2. Increment instalment penaltyAssessed
  const instalment = await tx.loanInstalment.update({
    where: { id: params.loanInstalmentId },
    data: {
      penaltyAssessed: { increment: penaltyAmount },
    },
  })

  return { accrual, instalment }
}

export interface ReverseLoanPenaltyAccrualParams {
  loanInstalmentId: string
  penaltyDate: Date | string
  reason: string
}

/**
 * Atomically reverses a loan penalty accrual (e.g. following backdated value date confirmation §2.10).
 */
export async function reverseLoanPenaltyAccrual(
  tx: Prisma.TransactionClient,
  params: ReverseLoanPenaltyAccrualParams,
) {
  const penaltyDate = parseDateOnly(params.penaltyDate)

  const existing = await tx.loanPenaltyAccrual.findUnique({
    where: {
      loanInstalmentId_penaltyDate: {
        loanInstalmentId: params.loanInstalmentId,
        penaltyDate,
      },
    },
  })

  if (!existing || existing.reversedAt) {
    return null
  }

  // Mark reversed
  const accrual = await tx.loanPenaltyAccrual.update({
    where: { id: existing.id },
    data: {
      reversedAt: new Date(),
      reversalReason: params.reason,
    },
  })

  // Decrement instalment penaltyAssessed
  const instalment = await tx.loanInstalment.update({
    where: { id: params.loanInstalmentId },
    data: {
      penaltyAssessed: { decrement: existing.amount },
    },
  })

  return { accrual, instalment }
}

export interface RecordEAjoPenaltyAccrualParams {
  eajoContributionPeriodId: string
  penaltyDate: Date | string
  amount: Prisma.Decimal | string | number
  journalEntryId?: string | null
}

/**
 * Atomically records an E-Ajo late contribution penalty accrual.
 */
export async function recordEAjoPenaltyAccrual(
  tx: Prisma.TransactionClient,
  params: RecordEAjoPenaltyAccrualParams,
) {
  const penaltyAmount = roundMoney(params.amount)
  const penaltyDate = parseDateOnly(params.penaltyDate)

  const accrual = await tx.eAjoPenaltyAccrual.create({
    data: {
      eajoContributionPeriodId: params.eajoContributionPeriodId,
      penaltyDate,
      amount: penaltyAmount,
      journalEntryId: params.journalEntryId || null,
    },
  })

  const period = await tx.eAjoContributionPeriod.update({
    where: { id: params.eajoContributionPeriodId },
    data: {
      penaltyAssessed: { increment: penaltyAmount },
    },
  })

  return { accrual, period }
}

export interface ReverseEAjoPenaltyAccrualParams {
  eajoContributionPeriodId: string
  penaltyDate: Date | string
  reason: string
}

/**
 * Atomically reverses an E-Ajo late contribution penalty accrual.
 */
export async function reverseEAjoPenaltyAccrual(
  tx: Prisma.TransactionClient,
  params: ReverseEAjoPenaltyAccrualParams,
) {
  const penaltyDate = parseDateOnly(params.penaltyDate)

  const existing = await tx.eAjoPenaltyAccrual.findUnique({
    where: {
      eajoContributionPeriodId_penaltyDate: {
        eajoContributionPeriodId: params.eajoContributionPeriodId,
        penaltyDate,
      },
    },
  })

  if (!existing || existing.reversedAt) {
    return null
  }

  const accrual = await tx.eAjoPenaltyAccrual.update({
    where: { id: existing.id },
    data: {
      reversedAt: new Date(),
      reversalReason: params.reason,
    },
  })

  const period = await tx.eAjoContributionPeriod.update({
    where: { id: params.eajoContributionPeriodId },
    data: {
      penaltyAssessed: { decrement: existing.amount },
    },
  })

  return { accrual, period }
}

// ============================================
// QUERY HELPERS
// ============================================

export async function getLoanSchedule(
  loanId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return client.loanInstalment.findMany({
    where: { loanId },
    include: { penalties: true },
    orderBy: { instalmentNumber: 'asc' },
  })
}

export async function getSavingsSchedule(
  savingsId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return client.savingsPeriod.findMany({
    where: { savingsId },
    orderBy: { periodNumber: 'asc' },
  })
}

export async function getEAjoSchedule(
  eAjoMemberId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return client.eAjoContributionPeriod.findMany({
    where: { eajoMemberId: eAjoMemberId },
    include: { penalties: true },
    orderBy: { periodNumber: 'asc' },
  })
}
