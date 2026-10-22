import { describe, it, expect } from 'vitest'
import { validateAmount, MAX_MONEY_AMOUNT, moneyAmountSchema } from '@/lib/validation/money'
import { Prisma } from '@/generated/prisma/client'
import { AppError } from '@/lib/errors/app-error'

describe('Amount validation (PR P1-08)', () => {
  it('accepts valid finite positive numbers with up to 2 decimal places', () => {
    const val1 = validateAmount(100)
    expect(val1.toNumber()).toBe(100)
    expect(val1 instanceof Prisma.Decimal).toBe(true)

    const val2 = validateAmount(2500.5)
    expect(val2.toString()).toBe('2500.5')

    const val3 = validateAmount(999.99)
    expect(val3.toString()).toBe('999.99')

    const val4 = validateAmount('15000.75')
    expect(val4.toString()).toBe('15000.75')

    const val5 = validateAmount(new Prisma.Decimal('500000.00'))
    expect(val5.toString()).toBe('500000')
  })

  it('rejects non-positive amounts (zero and negative numbers)', () => {
    expect(() => validateAmount(0)).toThrow(AppError)
    expect(() => validateAmount(-50)).toThrow(AppError)
    expect(() => validateAmount('-1000.00')).toThrow(AppError)
  })

  it('rejects NaN, Infinity and non-numeric strings', () => {
    expect(() => validateAmount(NaN)).toThrow(AppError)
    expect(() => validateAmount(Infinity)).toThrow(AppError)
    expect(() => validateAmount(-Infinity)).toThrow(AppError)
    expect(() => validateAmount('not-a-number')).toThrow(AppError)
    expect(() => validateAmount('')).toThrow(AppError)
    expect(() => validateAmount('   ')).toThrow(AppError)
  })

  it('rejects numbers with more than 2 decimal places', () => {
    expect(() => validateAmount(10.123)).toThrow(AppError)
    expect(() => validateAmount('50.999')).toThrow(AppError)
    expect(() => validateAmount(0.001)).toThrow(AppError)
  })

  it('rejects amounts exceeding the maximum ceiling', () => {
    expect(() => validateAmount(MAX_MONEY_AMOUNT + 1)).toThrow(AppError)
    expect(() => validateAmount(10_000_000_000)).toThrow(AppError)
  })

  it('produces structured fieldErrors on validation failure', () => {
    try {
      validateAmount(-10, 'requestedAmount')
      expect.unreachable('Should have thrown AppError')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      const appErr = err as AppError
      expect(appErr.code).toBe('VALIDATION_ERROR')
      expect(appErr.fieldErrors?.requestedAmount).toBeDefined()
      expect(appErr.fieldErrors?.requestedAmount.length).toBeGreaterThan(0)
    }
  })
})
