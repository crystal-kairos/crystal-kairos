import { describe, it, expect } from 'vitest'
import { Prisma } from '@/generated/prisma/client'
import { PenaltyCapType } from '@/generated/prisma/enums'
import {
  validateLoanTermRateInput,
  assertNoRateOverlap,
  resolveActiveLoanRate,
  formatSavingsProductRatesDisplay,
} from '@/lib/domain/rate-policy'

describe('PR P2-05: Loan Rates & Savings Plan Rates Policy Unit Tests', () => {
  it('validates duration 1..12, non-negative interest & penalty, and mandatory cap > 0', () => {
    // Valid input
    const valid = validateLoanTermRateInput({
      durationMonths: 6,
      monthlyInterestPercent: '5.0000',
      latePenaltyDailyPercent: '0.5000',
      penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
      penaltyCapValue: '10.0000',
      effectiveFrom: '2027-01-01',
    })
    expect(valid.durationMonths).toBe(6)
    expect(valid.penaltyCapType).toBe(PenaltyCapType.PERCENT_OF_PRINCIPAL)

    // Duration out of bounds
    expect(() =>
      validateLoanTermRateInput({
        durationMonths: 13,
        monthlyInterestPercent: '5.0000',
        latePenaltyDailyPercent: '0.5000',
        penaltyCapType: PenaltyCapType.FIXED_AMOUNT,
        penaltyCapValue: '20000.00',
        effectiveFrom: '2027-01-01',
      })
    ).toThrow('durationMonths must be an integer between 1 and 12')

    // Zero cap value is rejected (D-05)
    expect(() =>
      validateLoanTermRateInput({
        durationMonths: 6,
        monthlyInterestPercent: '5.0000',
        latePenaltyDailyPercent: '0.5000',
        penaltyCapType: PenaltyCapType.FIXED_AMOUNT,
        penaltyCapValue: '0',
        effectiveFrom: '2027-01-01',
      })
    ).toThrow('penaltyCapValue must be strictly greater than 0')

    // Negative cap value is rejected
    expect(() =>
      validateLoanTermRateInput({
        durationMonths: 6,
        monthlyInterestPercent: '5.0000',
        latePenaltyDailyPercent: '0.5000',
        penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
        penaltyCapValue: '-5.00',
        effectiveFrom: '2027-01-01',
      })
    ).toThrow('penaltyCapValue must be strictly greater than 0')

    // Negative interest rate is rejected
    expect(() =>
      validateLoanTermRateInput({
        durationMonths: 6,
        monthlyInterestPercent: '-1.0000',
        latePenaltyDailyPercent: '0.5000',
        penaltyCapType: PenaltyCapType.FIXED_AMOUNT,
        penaltyCapValue: '10000.00',
        effectiveFrom: '2027-01-01',
      })
    ).toThrow('monthlyInterestPercent cannot be negative')
  })

  it('rejects overlapping rate validity dates for the same duration', () => {
    const existing = [
      {
        id: 'rate-1',
        durationMonths: 6,
        effectiveFrom: '2027-01-01',
        effectiveTo: '2027-06-30',
      },
    ]

    // Overlapping candidate
    expect(() =>
      assertNoRateOverlap(existing, {
        durationMonths: 6,
        effectiveFrom: '2027-03-01',
        effectiveTo: '2027-12-31',
      })
    ).toThrow('Rate overlap detected for 6 months')

    // Non-overlapping candidate for different duration: passes
    expect(() =>
      assertNoRateOverlap(existing, {
        durationMonths: 12,
        effectiveFrom: '2027-03-01',
        effectiveTo: '2027-12-31',
      })
    ).not.toThrow()

    // Non-overlapping candidate after effectiveTo: passes
    expect(() =>
      assertNoRateOverlap(existing, {
        durationMonths: 6,
        effectiveFrom: '2027-07-01',
        effectiveTo: '2027-12-31',
      })
    ).not.toThrow()
  })

  it('resolves exactly one active loan rate per duration as of a target date', () => {
    const rates = [
      {
        id: 'v1',
        durationMonths: 6,
        monthlyInterestPercent: new Prisma.Decimal('5.0000'),
        version: 1,
        effectiveFrom: '2027-01-01',
        effectiveTo: '2027-06-30',
      },
      {
        id: 'v2',
        durationMonths: 6,
        monthlyInterestPercent: new Prisma.Decimal('6.0000'),
        version: 2,
        effectiveFrom: '2027-07-01',
        effectiveTo: null,
      },
    ]

    const rateInMarch = resolveActiveLoanRate(rates, 6, '2027-03-15')
    expect(rateInMarch?.id).toBe('v1')
    expect(rateInMarch?.version).toBe(1)

    const rateInAugust = resolveActiveLoanRate(rates, 6, '2027-08-01')
    expect(rateInAugust?.id).toBe('v2')
    expect(rateInAugust?.version).toBe(2)

    const unconfigured = resolveActiveLoanRate(rates, 3, '2027-08-01')
    expect(unconfigured).toBeNull()
  })

  it('generates savings product term rate display string dynamically (never typed)', () => {
    const rates = [
      { durationMonths: 12, ratePercent: '24.0000', isActive: true },
      { durationMonths: 6, ratePercent: '12.0000', isActive: true },
      { durationMonths: 3, ratePercent: '5.0000', isActive: false }, // inactive, omitted
    ]

    const display = formatSavingsProductRatesDisplay(rates)
    expect(display).toBe('12.00% (6M) / 24.00% (12M)')

    expect(formatSavingsProductRatesDisplay([])).toBe('Flexible Rates')
  })
})
