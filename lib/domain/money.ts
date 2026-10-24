import { Prisma } from '@/generated/prisma/client'
import { AppError } from '@/lib/errors/app-error'

export type DecimalValue = string | number | Prisma.Decimal

/**
 * Converts a string, number, or Decimal into a Prisma.Decimal.
 */
export function toDecimal(value: DecimalValue): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AppError('VALIDATION_ERROR', 'Invalid number provided to toDecimal.')
    }
    return new Prisma.Decimal(value)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || isNaN(Number(trimmed))) {
      throw new AppError('VALIDATION_ERROR', `Invalid decimal string: "${value}".`)
    }
    return new Prisma.Decimal(trimmed)
  }
  throw new AppError('VALIDATION_ERROR', 'Unsupported value type for toDecimal.')
}

/**
 * Money rounding rule (PR P2-02, §2.12):
 * Rounding is HALF_UP to 2 decimal places ONLY at posting time.
 * Full precision is maintained during intermediate calculation steps.
 */
export function roundMoney(amount: DecimalValue): Prisma.Decimal {
  const d = toDecimal(amount)
  return d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
}

/**
 * Splits a total amount into N equal parts, allocating any leftover rounding
 * remainder to the final part so no money is lost or created.
 */
export function splitWithRemainder(
  total: DecimalValue,
  parts: number,
): Prisma.Decimal[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Parts must be a positive integer. Received: ${parts}`,
    )
  }

  const dTotal = roundMoney(total)
  if (parts === 1) {
    return [dTotal]
  }

  // Calculate base equal share (rounded to 2 decimal places)
  const baseShare = dTotal.dividedBy(parts).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  const result: Prisma.Decimal[] = []

  let accumulated = new Prisma.Decimal(0)
  for (let i = 0; i < parts - 1; i++) {
    result.push(baseShare)
    accumulated = accumulated.plus(baseShare)
  }

  // Remainder assigned to the last part
  const remainder = dTotal.minus(accumulated)
  result.push(remainder)

  return result
}

/**
 * Validates that an amount is strictly positive (> 0).
 */
export function assertPositive(amount: DecimalValue, fieldName = 'Amount'): void {
  const d = toDecimal(amount)
  if (d.lte(0)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${fieldName} must be greater than zero. Received: ${d.toFixed(2)}`,
    )
  }
}

/**
 * Validates that an amount is non-negative (>= 0).
 */
export function assertNonNegative(
  amount: DecimalValue,
  fieldName = 'Amount',
): void {
  const d = toDecimal(amount)
  if (d.lt(0)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${fieldName} cannot be negative. Received: ${d.toFixed(2)}`,
    )
  }
}

/**
 * Sums an array of Decimal values into a single Decimal.
 */
export function sumDecimals(values: DecimalValue[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>(
    (acc, v) => acc.plus(toDecimal(v)),
    new Prisma.Decimal(0),
  )
}

/**
 * Formats a Decimal, number, or string as Nigerian Naira (NGN).
 */
export function formatNaira(amount: DecimalValue): string {
  const d = roundMoney(amount)
  const parts = d.toFixed(2).split('.')
  const integerPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `₦${integerPart}.${parts[1]}`
}
