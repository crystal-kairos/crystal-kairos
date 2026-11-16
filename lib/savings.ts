/**
 * Savings display helpers. Financial rules live in lib/domain/savings-interest.ts and
 * lib/services/savings.service.ts (P3-03).
 */

// Serialises Decimal fields to numbers so plans can cross the RSC boundary.
export const serializeSavings = <T extends Record<string, unknown>>(
  savings: T | null | undefined,
) => {
  if (!savings) return null
  const s = savings as Record<string, unknown>
  return {
    ...savings,
    targetAmount: s.targetAmount !== null && s.targetAmount !== undefined ? Number(s.targetAmount) : null,
    ratePercentSnapshot: Number(s.ratePercentSnapshot ?? 0),
    currentBalance: Number(s.currentBalance ?? 0),
    totalDeposited: Number(s.totalDeposited ?? 0),
    withdrawalPrincipal:
      s.withdrawalPrincipal !== null && s.withdrawalPrincipal !== undefined ? Number(s.withdrawalPrincipal) : null,
    withdrawalInterest:
      s.withdrawalInterest !== null && s.withdrawalInterest !== undefined ? Number(s.withdrawalInterest) : null,
  }
}

export const SAVINGS_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Awaiting first deposit',
  ACTIVE: 'Active',
  MATURED: 'Matured',
  WITHDRAWAL_PENDING: 'Withdrawal in progress',
  WITHDRAWN: 'Withdrawn',
  CANCELLED: 'Cancelled',
}

export const termLabel = (months: number): string =>
  months === 12 ? '12 months (1 year)' : `${months} month${months === 1 ? '' : 's'}`
