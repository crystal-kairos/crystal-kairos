import { describe, it, expect } from 'vitest'
import { PenaltyCapType } from '@/generated/prisma/enums'
import {
  buildEAjoSlotPreviews,
  calculateEAjoFundingSchedule,
  evaluateEAjoPayoutEligibility,
} from '@/lib/domain/eajo-payout'
import { planEAjoPenaltyAccruals } from '@/lib/domain/eajo-penalty'
import { c4EajoPayoutFixture } from '@/tests/golden/c4-eajo-payout.fixture'

const period = (n: number, due: string, paid: number, penalty = 0) => ({
  periodNumber: n,
  dueDate: due,
  contributionDue: 10000,
  contributionPaid: paid,
  penaltyOutstanding: penalty,
})

describe('P3-05 e-ajo domain rules', () => {
  it('builds per-slot previews and refuses a missing slot penalty (§2.8 rule 1)', () => {
    const previews = buildEAjoSlotPreviews({
      monthlyContribution: 10000,
      totalSlots: 12,
      slotPolicies: Array.from({ length: 12 }, (_, i) => ({
        slotNumber: i + 1,
        earlySlotPenaltyPercent: i === 0 ? 15 : i === 1 ? 10 : i === 11 ? 0 : 5,
      })),
    })
    expect(previews[0].netPayout.toFixed(2)).toBe('103500.00')
    expect(previews[1].netPayout.toFixed(2)).toBe('110000.00')
    expect(previews[11].netPayout.toFixed(2)).toBe('120000.00')
    expect(() =>
      buildEAjoSlotPreviews({ monthlyContribution: 10000, totalSlots: 4, slotPolicies: [{ slotNumber: 1, earlySlotPenaltyPercent: 0 }] }),
    ).toThrow(/slot 2/)
  })

  describe('payout eligibility (A-09)', () => {
    const periods = [period(1, '2027-01-10', 10000), period(2, '2027-02-10', 10000), period(3, '2027-03-10', 0)]

    it('is not eligible before the payout month', () => {
      const r = evaluateEAjoPayoutEligibility({ slotNumber: 2, periods, today: '2027-02-09' })
      expect(r).toMatchObject({ eligible: false, code: 'PAYOUT_MONTH_NOT_REACHED' })
    })
    it('is eligible from the payout month once month s and earlier months are settled', () => {
      expect(evaluateEAjoPayoutEligibility({ slotNumber: 2, periods, today: '2027-02-10' }).eligible).toBe(true)
    })
    it('blocks while month s is unpaid', () => {
      const r = evaluateEAjoPayoutEligibility({
        slotNumber: 2,
        periods: [period(1, '2027-01-10', 10000), period(2, '2027-02-10', 5000)],
        today: '2027-02-12',
      })
      expect(r.code).toBe('PAYOUT_MONTH_UNPAID')
    })
    it('blocks while an earlier contribution is overdue', () => {
      expect(
        evaluateEAjoPayoutEligibility({
          slotNumber: 2,
          periods: [period(1, '2027-01-10', 0), period(2, '2027-02-10', 10000)],
          today: '2027-02-10',
        }).code,
      ).toBe('EARLIER_CONTRIBUTION_OVERDUE')
    })
    it('does not block on unpaid late penalties once the contributions are paid (OQ-12)', () => {
      expect(
        evaluateEAjoPayoutEligibility({
          slotNumber: 2,
          periods: [period(1, '2027-01-10', 10000, 300), period(2, '2027-02-10', 10000, 100)],
          today: '2027-02-10',
        }).eligible,
      ).toBe(true)
    })
  })

  it('reproduces the C4 funding requirement: month 2 = 220,000 − 30,000 = 190,000', () => {
    const paidMonths = (months: number[]) =>
      Array.from({ length: 12 }, (_, i) => ({
        periodNumber: i + 1,
        contributionDue: 10000,
        contributionPaid: months.includes(i + 1) ? 10000 : 0,
      }))
    const rows = calculateEAjoFundingSchedule({
      totalSlots: 12,
      monthDueDates: Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, '0')}-10`),
      participants: [
        { slotNumber: 2, netPayout: 110000, periods: paidMonths([1, 2]) },
        { slotNumber: 2, netPayout: 110000, periods: paidMonths([1, 2]) },
        { slotNumber: 12, netPayout: 120000, periods: paidMonths([1, 2]) },
      ],
    })
    const month2 = rows[1]
    const expected = c4EajoPayoutFixture.expected.month2CashRequirement
    expect(month2.payoutsDue.equals(expected.slot2Disbursements)).toBe(true)
    expect(month2.confirmedContributions.equals(expected.totalMonthContributions)).toBe(true)
    expect(month2.fundingRequirement.equals(expected.netCashRequired)).toBe(true)
    expect(month2.payoutCount).toBe(2)
    expect(rows[11].payoutsDue.toFixed(2)).toBe('120000.00')
    expect(rows[2].fundingRequirement.toFixed(2)).toBe('0.00') // nothing due, nothing paid for month 3
  })

  describe('late penalty plan (§2.3)', () => {
    const terms = {
      latePenaltyDailyPercent: 1,
      penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
      penaltyCapValue: 10, // 10% of c × N = 12,000
      capBase: 120000,
    }
    const base = {
      periodId: 'p1',
      periodNumber: 1,
      dueDate: '2027-02-10',
      contributionDue: 10000,
      contributionAllocations: [] as { amount: number; valueDate: string }[],
      accruedDates: [] as string[],
      shieldPaidOnDates: [] as string[],
    }

    it('starts on day +8 and stops accruing on the value date of the payment', () => {
      const plan = planEAjoPenaltyAccruals({
        terms,
        penaltiesAssessedNet: 0,
        throughDate: '2027-02-25',
        periods: [{ ...base, contributionAllocations: [{ amount: 10000, valueDate: '2027-02-20' }] }],
      })
      // Outstanding at the end of 18 and 19 Feb only (C2 pattern)
      expect(plan.accruals.map((a) => a.penaltyDate)).toEqual(['2027-02-18', '2027-02-19'])
      expect(plan.accruals.every((a) => a.amount.toFixed(2) === '100.00')).toBe(true)
    })

    it('charges on the outstanding amount at the start of the day after a part-payment', () => {
      const plan = planEAjoPenaltyAccruals({
        terms,
        penaltiesAssessedNet: 0,
        throughDate: '2027-02-19',
        periods: [{ ...base, contributionAllocations: [{ amount: 4000, valueDate: '2027-02-18' }] }],
      })
      expect(plan.accruals.map((a) => [a.penaltyDate, a.amount.toFixed(2)])).toEqual([
        ['2027-02-18', '100.00'],
        ['2027-02-19', '60.00'],
      ])
    })

    it('suppresses shielded days and skips days already written', () => {
      const plan = planEAjoPenaltyAccruals({
        terms,
        penaltiesAssessedNet: 100,
        throughDate: '2027-02-21',
        periods: [{ ...base, accruedDates: ['2027-02-18'], shieldPaidOnDates: ['2027-02-20'] }],
      })
      expect(plan.accruals.map((a) => a.penaltyDate)).toEqual(['2027-02-19'])
    })

    it('stops at the cap across periods, oldest period first', () => {
      const plan = planEAjoPenaltyAccruals({
        terms: { ...terms, penaltyCapType: PenaltyCapType.FIXED_AMOUNT, penaltyCapValue: 150 },
        penaltiesAssessedNet: 0,
        throughDate: '2027-03-31',
        periods: [base, { ...base, periodId: 'p2', periodNumber: 2, dueDate: '2027-03-10' }],
      })
      expect(plan.accruals.map((a) => [a.periodId, a.amount.toFixed(2)])).toEqual([
        ['p1', '100.00'],
        ['p1', '50.00'],
      ])
      expect(plan.capReached).toBe(true)
    })
  })
})
