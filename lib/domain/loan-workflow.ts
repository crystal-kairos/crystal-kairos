import { Prisma } from '@/generated/prisma/client'
import {
  LoanStatus,
  PaymentPeriodStatus,
  PenaltyCapType,
} from '@/generated/prisma/enums'
import { roundMoney, toDecimal, type DecimalValue } from './money'
import { generateLoanSchedule } from './loan-schedule'
import { calculatePenaltyCap } from './penalty-calculation'
import { addDays, formatDateOnly, isBefore, isSameOrBefore, parseDateOnly } from './dates'

/**
 * Pure loan-workflow rules for P3-04 (§1.4, §2.1, §2.2, §2.9, §2.11, §4.1).
 * No database access: the service layer (lib/services/loans.service.ts) feeds these.
 */

const ZERO = new Prisma.Decimal(0)

/** Loan instalment grace: days +1..+7 after the due date (§1.4, §2.2). */
export const LOAN_GRACE_DAYS = 7

/** Loan states whose principal counts as exposure for capacity (§2.1). */
export const LOAN_EXPOSURE_STATUSES: readonly LoanStatus[] = [
  LoanStatus.APPROVED,
  LoanStatus.AWAITING_RECONSENT,
  LoanStatus.ACCEPTED,
  LoanStatus.DISBURSED,
  LoanStatus.ACTIVE,
  LoanStatus.OVERDUE,
  LoanStatus.DEFAULTED,
]

/** Loan states that are an offer not yet disbursed. */
export const LOAN_PRE_DISBURSEMENT_STATUSES: readonly LoanStatus[] = [
  LoanStatus.PENDING,
  LoanStatus.APPROVED,
  LoanStatus.AWAITING_RECONSENT,
  LoanStatus.ACCEPTED,
]

/** Loan states that carry a repayment schedule (disbursed and not finished). */
export const LOAN_REPAYABLE_STATUSES: readonly LoanStatus[] = [
  LoanStatus.ACTIVE,
  LoanStatus.OVERDUE,
  LoanStatus.DEFAULTED,
]

/** Loan states that end the loan; guarantees are released (§2.1). */
export const LOAN_CLOSED_STATUSES: readonly LoanStatus[] = [
  LoanStatus.REJECTED,
  LoanStatus.DECLINED,
  LoanStatus.CANCELLED,
  LoanStatus.EXPIRED,
  LoanStatus.COMPLETED,
]

// ---------------------------------------------------------------------------
// Total-cost disclosure (§2.9)
// ---------------------------------------------------------------------------

export interface LoanQuoteInput {
  principal: DecimalValue
  termMonths: number
  monthlyInterestRatePercent: DecimalValue
  latePenaltyDailyPercent: DecimalValue
  penaltyCapType: PenaltyCapType
  penaltyCapValue: DecimalValue
  applicationFee?: DecimalValue
}

export interface LoanQuote {
  principal: Prisma.Decimal
  termMonths: number
  monthlyInterestRatePercent: Prisma.Decimal
  monthlyInterest: Prisma.Decimal
  totalInterest: Prisma.Decimal
  totalScheduledRepayment: Prisma.Decimal
  /** Regular instalment (instalments 1..n-1). */
  monthlyInstalment: Prisma.Decimal
  /** Last instalment, which carries any rounding remainder. */
  finalInstalment: Prisma.Decimal
  applicationFee: Prisma.Decimal
  /** Total repayable + application fee: what the loan costs the member in all. */
  totalCostIncludingFee: Prisma.Decimal
  latePenaltyDailyPercent: Prisma.Decimal
  dailyPenaltyPerOverdueInstalment: Prisma.Decimal
  penaltyCapType: PenaltyCapType
  penaltyCapValue: Prisma.Decimal
  penaltyCapAmount: Prisma.Decimal
  graceDays: number
}

/**
 * Prices a loan for the application form, the admin review and the offer (§2.9).
 * Penalty base is the original principal (A-02); the cap is per loan (§2.2).
 */
export function quoteLoan(input: LoanQuoteInput): LoanQuote {
  const schedule = generateLoanSchedule({
    principal: input.principal,
    termMonths: input.termMonths,
    monthlyInterestRatePercent: input.monthlyInterestRatePercent,
    anchorDate: '2000-01-31', // due dates are irrelevant for pricing
  })
  const fee = roundMoney(input.applicationFee ?? 0)
  const dailyPct = toDecimal(input.latePenaltyDailyPercent)
  const first = schedule.instalments[0]
  const last = schedule.instalments[schedule.instalments.length - 1]

  return {
    principal: schedule.principal,
    termMonths: schedule.termMonths,
    monthlyInterestRatePercent: schedule.monthlyInterestRatePercent,
    monthlyInterest: schedule.monthlyInterest,
    totalInterest: schedule.totalInterest,
    totalScheduledRepayment: schedule.totalScheduledRepayment,
    monthlyInstalment: first.totalDue,
    finalInstalment: last.totalDue,
    applicationFee: fee,
    totalCostIncludingFee: schedule.totalScheduledRepayment.plus(fee),
    latePenaltyDailyPercent: dailyPct,
    dailyPenaltyPerOverdueInstalment: roundMoney(
      schedule.principal.times(dailyPct).dividedBy(100),
    ),
    penaltyCapType: input.penaltyCapType,
    penaltyCapValue: toDecimal(input.penaltyCapValue),
    penaltyCapAmount: calculatePenaltyCap(
      schedule.principal,
      input.penaltyCapType,
      input.penaltyCapValue,
    ),
    graceDays: LOAN_GRACE_DAYS,
  }
}

/**
 * Plain-language summary of penalty and recovery terms, used in consent and
 * offer evidence so the PDF records exactly what the member agreed to.
 */
export function describeLoanTerms(quote: LoanQuote): string {
  const cap =
    quote.penaltyCapType === PenaltyCapType.PERCENT_OF_PRINCIPAL
      ? `${quote.penaltyCapValue.toString()}% of principal (N${quote.penaltyCapAmount.toFixed(2)})`
      : `fixed N${quote.penaltyCapAmount.toFixed(2)}`
  return [
    `Monthly instalment N${quote.monthlyInstalment.toFixed(2)} (last N${quote.finalInstalment.toFixed(2)})`,
    `total interest N${quote.totalInterest.toFixed(2)}`,
    `application fee N${quote.applicationFee.toFixed(2)}`,
    `total repayable N${quote.totalScheduledRepayment.toFixed(2)}`,
    `late penalty ${quote.latePenaltyDailyPercent.toString()}% of principal per overdue instalment per day from day ${quote.graceDays + 1} after the due date, capped at ${cap} per loan`,
    'overdue amounts may be recovered from the borrower\'s savings and then the guarantor after a final notice and admin approval',
  ].join('; ')
}

// ---------------------------------------------------------------------------
// Instalment balances, settlement quote (§2.11, A-23)
// ---------------------------------------------------------------------------

export interface InstalmentBalanceInput {
  id?: string
  instalmentNumber: number
  dueDate: Date | string
  principalDue: DecimalValue
  interestDue: DecimalValue
  principalPaid: DecimalValue
  interestPaid: DecimalValue
  penaltyAssessed: DecimalValue
  penaltyPaid: DecimalValue
  penaltyWaived: DecimalValue
}

export interface InstalmentOutstanding {
  principal: Prisma.Decimal
  interest: Prisma.Decimal
  penalty: Prisma.Decimal
  total: Prisma.Decimal
  paid: Prisma.Decimal
}

export function instalmentOutstanding(i: InstalmentBalanceInput): InstalmentOutstanding {
  const principal = Prisma.Decimal.max(ZERO, toDecimal(i.principalDue).minus(toDecimal(i.principalPaid)))
  const interest = Prisma.Decimal.max(ZERO, toDecimal(i.interestDue).minus(toDecimal(i.interestPaid)))
  const penalty = Prisma.Decimal.max(
    ZERO,
    toDecimal(i.penaltyAssessed).minus(toDecimal(i.penaltyPaid)).minus(toDecimal(i.penaltyWaived)),
  )
  const paid = toDecimal(i.principalPaid).plus(toDecimal(i.interestPaid)).plus(toDecimal(i.penaltyPaid))
  return { principal, interest, penalty, total: principal.plus(interest).plus(penalty), paid }
}

export interface SettlementQuote {
  remainingPrincipal: Prisma.Decimal
  remainingInterest: Prisma.Decimal
  unpaidPenalties: Prisma.Decimal
  total: Prisma.Decimal
}

/**
 * Early-settlement quote (§2.11, A-23, D-11): remaining principal + remaining
 * interest + unpaid assessed penalties (net of waivers). No rebate.
 */
// ASSUMPTION A-23
export function computeSettlementQuote(instalments: InstalmentBalanceInput[]): SettlementQuote {
  let remainingPrincipal = ZERO
  let remainingInterest = ZERO
  let unpaidPenalties = ZERO
  for (const inst of instalments) {
    const o = instalmentOutstanding(inst)
    remainingPrincipal = remainingPrincipal.plus(o.principal)
    remainingInterest = remainingInterest.plus(o.interest)
    unpaidPenalties = unpaidPenalties.plus(o.penalty)
  }
  return {
    remainingPrincipal,
    remainingInterest,
    unpaidPenalties,
    total: remainingPrincipal.plus(remainingInterest).plus(unpaidPenalties),
  }
}

/** Principal still owed on a disbursed loan = approved principal − principal repaid. */
export function principalOutstanding(
  approvedPrincipal: DecimalValue,
  instalments: Pick<InstalmentBalanceInput, 'principalPaid'>[],
): Prisma.Decimal {
  let repaid = ZERO
  for (const i of instalments) repaid = repaid.plus(toDecimal(i.principalPaid))
  return Prisma.Decimal.max(ZERO, toDecimal(approvedPrincipal).minus(repaid))
}

// ---------------------------------------------------------------------------
// Derived statuses (§2.10, §4.1)
// ---------------------------------------------------------------------------

/** First penalty day / loan "overdue" day: dueDate + 8 (§2.2). */
export function firstPenaltyDate(dueDate: Date | string): Date {
  return addDays(dueDate, LOAN_GRACE_DAYS + 1)
}

export interface InstalmentStatusInput extends InstalmentBalanceInput {
  status?: PaymentPeriodStatus
}

/**
 * Derives an instalment status from its balances (statuses are never hand-edited):
 * COMPLETED when nothing is outstanding; WAIVED is kept; IN_REVIEW while a receipt
 * for it is awaiting review (review shield, §2.10); OVERDUE after the due date;
 * ONGOING when partly paid; otherwise PENDING.
 */
export function deriveInstalmentStatus(
  inst: InstalmentStatusInput,
  params: { today: string; inReview: boolean },
): PaymentPeriodStatus {
  const o = instalmentOutstanding(inst)
  if (o.total.lte(0)) return PaymentPeriodStatus.COMPLETED
  if (inst.status === PaymentPeriodStatus.WAIVED) return PaymentPeriodStatus.WAIVED
  if (params.inReview) return PaymentPeriodStatus.IN_REVIEW
  if (isBefore(inst.dueDate, params.today)) return PaymentPeriodStatus.OVERDUE
  if (o.paid.gt(0)) return PaymentPeriodStatus.ONGOING
  return PaymentPeriodStatus.PENDING
}

/**
 * Derives the status of a disbursed loan from its instalments (§4.1):
 * - COMPLETED when every instalment's principal, interest and assessed
 *   penalties (net of waivers) are settled;
 * - OVERDUE when an unpaid, unshielded instalment has passed its grace period
 *   (day +8 onwards);
 * - otherwise ACTIVE. DEFAULTED is only left by completion (recovery, P3-06B).
 */
export function deriveLoanStatus(params: {
  currentStatus: LoanStatus
  instalments: InstalmentStatusInput[]
  today: string
  /** instalment ids (or numbers) currently shielded by a receipt under review */
  shieldedInstalments?: Set<string | number>
}): LoanStatus {
  const { currentStatus, instalments, today } = params
  if (!LOAN_REPAYABLE_STATUSES.includes(currentStatus)) return currentStatus
  if (instalments.length === 0) return currentStatus

  const allSettled = instalments.every((i) => instalmentOutstanding(i).total.lte(0))
  if (allSettled) return LoanStatus.COMPLETED
  if (currentStatus === LoanStatus.DEFAULTED) return LoanStatus.DEFAULTED

  const shielded = params.shieldedInstalments ?? new Set()
  const overdue = instalments.some((i) => {
    if (instalmentOutstanding(i).total.lte(0)) return false
    if (shielded.has(i.id ?? i.instalmentNumber)) return false
    return isSameOrBefore(firstPenaltyDate(i.dueDate), today)
  })
  return overdue ? LoanStatus.OVERDUE : LoanStatus.ACTIVE
}

// ---------------------------------------------------------------------------
// Approval rules (§1.4, §2.7, D-07, D-10)
// ---------------------------------------------------------------------------

export interface ApprovalTermsCheck {
  requestedAmount: DecimalValue
  consentedAmount: DecimalValue
  approvedAmount: DecimalValue
  requestedTermMonths: number
  approvedTermMonths: number
}

/**
 * Validates an approval against the request and the guarantor's consent and
 * says whether re-consent is needed. The approved amount can never exceed the
 * requested amount or the consented amount; any change in amount or term
 * (and therefore rate) needs borrower acceptance and guarantor re-consent.
 */
export function evaluateApprovalTerms(input: ApprovalTermsCheck):
  | { ok: true; termsChanged: boolean }
  | { ok: false; reason: string } {
  const approved = roundMoney(input.approvedAmount)
  if (approved.lte(0)) return { ok: false, reason: 'The approved amount must be greater than zero.' }
  if (approved.gt(toDecimal(input.requestedAmount))) {
    return { ok: false, reason: 'The approved amount cannot exceed the amount the member requested.' }
  }
  if (approved.gt(toDecimal(input.consentedAmount))) {
    return { ok: false, reason: 'The approved amount cannot exceed the amount the guarantor consented to.' }
  }
  if (!Number.isInteger(input.approvedTermMonths) || input.approvedTermMonths < 1 || input.approvedTermMonths > 12) {
    return { ok: false, reason: 'The loan term must be between 1 and 12 months.' }
  }
  const termsChanged =
    !approved.equals(roundMoney(input.requestedAmount)) ||
    input.approvedTermMonths !== input.requestedTermMonths
  return { ok: true, termsChanged }
}

/**
 * Maximum new principal the member may request (§2.1, C3):
 * standaloneLimit + support already reserved for the applicant's own loans
 * + the chosen guarantor's free capacity − current loan exposure.
 */
export function maxNewLoanPrincipal(params: {
  standaloneLimit: DecimalValue
  existingExposure: DecimalValue
  existingOwnLoanSupport: DecimalValue
  guarantorFreeCapacity: DecimalValue
}): Prisma.Decimal {
  const max = toDecimal(params.standaloneLimit)
    .plus(toDecimal(params.existingOwnLoanSupport))
    .plus(toDecimal(params.guarantorFreeCapacity))
    .minus(toDecimal(params.existingExposure))
  return roundMoney(Prisma.Decimal.max(ZERO, max))
}

/** Lagos calendar date string of a @db.Date value. */
export function dateOnlyString(d: Date | string): string {
  return formatDateOnly(parseDateOnly(d))
}
