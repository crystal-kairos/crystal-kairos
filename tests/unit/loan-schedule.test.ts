import { describe, it, expect } from 'vitest'
import { generateLoanSchedule } from '@/lib/domain/loan-schedule'
import { c1LoanScheduleFixture } from '../golden/c1-loan-schedule.fixture'
import { Prisma } from '@/generated/prisma/client'

describe('Loan Schedule Domain Generator (§2.9, D-04, A-01)', () => {
  it('reproduces Appendix C1 golden fixture exactly', () => {
    const result = generateLoanSchedule({
      principal: c1LoanScheduleFixture.input.principal,
      termMonths: c1LoanScheduleFixture.input.termMonths,
      monthlyInterestRatePercent:
        c1LoanScheduleFixture.input.monthlyInterestRatePercent,
      anchorDate: c1LoanScheduleFixture.input.disbursementDate,
    })

    expect(result.monthlyInterest.toFixed(2)).toBe('15000.00')
    expect(result.totalInterest.toFixed(2)).toBe('90000.00')
    expect(result.totalScheduledRepayment.toFixed(2)).toBe('390000.00')
    expect(result.instalments).toHaveLength(6)

    for (let i = 0; i < 6; i++) {
      const actual = result.instalments[i]
      const expected = c1LoanScheduleFixture.expected.instalments[i]
      expect(actual.instalmentNumber).toBe(expected.instalmentNumber)
      expect(actual.dueDateStr).toBe(expected.dueDate)
      expect(actual.principalDue.toFixed(2)).toBe(
        expected.principalPortion.toFixed(2),
      )
      expect(actual.interestDue.toFixed(2)).toBe(
        expected.interestPortion.toFixed(2),
      )
      expect(actual.totalDue.toFixed(2)).toBe(expected.totalDue.toFixed(2))
    }
  })

  it('allocates principal rounding remainder to the final instalment', () => {
    // 100,000 / 3 = 33,333.3333...
    // 1: 33,333.33
    // 2: 33,333.33
    // 3: 33,333.34 (absorbs 1 cent remainder)
    const result = generateLoanSchedule({
      principal: '100000.00',
      termMonths: 3,
      monthlyInterestRatePercent: '5.0',
      anchorDate: '2027-01-15',
    })

    expect(result.instalments[0].principalDue.toFixed(2)).toBe('33333.33')
    expect(result.instalments[1].principalDue.toFixed(2)).toBe('33333.33')
    expect(result.instalments[2].principalDue.toFixed(2)).toBe('33333.34')

    const totalPrincipal = result.instalments.reduce(
      (acc, inst) => acc.plus(inst.principalDue),
      new Prisma.Decimal(0),
    )
    expect(totalPrincipal.toFixed(2)).toBe('100000.00')

    const totalScheduled = result.instalments.reduce(
      (acc, inst) => acc.plus(inst.totalDue),
      new Prisma.Decimal(0),
    )
    expect(totalScheduled.equals(result.totalScheduledRepayment)).toBe(true)
  })

  it('correctly handles month-end disbursement anchor without calendar drift', () => {
    const result = generateLoanSchedule({
      principal: '200000.00',
      termMonths: 4,
      monthlyInterestRatePercent: '4.0',
      anchorDate: '2027-01-31',
    })

    expect(result.instalments.map((i) => i.dueDateStr)).toEqual([
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
      '2027-05-31',
    ])
  })

  it('rejects invalid principal or term duration', () => {
    expect(() =>
      generateLoanSchedule({
        principal: '0',
        termMonths: 6,
        monthlyInterestRatePercent: '5',
        anchorDate: '2027-01-10',
      }),
    ).toThrowError(/Loan principal must be greater than zero/)

    expect(() =>
      generateLoanSchedule({
        principal: '50000',
        termMonths: 0,
        monthlyInterestRatePercent: '5',
        anchorDate: '2027-01-10',
      }),
    ).toThrowError(/Loan term months must be greater than zero/)
  })
})
