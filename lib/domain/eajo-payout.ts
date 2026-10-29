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
