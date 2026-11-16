import { Prisma } from '@/generated/prisma/client'
import { PenaltyCapType } from '@/generated/prisma/enums'
import { addDays, parseDateOnly, toLagosDateString } from '@/lib/domain/dates'
import { calculatePenaltyCap } from '@/lib/domain/penalty-calculation'
import { roundMoney } from '@/lib/domain/money'

/**
 * Daily e-ajo late-payment penalties (§2.3, §2.6) — pure catch-up calculation.
 *
 *   dailyPenalty = outstandingContributionAmountAtStartOfDay × latePenaltyDailyPercent / 100
 *   accrual(d)   = min(dailyPenalty, max(0, cap − penaltiesAssessedNet for the participant))
 *
 * - Due date is day 0, days +1..+7 are grace, day +8 is the first penalty day.
 * - An accrual for day `d` exists only if the contribution was still outstanding at the END of `d`
 *   (by payment value date) and `d` is a completed day (`d ≤ throughDate`).
 * - The review shield (§2.10, A-11) suppresses day `d` while a submission that targets the period is
 *   still in review and claims `paidOn ≤ d`. Suppressed days are simply not written, so a later run
 *   (after a rejection) back-fills them — subject to the cap.
 * - The cap is per participant per group, across all of its periods. Days are processed in date
 *   order and, within a day, oldest period first.
 * - Only the late contribution is charged; penalties are never compounded. The early-slot penalty
 *   (§2.8) is a different charge and is never computed here.
 *
 * Owner decision (OQ-16, resolved 2026-11-16): for `PERCENT_OF_PRINCIPAL` caps the base is the
 * participant's total scheduled contributions `c × N` (the e-ajo equivalent of "the amount
 * borrowed"). The caller passes it as `capBase`, so changing the base is a one-line change.
 */

export interface EAjoPenaltyTerms {
  latePenaltyDailyPercent: Prisma.Decimal | number | string
  penaltyCapType: PenaltyCapType
  penaltyCapValue: Prisma.Decimal | number | string
  /** Base for PERCENT_OF_PRINCIPAL caps (owner decision OQ-16: c × N). */
  capBase: Prisma.Decimal | number | string
}

export interface EAjoPenaltyPeriodInput {
  periodId: string
  periodNumber: number
  dueDate: Date | string
  contributionDue: Prisma.Decimal | number | string
  /** Active (non-reversed) CONTRIBUTION allocations with their payment value dates. */
  contributionAllocations: Array<{ amount: Prisma.Decimal | number | string; valueDate: Date | string }>
  /** Every date that already has an accrual row (reversed or not) — the unique key forbids a second. */
  accruedDates: string[]
  /** `paidOn` dates of submissions still in review that target this period. */
  shieldPaidOnDates: string[]
}

export interface EAjoPenaltyAccrualPlan {
  periodId: string
  penaltyDate: string
  amount: Prisma.Decimal
  base: Prisma.Decimal
}

export interface EAjoPenaltyPlanResult {
  accruals: EAjoPenaltyAccrualPlan[]
  cap: Prisma.Decimal
  penaltiesAssessedNetAfter: Prisma.Decimal
  capReached: boolean
}

const key = (d: Date | string) => toLagosDateString(parseDateOnly(d))

export const EAJO_FIRST_PENALTY_DAY_OFFSET = 8

export function planEAjoPenaltyAccruals(params: {
  terms: EAjoPenaltyTerms
  /** Σ non-reversed accruals already written for this participant (waivers do not reduce it). */
  penaltiesAssessedNet: Prisma.Decimal | number | string
  periods: EAjoPenaltyPeriodInput[]
  /** Last completed Lagos day to assess (normally yesterday). */
  throughDate: string
}): EAjoPenaltyPlanResult {
  const pct = new Prisma.Decimal(params.terms.latePenaltyDailyPercent)
  const cap = calculatePenaltyCap(
    params.terms.capBase,
    params.terms.penaltyCapType,
    params.terms.penaltyCapValue,
  )
  let assessed = roundMoney(params.penaltiesAssessedNet)
  const accruals: EAjoPenaltyAccrualPlan[] = []

  if (pct.lte(0)) {
    return { accruals, cap, penaltiesAssessedNetAfter: assessed, capReached: assessed.gte(cap) }
  }

  const periods = [...params.periods].sort((a, b) => {
    const da = key(a.dueDate)
    const db = key(b.dueDate)
    if (da !== db) return da < db ? -1 : 1
    return a.periodNumber - b.periodNumber
  })

  const through = params.throughDate
  const firstDates = periods.map((p) => key(addDays(parseDateOnly(p.dueDate), EAJO_FIRST_PENALTY_DAY_OFFSET)))
  const earliest = firstDates.reduce<string | null>((acc, d) => (acc === null || d < acc ? d : acc), null)
  if (!earliest || earliest > through) {
    return { accruals, cap, penaltiesAssessedNetAfter: assessed, capReached: assessed.gte(cap) }
  }

  const accrued = periods.map((p) => new Set(p.accruedDates.map(key)))
  const allocations = periods.map((p) =>
    p.contributionAllocations.map((a) => ({ amount: new Prisma.Decimal(a.amount), date: key(a.valueDate) })),
  )
  const shields = periods.map((p) => p.shieldPaidOnDates.map(key))

  let capReached = assessed.gte(cap)
  let cursor = parseDateOnly(earliest)
  while (!capReached && key(cursor) <= through) {
    const d = key(cursor)
    for (let i = 0; i < periods.length && !capReached; i++) {
      const p = periods[i]
      if (d < firstDates[i]) continue
      if (accrued[i].has(d)) continue

      const due = new Prisma.Decimal(p.contributionDue)
      const paidByEnd = allocations[i].filter((a) => a.date <= d).reduce((s, a) => s.plus(a.amount), new Prisma.Decimal(0))
      if (due.minus(paidByEnd).lte(0)) continue

      if (shields[i].some((paidOn) => paidOn <= d)) continue

      const paidBeforeStart = allocations[i].filter((a) => a.date < d).reduce((s, a) => s.plus(a.amount), new Prisma.Decimal(0))
      const base = Prisma.Decimal.max(0, due.minus(paidBeforeStart))
      const daily = roundMoney(base.mul(pct).div(100))
      if (daily.lte(0)) continue

      const room = Prisma.Decimal.max(0, cap.minus(assessed))
      const amount = roundMoney(Prisma.Decimal.min(daily, room))
      if (amount.lte(0)) {
        capReached = true
        break
      }
      accruals.push({ periodId: p.periodId, penaltyDate: d, amount, base })
      assessed = roundMoney(assessed.plus(amount))
      if (assessed.gte(cap)) capReached = true
    }
    cursor = addDays(cursor, 1)
  }

  return { accruals, cap, penaltiesAssessedNetAfter: assessed, capReached }
}
