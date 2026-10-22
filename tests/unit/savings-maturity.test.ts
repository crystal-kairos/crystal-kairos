import { describe, it, expect } from 'vitest'
import {
  maturityToMonths,
  calculateMaturityDate,
  getInterestRate,
  getPeriodsCount,
} from '@/lib/savings'
import { SavingsMaturity, SavingsType, SavingsFrequency } from '@/generated/prisma/enums'

describe('Savings maturity mapping & period calculation (PR P1-08)', () => {
  it('maps all four SavingsMaturity enum values explicitly to months', () => {
    expect(maturityToMonths(SavingsMaturity.ONE_MONTH)).toBe(1)
    expect(maturityToMonths(SavingsMaturity.THREE_MONTHS)).toBe(3)
    expect(maturityToMonths(SavingsMaturity.SIX_MONTHS)).toBe(6)
    expect(maturityToMonths(SavingsMaturity.TWELVE_MONTHS)).toBe(12)
  })

  it('calculates the exact maturity date for all 4 maturities', () => {
    const start = new Date('2026-01-15T00:00:00Z')

    const d1 = calculateMaturityDate(start, SavingsMaturity.ONE_MONTH)
    expect(d1.getMonth()).toBe(1) // February (0-indexed: Jan=0, Feb=1)
    expect(d1.getFullYear()).toBe(2026)

    const d3 = calculateMaturityDate(start, SavingsMaturity.THREE_MONTHS)
    expect(d3.getMonth()).toBe(3) // April
    expect(d3.getFullYear()).toBe(2026)

    const d6 = calculateMaturityDate(start, SavingsMaturity.SIX_MONTHS)
    expect(d6.getMonth()).toBe(6) // July
    expect(d6.getFullYear()).toBe(2026)

    const d12 = calculateMaturityDate(start, SavingsMaturity.TWELVE_MONTHS)
    expect(d12.getMonth()).toBe(0) // January of next year
    expect(d12.getFullYear()).toBe(2027)
  })

  it('calculates period counts for all maturities with different frequencies', () => {
    expect(getPeriodsCount(SavingsFrequency.MONTHLY, SavingsMaturity.ONE_MONTH)).toBe(1)
    expect(getPeriodsCount(SavingsFrequency.MONTHLY, SavingsMaturity.THREE_MONTHS)).toBe(3)
    expect(getPeriodsCount(SavingsFrequency.MONTHLY, SavingsMaturity.SIX_MONTHS)).toBe(6)
    expect(getPeriodsCount(SavingsFrequency.MONTHLY, SavingsMaturity.TWELVE_MONTHS)).toBe(12)

    expect(getPeriodsCount(SavingsFrequency.DAILY, SavingsMaturity.ONE_MONTH)).toBe(30)
    expect(getPeriodsCount(SavingsFrequency.DAILY, SavingsMaturity.THREE_MONTHS)).toBe(90)
    expect(getPeriodsCount(SavingsFrequency.DAILY, SavingsMaturity.SIX_MONTHS)).toBe(180)
    expect(getPeriodsCount(SavingsFrequency.DAILY, SavingsMaturity.TWELVE_MONTHS)).toBe(360)
  })

  it('provides sensible interest rates for all 4 maturities', () => {
    expect(getInterestRate(SavingsType.FIXED, SavingsMaturity.ONE_MONTH)).toBeGreaterThan(0)
    expect(getInterestRate(SavingsType.FIXED, SavingsMaturity.THREE_MONTHS)).toBeGreaterThan(0)
    expect(getInterestRate(SavingsType.FIXED, SavingsMaturity.SIX_MONTHS)).toBe(12)
    expect(getInterestRate(SavingsType.FIXED, SavingsMaturity.TWELVE_MONTHS)).toBe(36)

    expect(getInterestRate(SavingsType.REGULAR, SavingsMaturity.ONE_MONTH)).toBeGreaterThan(0)
    expect(getInterestRate(SavingsType.REGULAR, SavingsMaturity.THREE_MONTHS)).toBeGreaterThan(0)
    expect(getInterestRate(SavingsType.REGULAR, SavingsMaturity.SIX_MONTHS)).toBe(4.5)
    expect(getInterestRate(SavingsType.REGULAR, SavingsMaturity.TWELVE_MONTHS)).toBe(10.5)
  })
})
