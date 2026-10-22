import { z } from 'zod'
import { Prisma } from '@/generated/prisma/client'
import { AppError } from '@/lib/errors/app-error'

/**
 * Maximum allowable amount for cooperative transactions in NGN.
 * 1 billion Naira is a sane ceiling preventing integer overflow and absurd values.
 */
export const MAX_MONEY_AMOUNT = 1_000_000_000

/**
 * Zod schema validating that an input is a finite, positive number with at most 2 decimal places,
 * below MAX_MONEY_AMOUNT, and transforms it into a Prisma.Decimal.
 */
export const moneyAmountSchema = z
  .union([
    z.number(),
    z.string(),
    z.instanceof(Prisma.Decimal),
  ])
  .transform((val, ctx) => {
    let numericValue: number

    if (val instanceof Prisma.Decimal) {
      if (val.isNaN() || !val.isFinite()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Amount must be a finite number.',
        })
        return z.NEVER
      }
      numericValue = val.toNumber()
    } else if (typeof val === 'string') {
      const trimmed = val.trim()
      if (trimmed === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Amount is required.',
        })
        return z.NEVER
      }
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed) || isNaN(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Amount must be a valid number.',
        })
        return z.NEVER
      }
      numericValue = parsed
    } else {
      if (!Number.isFinite(val) || isNaN(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Amount must be a finite number.',
        })
        return z.NEVER
      }
      numericValue = val
    }

    if (numericValue <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Amount must be greater than zero.',
      })
      return z.NEVER
    }

    if (numericValue > MAX_MONEY_AMOUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Amount cannot exceed ${MAX_MONEY_AMOUNT.toLocaleString()} NGN.`,
      })
      return z.NEVER
    }

    // Check decimal places (at most 2)
    // Convert to string checking representation
    const parts = numericValue.toString().split('.')
    if (parts.length > 1 && parts[1].length > 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Amount cannot have more than 2 decimal places.',
      })
      return z.NEVER
    }

    return new Prisma.Decimal(numericValue.toFixed(2))
  })

/**
 * Validates a monetary amount and returns a clean Prisma.Decimal.
 * Throws AppError('VALIDATION_ERROR', ...) if invalid.
 */
export function validateAmount(amount: unknown, fieldName = 'amount'): Prisma.Decimal {
  const parsed = moneyAmountSchema.safeParse(amount)
  if (!parsed.success) {
    const firstMessage = parsed.error.issues[0]?.message || 'Invalid amount'
    throw new AppError('VALIDATION_ERROR', firstMessage, {
      fieldErrors: {
        [fieldName]: parsed.error.issues.map((i) => i.message),
      },
    })
  }
  return parsed.data
}
