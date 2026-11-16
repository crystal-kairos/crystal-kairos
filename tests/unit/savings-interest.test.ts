import { describe, expect, it } from 'vitest'
import { Prisma } from '@/generated/prisma/client'
import { roundMoney } from '@/lib/domain/money'
import {
  accrualDatesForLot,
  accruedToDate,
  evaluatePeriodForfeiture,
  lotInterest,
  monthlyPosting,
  savingsMaturityDate,
  toIsoDate,
} from '@/lib/domain/savings-interest'
import { c5SavingsInterestFixture as c5 } from '../golden/c5-savings-interest.fixture'

const plan = {
  ratePercent: c5.input.termRatePercent,
  planStartDate: c5.input.startDate,
  maturityDate: c5.input.maturityDate,
}

describe('savings interest (§2.5, Appendix C5)', () => {
  it('maturity is addMonthsClamped(start, durationMonths)', () => {
    expect(toIsoDate(savingsMaturityDate('2027-01-01', 6))).toBe('2027-07-01')
    expect(toIsoDate(savingsMaturityDate('2027-01-31', 1))).toBe('2027-02-28')
    expect(toIsoDate(savingsMaturityDate('2028-01-31', 1))).toBe('2028-02-29')
  })

  it('reproduces lot interest for lots A and B and the total at maturity', () => {
    const a = lotInterest({ ...plan, principal: c5.input.lotA.depositAmount, lotValueDate: c5.input.lotA.valueDate })
    const b = lotInterest({ ...plan, principal: c5.input.lotB.depositAmount, lotValueDate: c5.input.lotB.valueDate })
    expect(roundMoney(a)).toEqual(c5.expected.lotAInterest)
    expect(roundMoney(b)).toEqual(c5.expected.lotBInterest)
    const total = c5.input.lotA.depositAmount
      .plus(c5.input.lotB.depositAmount)
      .plus(roundMoney(a))
      .plus(roundMoney(b))
    expect(total).toEqual(c5.expected.totalMaturityPayable)
  })

  it('reproduces lot A monthly postings (31 Jan, 28 Feb)', () => {
    const lot = { ...plan, principal: c5.input.lotA.depositAmount, lotValueDate: c5.input.lotA.valueDate }
    const jan = monthlyPosting({ ...lot, asOf: '2027-01-31', previousPostings: 0 })
    expect(jan).toEqual(c5.expected.lotALinearMonthlyPostings.jan31Posting)
    expect(roundMoney(accruedToDate({ ...lot, asOf: '2027-02-28' }))).toEqual(
      c5.expected.lotALinearMonthlyPostings.feb28AccruedToDate,
    )
    const feb = monthlyPosting({ ...lot, asOf: '2027-02-28', previousPostings: jan })
    expect(feb).toEqual(c5.expected.lotALinearMonthlyPostings.feb28Posting)
  })

  it('all monthly postings of a lot sum exactly to its interest at maturity', () => {
    for (const lotDef of [c5.input.lotA, c5.input.lotB, { depositAmount: new Prisma.Decimal('33333.33'), valueDate: '2027-02-17' }]) {
      const lot = { ...plan, principal: lotDef.depositAmount, lotValueDate: lotDef.valueDate }
      const dates = accrualDatesForLot({ lotValueDate: lotDef.valueDate, maturityDate: plan.maturityDate, asOf: '2030-01-01' })
      let sum = new Prisma.Decimal(0)
      for (const d of dates) sum = sum.plus(monthlyPosting({ ...lot, asOf: d, previousPostings: sum }))
      expect(sum).toEqual(roundMoney(lotInterest(lot)))
      // Accruing again after maturity adds nothing.
      expect(monthlyPosting({ ...lot, asOf: '2027-12-31', previousPostings: sum }).toNumber()).toBe(0)
    }
  })

  it('a missed month is caught up: one run on 28 Feb posts both month-ends once', () => {
    const dates = accrualDatesForLot({ lotValueDate: '2027-01-01', maturityDate: '2027-07-01', asOf: '2027-02-28' })
    expect(dates.map(toIsoDate)).toEqual(['2027-01-31', '2027-02-28'])
    const all = accrualDatesForLot({ lotValueDate: '2027-01-01', maturityDate: '2027-07-01', asOf: '2027-08-01' })
    expect(all.map(toIsoDate)).toEqual([
      '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30', '2027-07-01',
    ])
  })

  it('a lot deposited on a month end does not accrue on its own value date', () => {
    const dates = accrualDatesForLot({ lotValueDate: '2027-03-31', maturityDate: '2027-07-01', asOf: '2027-04-30' })
    expect(dates.map(toIsoDate)).toEqual(['2027-04-30'])
  })

  it('regular plan C5: on-time (8 Mar) lot earns 1,524.86; a 9 Mar payment forfeits the period', () => {
    const f = c5.expected.regularSavingsForfeiture
    const interest = lotInterest({ ...plan, principal: 20000, lotValueDate: f.onTimePaymentDate })
    expect(roundMoney(interest)).toEqual(f.onTimeInterestEarned)

    const base = { dueDate: f.periodDue, amountDue: 20000, pendingSubmissionPaidOn: [], asOf: '2027-03-20' }
    expect(evaluatePeriodForfeiture({ ...base, allocations: [{ amount: 20000, valueDate: '2027-03-08' }] })).toBe('PAID_IN_GRACE')
    expect(evaluatePeriodForfeiture({ ...base, allocations: [{ amount: 20000, valueDate: '2027-03-09' }] })).toBe('FORFEITED')
  })

  it('forfeiture boundaries: day +7 is grace, day +8 forfeits, partial payment forfeits, shield suppresses', () => {
    const base = { dueDate: '2027-03-01', amountDue: 20000, allocations: [], pendingSubmissionPaidOn: [] }
    expect(evaluatePeriodForfeiture({ ...base, asOf: '2027-03-08' })).toBe('NOT_YET_DUE')
    expect(evaluatePeriodForfeiture({ ...base, asOf: '2027-03-09' })).toBe('FORFEITED')
    expect(
      evaluatePeriodForfeiture({ ...base, asOf: '2027-03-09', allocations: [{ amount: 19999.99, valueDate: '2027-03-02' }] }),
    ).toBe('FORFEITED')
    expect(evaluatePeriodForfeiture({ ...base, asOf: '2027-03-20', pendingSubmissionPaidOn: ['2027-03-08'] })).toBe('SHIELDED')
    expect(evaluatePeriodForfeiture({ ...base, asOf: '2027-03-20', pendingSubmissionPaidOn: ['2027-03-09'] })).toBe('FORFEITED')
  })
})
