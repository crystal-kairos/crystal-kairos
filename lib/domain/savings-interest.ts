/**
 * Savings interest and forfeiture rules (§2.5, §2.6, D-17, A-07). Pure functions, no I/O.
 *
 * - Each confirmed deposit allocation is an immutable principal lot with its own value date.
 * - The snapshotted rate is the simple interest percentage for the FULL term.
 * - Interest is linear per lot, never compounded, never accrued after maturity.
 * - Full Decimal precision is kept in intermediate steps; rounding (half-up, 2dp) happens
 *   only when an amount is posted.
 */
import { Prisma } from '@/generated/prisma/client'
import { roundMoney, toDecimal, type DecimalValue } from '@/lib/domain/money'
import {
  addDays,
  addMonthsClamped,
  diffDays,
  formatDateOnly,
  isBefore,
  isSameOrBefore,
  parseDateOnly,
} from '@/lib/domain/dates'

type DateInput = Date | string

/** Last day of grace for a period due on `dueDate` (day +7). Forfeiture applies from day +8. */
export const SAVINGS_GRACE_DAYS = 7

export interface LotInterestInput {
  principal: DecimalValue
  ratePercent: DecimalValue
  lotValueDate: DateInput
  planStartDate: DateInput
  maturityDate: DateInput
}

/** Lagos calendar days the lot is held before maturity (never negative). */
export function lotEligibleDays(lotValueDate: DateInput, maturityDate: DateInput): number {
  return Math.max(0, diffDays(lotValueDate, maturityDate))
}

/** Calendar days in the plan's term (at least 1). */
export function planTermDays(planStartDate: DateInput, maturityDate: DateInput): number {
  return Math.max(1, diffDays(planStartDate, maturityDate))
}

/**
 * lotInterest = principal × rate / 100 × min(eligibleDays / termDays, 1)   (unrounded)
 */
export function lotInterest(input: LotInterestInput): Prisma.Decimal {
  const eligibleDays = lotEligibleDays(input.lotValueDate, input.maturityDate)
  const termDays = planTermDays(input.planStartDate, input.maturityDate)
  const heldFraction = Prisma.Decimal.min(
    new Prisma.Decimal(eligibleDays).dividedBy(termDays),
    1,
  )
  return toDecimal(input.principal)
    .times(toDecimal(input.ratePercent))
    .dividedBy(100)
    .times(heldFraction)
}

/**
 * accruedToDate(lot, d) = lotInterest × min(1, max(0, d − valueDate) / eligibleDays)   (unrounded)
 */
export function accruedToDate(input: LotInterestInput & { asOf: DateInput }): Prisma.Decimal {
  const eligibleDays = lotEligibleDays(input.lotValueDate, input.maturityDate)
  if (eligibleDays === 0) return new Prisma.Decimal(0)
  const heldDays = Math.max(0, diffDays(input.lotValueDate, input.asOf))
  const fraction = Prisma.Decimal.min(new Prisma.Decimal(heldDays).dividedBy(eligibleDays), 1)
  return lotInterest(input).times(fraction)
}

/**
 * monthlyPosting = round(accruedToDate(lot, d)) − sum(previous active postings).
 * Rounding the cumulative figure (not each month's delta) makes the postings sum exactly to
 * round(lotInterest) at maturity. Never negative.
 */
export function monthlyPosting(
  input: LotInterestInput & { asOf: DateInput; previousPostings: DecimalValue },
): Prisma.Decimal {
  const cumulative = roundMoney(accruedToDate(input))
  const delta = cumulative.minus(toDecimal(input.previousPostings))
  return Prisma.Decimal.max(0, delta)
}

/** Last calendar day of the month containing `date`. */
export function endOfMonth(date: DateInput): Date {
  const d = parseDateOnly(date)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
}

/**
 * Accrual dates for a lot up to `asOf` (inclusive): every last Lagos day of a month strictly
 * after the lot's value date and strictly before maturity, plus the maturity date itself.
 * Dates after `asOf` are omitted, which is what makes catch-up of missed months work.
 */
export function accrualDatesForLot(params: {
  lotValueDate: DateInput
  maturityDate: DateInput
  asOf: DateInput
}): Date[] {
  const maturity = parseDateOnly(params.maturityDate)
  const dates: Date[] = []
  let monthEnd = endOfMonth(params.lotValueDate)
  while (isBefore(monthEnd, maturity) && isSameOrBefore(monthEnd, params.asOf)) {
    if (isBefore(params.lotValueDate, monthEnd)) dates.push(monthEnd)
    monthEnd = endOfMonth(addDays(monthEnd, 1))
  }
  if (isSameOrBefore(maturity, params.asOf) && isBefore(params.lotValueDate, maturity)) {
    dates.push(maturity)
  }
  return dates
}

/** Maturity date of a plan that starts on `startDate` (the first deposit's value date). */
export function savingsMaturityDate(startDate: DateInput, durationMonths: number): Date {
  return addMonthsClamped(startDate, durationMonths)
}

/** The last grace day (day +7) of a regular-savings period. */
export function periodGraceEnd(dueDate: DateInput): Date {
  return addDays(dueDate, SAVINGS_GRACE_DAYS)
}

export interface PeriodForfeitureInput {
  dueDate: DateInput
  amountDue: DecimalValue
  /** Active (non-reversed) allocations to the period with their payment value dates. */
  allocations: { amount: DecimalValue; valueDate: DateInput }[]
  /** Claimed `paidOn` of submissions still in review (SUBMITTED) that target the period. */
  pendingSubmissionPaidOn: DateInput[]
  asOf: DateInput
}

export type PeriodForfeitureState =
  | 'NOT_YET_DUE' // the day +8 boundary has not been reached
  | 'PAID_IN_GRACE' // fully paid by value date on or before day +7
  | 'SHIELDED' // a receipt claiming payment by day +7 is still in review (A-11)
  | 'FORFEITED'

/**
 * §2.5 regular-savings forfeiture: a period unpaid or part-paid at the end of day +7 forfeits
 * the interest of that period's lots only. Value dates (not confirmation dates) decide, so a
 * value-date correction can clear a forfeiture. While a receipt that claims a timely payment is
 * in review, forfeiture is suppressed (review shield, A-11) and re-evaluated on the outcome.
 */
export function evaluatePeriodForfeiture(input: PeriodForfeitureInput): PeriodForfeitureState {
  const graceEnd = periodGraceEnd(input.dueDate)
  if (!isBefore(graceEnd, input.asOf)) return 'NOT_YET_DUE'

  const paidByGraceEnd = input.allocations
    .filter((a) => isSameOrBefore(a.valueDate, graceEnd))
    .reduce((sum, a) => sum.plus(toDecimal(a.amount)), new Prisma.Decimal(0))
  if (paidByGraceEnd.gte(toDecimal(input.amountDue))) return 'PAID_IN_GRACE'

  if (input.pendingSubmissionPaidOn.some((paidOn) => isSameOrBefore(paidOn, graceEnd))) {
    return 'SHIELDED'
  }
  return 'FORFEITED'
}

/** Convenience for logs/audit metadata. */
export function toIsoDate(date: DateInput): string {
  return formatDateOnly(parseDateOnly(date))
}
