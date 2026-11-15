/**
 * Payment Reference Codes and Sequential Numbering (§2.10, §2.11)
 * Generates member payment narration codes and unique sequential IDs for
 * submissions (SUB-XXXXXX), payments (PAY-XXXXXX), and disbursements (DSB-XXXXXX).
 */

export type PaymentPurposeCode = 'SAV' | 'LOAN' | 'AJO' | 'WAL' | 'FEE'

const PURPOSE_MAP: Record<string, PaymentPurposeCode> = {
  SAVINGS_FIRST_DEPOSIT: 'SAV',
  SAVINGS_PERIOD: 'SAV',
  SAVINGS_DEPOSIT: 'SAV',
  LOAN_REPAYMENT: 'LOAN',
  LOAN_SETTLEMENT: 'LOAN',
  EAJO_CONTRIBUTION: 'AJO',
  WALLET_TOPUP: 'WAL',
  FEE: 'FEE',
}

/**
 * Generates the canonical bank deposit narration reference shown to members:
 * e.g., "CK000123 SAV", "CK000123 LOAN"
 */
export function generateMemberPaymentReference(
  membershipNumber: string,
  purpose: PaymentPurposeCode | string,
): string {
  const cleanNumber = membershipNumber.trim().toUpperCase()
  const code = (PURPOSE_MAP[purpose] ?? purpose).trim().toUpperCase()
  return `${cleanNumber} ${code}`
}

/**
 * Validates and parses a payment reference string.
 */
export function parseMemberPaymentReference(reference: string): {
  membershipNumber: string
  purposeCode: PaymentPurposeCode | string
} | null {
  if (!reference) return null
  const parts = reference.trim().split(/[\s-]+/)
  if (parts.length < 2) return null
  const membershipNumber = parts[0].toUpperCase()
  const purposeCode = parts[1].toUpperCase()
  return { membershipNumber, purposeCode }
}

/**
 * Formats a sequential number with zero-padding (e.g. SUB-000001)
 */
export function formatSequentialNumber(prefix: string, sequenceNumber: number): string {
  const padded = String(sequenceNumber).padStart(6, '0')
  return `${prefix}-${padded}`
}

/**
 * Next sequence number after the highest existing one (e.g. "SUB-000071" → 72).
 * Using the maximum instead of a row count keeps numbers unique when rows were removed
 * (test clean-up) — concurrent writers can still collide and must retry on the unique key.
 */
export function nextSequenceAfter(lastNumber: string | null | undefined): number {
  const n = lastNumber ? Number(lastNumber.split('-').pop()) : 0
  return (Number.isFinite(n) ? n : 0) + 1
}
