import { SavingsType, SavingsFrequency, SavingsMaturity } from '@/generated/prisma/enums'

// Helper to serialize Decimal fields to numbers to prevent RSC boundary serialization errors
export const serializeSavings = (savings: any) => {
  if (!savings) return null
  return {
    ...savings,
    targetAmount: savings.targetAmount ? Number(savings.targetAmount) : null,
    interestRate: Number(savings.interestRate),
    currentBalance: Number(savings.currentBalance),
    accruedInterest: Number(savings.accruedInterest),
    totalDeposited: Number(savings.totalDeposited),
    expectedMaturityAmount: savings.expectedMaturityAmount ? Number(savings.expectedMaturityAmount) : null,
  }
}

export const serializeTransaction = (tx: any) => {
  if (!tx) return null
  return {
    ...tx,
    amount: Number(tx.amount),
  }
}

// Calculate interest rate based on plan type and term
export const getInterestRate = (type: SavingsType, maturity: SavingsMaturity): number => {
  if (type === 'FIXED') {
    return maturity === 'SIX_MONTHS' ? 12 : 36
  }
  if (type === 'REGULAR') {
    return maturity === 'SIX_MONTHS' ? 4.5 : 10.5
  }
  return 0 // STAGGERED
}

// Calculate total periods for regular savings
export const getPeriodsCount = (frequency: SavingsFrequency, maturity: SavingsMaturity): number => {
  let months = 6;
  if (maturity === 'ONE_MONTH') months = 1;
  else if (maturity === 'THREE_MONTHS') months = 3;
  else if (maturity === 'SIX_MONTHS') months = 6;
  else if (maturity === 'TWELVE_MONTHS') months = 12;

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
