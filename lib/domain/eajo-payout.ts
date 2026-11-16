import { Prisma } from '@/generated/prisma/client'
import { roundMoney } from '@/lib/domain/money'

export interface EAjoPayoutCalculationInput {
  monthlyContribution: Prisma.Decimal | number | string
  totalSlots: number // 4, 6, or 12
  slotNumber: number // 1 <= s <= totalSlots
  earlySlotPenaltyPercent: Prisma.Decimal | number | string
}

export interface EAjoPayoutCalculationResult {
  monthlyContribution: Prisma.Decimal
  totalSlots: number
  slotNumber: number
  expectedPayout: Prisma.Decimal
  contributionsHeld: Prisma.Decimal
  advanceAmount: Prisma.Decimal
  earlySlotPenaltyPercent: Prisma.Decimal
  earlySlotPenalty: Prisma.Decimal
  netPayout: Prisma.Decimal
}

/**
 * Calculates E-Ajo payout amounts strictly according to §2.8 and Appendix C4.
 *
 * c                = group contribution amount (per month)
 * N                = totalSlots
 * expectedPayout   = c × N
 * advanceAmount    = c × (N − s)
 * earlySlotPenalty = advanceAmount × earlySlotPenaltyPercent(s) / 100
 * netPayout        = expectedPayout − earlySlotPenalty
 */
export function calculateEAjoPayout(
  input: EAjoPayoutCalculationInput
): EAjoPayoutCalculationResult {
  const c = new Prisma.Decimal(input.monthlyContribution)
  const N = input.totalSlots
  const s = input.slotNumber
  const penaltyPct = new Prisma.Decimal(input.earlySlotPenaltyPercent)

  if (c.lte(0)) {
    throw new Error('monthlyContribution must be greater than 0')
  }
  if (!Number.isInteger(N) || N <= 0) {
    throw new Error('totalSlots must be a positive integer')
  }
  if (!Number.isInteger(s) || s < 1 || s > N) {
    throw new Error(`slotNumber must be an integer between 1 and ${N}`)
  }
  if (penaltyPct.isNegative()) {
    throw new Error('earlySlotPenaltyPercent cannot be negative')
  }

  const expectedPayout = roundMoney(c.mul(N))
  const advanceAmount = roundMoney(c.mul(N - s))
  const contributionsHeld = roundMoney(c.mul(s))
  const earlySlotPenalty = roundMoney(advanceAmount.mul(penaltyPct).div(100))
  const netPayout = roundMoney(expectedPayout.minus(earlySlotPenalty))

  return {
    monthlyContribution: c,
    totalSlots: N,
    slotNumber: s,
    expectedPayout,
    contributionsHeld,
    advanceAmount,
    earlySlotPenaltyPercent: penaltyPct,
    earlySlotPenalty,
    netPayout,
  }
}

/**
 * Calculates the cooperative's net cash funding requirement for a specific month (§2.8, Appendix C4):
 * fundingRequirement = sum(netPayout of payouts due that month) - sum(confirmed contributions received for that month)
 */
export function calculateMonthlyFundingRequirement(params: {
  payoutsDueThisMonth: Array<{ netPayout: Prisma.Decimal | number | string }>
  contributionsReceivedThisMonth: Array<{ amount: Prisma.Decimal | number | string }>
}): {
  totalPayoutsDue: Prisma.Decimal
  totalContributionsReceived: Prisma.Decimal
  netFundingRequirement: Prisma.Decimal
} {
  let totalPayouts = new Prisma.Decimal(0)
  for (const p of params.payoutsDueThisMonth) {
    totalPayouts = totalPayouts.plus(new Prisma.Decimal(p.netPayout))
  }
  totalPayouts = roundMoney(totalPayouts)

  let totalContributions = new Prisma.Decimal(0)
  for (const c of params.contributionsReceivedThisMonth) {
    totalContributions = totalContributions.plus(new Prisma.Decimal(c.amount))
  }
  totalContributions = roundMoney(totalContributions)

  const netFundingRequirement = roundMoney(totalPayouts.minus(totalContributions))

  return {
    totalPayoutsDue: totalPayouts,
    totalContributionsReceived: totalContributions,
    netFundingRequirement,
  }
}

// ---------------------------------------------------------------------------
// P3-05: slot previews, payout eligibility and the monthly funding schedule
// ---------------------------------------------------------------------------

/**
 * Builds the per-slot payout preview shown to admins (group creation) and members (join flow).
 * Every slot must have a penalty percentage (§2.8 rule 1); a missing slot throws.
 */
export function buildEAjoSlotPreviews(params: {
  monthlyContribution: Prisma.Decimal | number | string
  totalSlots: number
  slotPolicies: Array<{
    slotNumber: number
    earlySlotPenaltyPercent: Prisma.Decimal | number | string
  }>
}): EAjoPayoutCalculationResult[] {
  const bySlot = new Map(params.slotPolicies.map((p) => [p.slotNumber, p.earlySlotPenaltyPercent]))
  const previews: EAjoPayoutCalculationResult[] = []
  for (let s = 1; s <= params.totalSlots; s++) {
    const pct = bySlot.get(s)
    if (pct === undefined || pct === null) {
      throw new Error(`Missing early-slot penalty for slot ${s}`)
    }
    previews.push(
      calculateEAjoPayout({
        monthlyContribution: params.monthlyContribution,
        totalSlots: params.totalSlots,
        slotNumber: s,
        earlySlotPenaltyPercent: pct,
      }),
    )
  }
  return previews
}

export interface EAjoPeriodState {
  periodNumber: number
  dueDate: Date | string
  contributionDue: Prisma.Decimal | number | string
  contributionPaid: Prisma.Decimal | number | string
  /**
   * assessed − paid − waived late penalty on this period. Informational only: late penalties do
   * NOT block the payout (OQ-17, resolved) — they stay owed and are collected first from the
   * member's next payment, or through recovery.
   */
  penaltyOutstanding?: Prisma.Decimal | number | string
}

export type EAjoPayoutIneligibilityCode =
  | 'PAYOUT_MONTH_NOT_REACHED'
  | 'PAYOUT_MONTH_UNPAID'
  | 'EARLIER_CONTRIBUTION_OVERDUE'
  | 'SCHEDULE_MISSING'

export interface EAjoPayoutEligibility {
  eligible: boolean
  code: EAjoPayoutIneligibilityCode | null
  reason: string | null
}

function toDateKey(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10)
  return d.toISOString().slice(0, 10)
}

/**
 * Payout eligibility (§2.8 rule 4, ASSUMPTION A-09).
 *
 * A payout for slot `s` is ELIGIBLE when:
 *  1. the payout month has been reached (today ≥ due date of contribution period `s`) — slot `s`
 *     is "the month in which their payout becomes available";
 *  2. the contribution for month `s` is settled; and
 *  3. no earlier contribution is overdue.
 *
 * As the guide words it (OQ-17, resolved): only *contributions* count. Unpaid late penalties do
 * not block the payout and are not deducted from it; they remain owed on their periods. Only
 * confirmed money settles a contribution (§1.2): a receipt still in review does not.
 * Because every earlier period is due at least a month before period `s`, condition 3 means the
 * contributions for months 1..s−1 must be fully paid once the payout month is reached.
 *
 * Other participants' payments never enter this function (D-03): eligibility depends only on
 * this participant's own periods.
 */
export function evaluateEAjoPayoutEligibility(params: {
  slotNumber: number
  periods: EAjoPeriodState[]
  today: string // Lagos calendar date YYYY-MM-DD
}): EAjoPayoutEligibility {
  const { slotNumber, periods, today } = params
  const payoutPeriod = periods.find((p) => p.periodNumber === slotNumber)
  if (!payoutPeriod) {
    return {
      eligible: false,
      code: 'SCHEDULE_MISSING',
      reason: `No contribution period ${slotNumber} exists for this participant.`,
    }
  }

  const outstanding = (p: EAjoPeriodState) =>
    Prisma.Decimal.max(
      0,
      new Prisma.Decimal(p.contributionDue).minus(new Prisma.Decimal(p.contributionPaid)),
    )

  if (today < toDateKey(payoutPeriod.dueDate)) {
    return {
      eligible: false,
      code: 'PAYOUT_MONTH_NOT_REACHED',
      reason: `The payout month starts on ${toDateKey(payoutPeriod.dueDate)}.`,
    }
  }

  const earlierOverdue = periods
    .filter((p) => p.periodNumber < slotNumber)
    .filter((p) => toDateKey(p.dueDate) < today && outstanding(p).gt(0))
    .map((p) => p.periodNumber)
    .sort((a, b) => a - b)
  if (earlierOverdue.length > 0) {
    return {
      eligible: false,
      code: 'EARLIER_CONTRIBUTION_OVERDUE',
      reason: `Earlier contribution(s) still overdue: month ${earlierOverdue.join(', ')}.`,
    }
  }

  if (outstanding(payoutPeriod).gt(0)) {
    return {
      eligible: false,
      code: 'PAYOUT_MONTH_UNPAID',
      reason: `The contribution for month ${slotNumber} is not yet settled.`,
    }
  }

  return { eligible: true, code: null, reason: null }
}

export interface EAjoFundingParticipant {
  slotNumber: number
  netPayout: Prisma.Decimal | number | string
  periods: Array<{
    periodNumber: number
    contributionDue: Prisma.Decimal | number | string
    contributionPaid: Prisma.Decimal | number | string
  }>
}

export interface EAjoFundingMonth {
  month: number
  dueDate: string
  payoutCount: number
  payoutsDue: Prisma.Decimal
  expectedContributions: Prisma.Decimal
  confirmedContributions: Prisma.Decimal
  /** Σ netPayout due that month − Σ confirmed contributions for that month (§2.8 rule 6) */
  fundingRequirement: Prisma.Decimal
}

/**
 * Builds the group's monthly funding requirement (§2.8 rule 6, Appendix C4).
 *
 * Month `k` covers the payouts of every (non-cancelled) participant in slot `k` and the
 * contributions scheduled for period `k`. Callers must exclude cancelled participants: their
 * payout is never made and their contributions were returned to their wallet.
 */
export function calculateEAjoFundingSchedule(params: {
  totalSlots: number
  monthDueDates: Array<Date | string> // index 0 = month 1
  participants: EAjoFundingParticipant[]
}): EAjoFundingMonth[] {
  const rows: EAjoFundingMonth[] = []
  for (let k = 1; k <= params.totalSlots; k++) {
    const payouts = params.participants.filter((p) => p.slotNumber === k)
    const periodsForMonth = params.participants
      .map((p) => p.periods.find((x) => x.periodNumber === k))
      .filter((x): x is NonNullable<typeof x> => Boolean(x))

    const req = calculateMonthlyFundingRequirement({
      payoutsDueThisMonth: payouts.map((p) => ({ netPayout: p.netPayout })),
      contributionsReceivedThisMonth: periodsForMonth.map((x) => ({ amount: x.contributionPaid })),
    })
    const expected = roundMoney(
      periodsForMonth.reduce(
        (acc, x) => acc.plus(new Prisma.Decimal(x.contributionDue)),
        new Prisma.Decimal(0),
      ),
    )
    const due = params.monthDueDates[k - 1]
    rows.push({
      month: k,
      dueDate: due ? toDateKey(due) : '',
      payoutCount: payouts.length,
      payoutsDue: req.totalPayoutsDue,
      expectedContributions: expected,
      confirmedContributions: req.totalContributionsReceived,
      fundingRequirement: req.netFundingRequirement,
    })
  }
  return rows
}
