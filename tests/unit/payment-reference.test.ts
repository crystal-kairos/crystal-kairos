import { describe, expect, it } from 'vitest'
import {
  generateMemberPaymentReference,
  parseMemberPaymentReference,
  formatSequentialNumber,
} from '@/lib/domain/payment-reference'

describe('Payment Reference Codes and Numbering (§2.10, §2.11)', () => {
  it('generates canonical bank payment narration based on member number and purpose', () => {
    expect(generateMemberPaymentReference('CK000123', 'SAV')).toBe('CK000123 SAV')
    expect(generateMemberPaymentReference('CK000123', 'SAVINGS_DEPOSIT')).toBe('CK000123 SAV')
    expect(generateMemberPaymentReference('CK000123', 'LOAN_REPAYMENT')).toBe('CK000123 LOAN')
    expect(generateMemberPaymentReference('ck000456', 'EAJO_CONTRIBUTION')).toBe('CK000456 AJO')
    expect(generateMemberPaymentReference('ck000789', 'WALLET_TOPUP')).toBe('CK000789 WAL')
  })

  it('parses payment references correctly', () => {
    const parsed = parseMemberPaymentReference('CK000123 SAV')
    expect(parsed).toEqual({
      membershipNumber: 'CK000123',
      purposeCode: 'SAV',
    })

    const parsedHyphen = parseMemberPaymentReference('CK000456-LOAN')
    expect(parsedHyphen).toEqual({
      membershipNumber: 'CK000456',
      purposeCode: 'LOAN',
    })

    expect(parseMemberPaymentReference('')).toBeNull()
    expect(parseMemberPaymentReference('INVALID')).toBeNull()
  })

  it('formats sequential numbers with zero-padding', () => {
    expect(formatSequentialNumber('SUB', 1)).toBe('SUB-000001')
    expect(formatSequentialNumber('PAY', 42)).toBe('PAY-000042')
    expect(formatSequentialNumber('DSB', 999999)).toBe('DSB-999999')
  })
})
