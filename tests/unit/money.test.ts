import { describe, it, expect } from 'vitest'
import { Prisma } from '@/generated/prisma/client'
import {
  toDecimal,
  roundMoney,
  splitWithRemainder,
  assertPositive,
  assertNonNegative,
  formatNaira,
} from '@/lib/domain/money'

describe('Domain: Money Rules (PR P2-02, §2.12)', () => {
  it('converts numbers, strings, and Decimals to Prisma.Decimal with full fidelity', () => {
    expect(toDecimal(100)).toEqual(new Prisma.Decimal(100))
    expect(toDecimal('25000.50')).toEqual(new Prisma.Decimal('25000.50'))
    expect(toDecimal(new Prisma.Decimal('12.3456'))).toEqual(
      new Prisma.Decimal('12.3456'),
    )
    expect(() => toDecimal('not-a-number')).toThrowError(/Invalid decimal string/i)
  })

  it('rounds half-up to two decimal places at posting time', () => {
    // 12.345 -> 12.35
    expect(roundMoney('12.345').toFixed(2)).toBe('12.35')
    // 12.344 -> 12.34
    expect(roundMoney('12.344').toFixed(2)).toBe('12.34')
    // 12.345000 -> 12.35
    expect(roundMoney(new Prisma.Decimal('12.345000')).toFixed(2)).toBe('12.35')
  })

  it('splits total into N parts and assigns rounding remainder to the final part', () => {
    // 100 split into 3 parts: 33.33, 33.33, 33.34
    const parts3 = splitWithRemainder('100.00', 3)
    expect(parts3).toHaveLength(3)
    expect(parts3[0].toFixed(2)).toBe('33.33')
    expect(parts3[1].toFixed(2)).toBe('33.33')
    expect(parts3[2].toFixed(2)).toBe('33.34')

    // Sum of parts must exactly equal original total
    const sum = parts3.reduce((acc, p) => acc.plus(p), new Prisma.Decimal(0))
    expect(sum.toFixed(2)).toBe('100.00')

    // 10 split into 1 part
    expect(splitWithRemainder('10.00', 1)[0].toFixed(2)).toBe('10.00')

    // Invalid parts
    expect(() => splitWithRemainder('10.00', 0)).toThrowError(/positive integer/i)
    expect(() => splitWithRemainder('10.00', -2)).toThrowError(/positive integer/i)
  })

  it('validates strictly positive and non-negative constraints', () => {
    expect(() => assertPositive('100.00', 'Amount')).not.toThrow()
    expect(() => assertPositive('0.00', 'Amount')).toThrowError(/greater than zero/i)
    expect(() => assertPositive('-5.00', 'Amount')).toThrowError(/greater than zero/i)

    expect(() => assertNonNegative('0.00', 'Amount')).not.toThrow()
    expect(() => assertNonNegative('10.50', 'Amount')).not.toThrow()
    expect(() => assertNonNegative('-0.01', 'Amount')).toThrowError(/cannot be negative/i)
  })

  it('formats Naira currency properly with thousands commas and 2 decimals', () => {
    expect(formatNaira('1234567.89')).toBe('₦1,234,567.89')
    expect(formatNaira(5000)).toBe('₦5,000.00')
    expect(formatNaira(new Prisma.Decimal('0'))).toBe('₦0.00')
  })
})
