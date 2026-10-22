import { SavingsType, SavingsFrequency, SavingsMaturity } from '@/generated/prisma/enums'

// Helper to serialize Decimal fields to numbers to prevent RSC boundary serialization errors
export const serializeSavings = <T extends Record<string, unknown>>(
  savings: T | null | undefined,
) => {
  if (!savings) return null
  const s = savings as Record<string, unknown>
  return {
    ...savings,
    targetAmount: s.targetAmount ? Number(s.targetAmount) : null,
    interestRate: Number(s.interestRate),
    currentBalance: Number(s.currentBalance),
    accruedInterest: Number(s.accruedInterest),
    totalDeposited: Number(s.totalDeposited),
    expectedMaturityAmount: s.expectedMaturityAmount
      ? Number(s.expectedMaturityAmount)
      : null,
  }
}

export const serializeTransaction = <T extends Record<string, unknown>>(
  tx: T | null | undefined,
) => {
  if (!tx) return null
  const t = tx as Record<string, unknown>
  return {
    ...tx,
    amount: Number(t.amount),
  }
}

/**
 * Maps all four SavingsMaturity enum values explicitly to their duration in months.
 */
export const maturityToMonths = (maturity: SavingsMaturity): number => {
  switch (maturity) {
    case SavingsMaturity.ONE_MONTH:
      return 1
    case SavingsMaturity.THREE_MONTHS:
      return 3
    case SavingsMaturity.SIX_MONTHS:
      return 6
    case SavingsMaturity.TWELVE_MONTHS:
      return 12
    default:
      return 12
  }
}

/**
 * Calculates the exact maturity date given a starting date and maturity term.
 */
export const calculateMaturityDate = (
  startDate: Date,
  maturity: SavingsMaturity,
): Date => {
  const months = maturityToMonths(maturity)
  const maturityDate = new Date(startDate.getTime())
  maturityDate.setMonth(maturityDate.getMonth() + months)
  return maturityDate
}

// Calculate interest rate based on plan type and term
export const getInterestRate = (type: SavingsType, maturity: SavingsMaturity): number => {
  if (type === 'FIXED') {
    switch (maturity) {
      case SavingsMaturity.ONE_MONTH:
        return 2
      case SavingsMaturity.THREE_MONTHS:
        return 6
      case SavingsMaturity.SIX_MONTHS:
        return 12
      case SavingsMaturity.TWELVE_MONTHS:
        return 36
      default:
        return 12
    }
  }
  if (type === 'REGULAR') {
    switch (maturity) {
      case SavingsMaturity.ONE_MONTH:
        return 0.75
      case SavingsMaturity.THREE_MONTHS:
        return 2.25
      case SavingsMaturity.SIX_MONTHS:
        return 4.5
      case SavingsMaturity.TWELVE_MONTHS:
        return 10.5
      default:
        return 4.5
    }
  }
  return 0 // STAGGERED
}

// Calculate total periods for regular savings
export const getPeriodsCount = (frequency: SavingsFrequency, maturity: SavingsMaturity): number => {
  const months = maturityToMonths(maturity)

  if (frequency === 'DAILY') {
    return months * 30
  }
  if (frequency === 'WEEKLY') {
    return months * 4.33
  }
  if (frequency === 'MONTHLY') {
    return months
  }
  return 1 // ONCE / FIXED
}
