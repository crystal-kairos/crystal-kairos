import { describe, it, expect } from 'vitest'
import { Prisma } from '@/generated/prisma/client'
import {
  calculateEAjoPayout,
  calculateMonthlyFundingRequirement,
} from '@/lib/domain/eajo-payout'
import { c4EajoPayoutFixture } from '@/tests/golden/c4-eajo-payout.fixture'

describe('PR P2-05: E-Ajo Payout & Monthly Funding Requirement Unit Tests (§2.8, Appendix C4)', () => {
  const { input, expected } = c4EajoPayoutFixture

  it('reproduces owner worked example (Appendix C4): c = 10k, N = 12, s = 2, 10% penalty -> 110,000 net payout', () => {
    const res = calculateEAjoPayout({
      monthlyContribution: input.monthlyContribution,
      totalSlots: input.totalSlots,
      slotNumber: input.payoutSlot,
      earlySlotPenaltyPercent: input.earlySlotPenaltyPercent,
    })

    expect(res.expectedPayout.equals(expected.expectedPayout)).toBe(true) // 120,000
    expect(res.contributionsHeld.equals(expected.contributionsHeld)).toBe(true) // 20,000
    expect(res.advanceAmount.equals(expected.advanceAmount)).toBe(true) // 100,000
    expect(res.earlySlotPenalty.equals(expected.earlySlotPenaltyAmount)).toBe(true) // 10,000
    expect(res.netPayout.equals(expected.netPayout)).toBe(true) // 110,000
  })

  it('calculates Slot 1 with 15% penalty -> 103,500 net payout', () => {
    const res = calculateEAjoPayout({
      monthlyContribution: 10000,
      totalSlots: 12,
      slotNumber: 1,
      earlySlotPenaltyPercent: 15,
    })

    expect(res.expectedPayout.equals(120000)).toBe(true)
    expect(res.advanceAmount.equals(110000)).toBe(true)
    expect(res.earlySlotPenalty.equals(16500)).toBe(true)
    expect(res.netPayout.equals(103500)).toBe(true)
  })

  it('calculates Slot 12 with 0% penalty -> 120,000 net payout (advance = 0)', () => {
    const res = calculateEAjoPayout({
      monthlyContribution: 10000,
      totalSlots: 12,
      slotNumber: 12,
      earlySlotPenaltyPercent: 0,
    })

    expect(res.advanceAmount.equals(0)).toBe(true)
    expect(res.earlySlotPenalty.equals(0)).toBe(true)
    expect(res.netPayout.equals(120000)).toBe(true)
  })

  it('calculates month 2 funding requirement (2 in slot 2, 1 in slot 12 -> 190,000 requirement)', () => {
    const req = calculateMonthlyFundingRequirement({
      payoutsDueThisMonth: [{ netPayout: 110000 }, { netPayout: 110000 }],
      contributionsReceivedThisMonth: [{ amount: 10000 }, { amount: 10000 }, { amount: 10000 }],
    })

    expect(req.totalPayoutsDue.equals(expected.month2CashRequirement.slot2Disbursements)).toBe(true) // 220,000
    expect(
      req.totalContributionsReceived.equals(expected.month2CashRequirement.totalMonthContributions)
    ).toBe(true) // 30,000
    expect(
      req.netFundingRequirement.equals(expected.month2CashRequirement.netCashRequired)
    ).toBe(true) // 190,000
  })

  it('rejects invalid slot numbers or negative penalty percentages', () => {
    expect(() =>
      calculateEAjoPayout({
        monthlyContribution: 10000,
        totalSlots: 6,
        slotNumber: 7, // > totalSlots
        earlySlotPenaltyPercent: 5,
      })
    ).toThrow('slotNumber must be an integer between 1 and 6')

    expect(() =>
      calculateEAjoPayout({
        monthlyContribution: 10000,
        totalSlots: 6,
        slotNumber: 0, // < 1
        earlySlotPenaltyPercent: 5,
      })
    ).toThrow('slotNumber must be an integer between 1 and 6')

    expect(() =>
      calculateEAjoPayout({
        monthlyContribution: 10000,
        totalSlots: 6,
        slotNumber: 3,
        earlySlotPenaltyPercent: -5,
      })
    ).toThrow('earlySlotPenaltyPercent cannot be negative')
  })
})
