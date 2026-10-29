import { describe, it, expect } from 'vitest'
import {
  sanitizeAuditMetadata,
  AuditAction,
  AuditOutcome,
} from '@/lib/services/audit.service'

describe('Audit Service Metadata Sanitization & Catalogue (§P2-06)', () => {
  it('strips sensitive credentials and tokens from metadata', () => {
    const raw = {
      username: 'john_doe',
      password: 'super-secret-password-123',
      token: 'jwt-auth-token-xyz',
      secret: 'mfa-totp-secret',
      pin: '1234',
      privateKey: 'BEGIN RSA PRIVATE KEY...',
      cookie: 'session_token=abc',
      safeField: 'some-value',
    }

    const sanitized = sanitizeAuditMetadata(raw) as Record<string, unknown>

    expect(sanitized.username).toBe('john_doe')
    expect(sanitized.safeField).toBe('some-value')
    expect(sanitized.password).toBe('[REDACTED]')
    expect(sanitized.token).toBe('[REDACTED]')
    expect(sanitized.secret).toBe('[REDACTED]')
    expect(sanitized.pin).toBe('[REDACTED]')
    expect(sanitized.privateKey).toBe('[REDACTED]')
    expect(sanitized.cookie).toBe('[REDACTED]')
  })

  it('masks bank account numbers leaving only last 4 digits visible', () => {
    const raw = {
      bankName: 'Access Bank',
      accountNumber: '0123456789',
      bankAccountNumber: '9876543210',
      accountNo: '1122334455',
      shortAcc: '123',
    }

    const sanitized = sanitizeAuditMetadata(raw) as Record<string, unknown>

    expect(sanitized.accountNumber).toBe('******6789')
    expect(sanitized.bankAccountNumber).toBe('******3210')
    expect(sanitized.accountNo).toBe('******4455')
  })

  it('recursively sanitizes nested objects and arrays', () => {
    const raw = {
      actionInfo: {
        user: {
          email: 'test@example.com',
          password: 'plain-password',
        },
        accounts: [
          { accountNumber: '1234567890' },
          { token: 'secret-token' },
        ],
      },
    }

    const sanitized = sanitizeAuditMetadata(raw) as {
      actionInfo: {
        user: { email: string; password: string }
        accounts: Array<Record<string, unknown>>
      }
    }

    expect(sanitized.actionInfo.user.email).toBe('test@example.com')
    expect(sanitized.actionInfo.user.password).toBe('[REDACTED]')
    expect(sanitized.actionInfo.accounts[0].accountNumber).toBe('******7890')
    expect(sanitized.actionInfo.accounts[1].token).toBe('[REDACTED]')
  })

  it('defines comprehensive audit actions covering revision 2 catalogue', () => {
    expect(AuditAction.AUTH_SIGN_IN_SUCCESS).toBe('AUTH.SIGN_IN_SUCCESS')
    expect(AuditAction.AUTH_SIGN_IN_FAILURE).toBe('AUTH.SIGN_IN_FAILURE')
    expect(AuditAction.AUTH_LOCKOUT).toBe('AUTH.LOCKOUT')
    expect(AuditAction.AUTH_MFA_ENROLLED).toBe('AUTH.MFA_ENROLLED')
    expect(AuditAction.AUTH_MFA_RESET).toBe('AUTH.MFA_RESET')
    expect(AuditAction.AUTH_SESSION_REVOKED).toBe('AUTH.SESSION_REVOKED')
    expect(AuditAction.ADMIN_PERMISSION_GRANTED).toBe('ADMIN.PERMISSION_GRANTED')
    expect(AuditAction.RATE_CHANGED).toBe('RATE.CHANGED')
    expect(AuditAction.RECEIPT_CONFIRMED).toBe('RECEIPT.CONFIRMED')
    expect(AuditAction.FINANCIAL_REVERSAL).toBe('FINANCIAL.REVERSAL')
    expect(AuditAction.PENALTY_ACCRUED).toBe('PENALTY.ACCRUED')
    expect(AuditAction.PENALTY_WAIVED).toBe('PENALTY.WAIVED')
    expect(AuditAction.RECOVERY_CASE_STATE_CHANGED).toBe('RECOVERY.STATE_CHANGED')
    expect(AuditAction.WALLET_ALLOCATED).toBe('WALLET.ALLOCATED')
    expect(AuditAction.WALLET_WITHDRAWAL_REQUESTED).toBe('WALLET.WITHDRAWAL_REQUESTED')
    expect(AuditAction.GUARANTEE_CONSENT_GIVEN).toBe('GUARANTEE.CONSENT_GIVEN')
    expect(AuditAction.SETTLEMENT_CASE_ACTION).toBe('SETTLEMENT.ACTION')
    expect(AuditAction.SINGLE_OPERATOR_OVERRIDE).toBe('SECURITY.SINGLE_OPERATOR_OVERRIDE')
    expect(AuditAction.STAFF_MEMBER_BANK_VIEWED).toBe('SECURITY.STAFF_MEMBER_BANK_VIEWED')
    expect(AuditAction.STAFF_MEMBER_NOK_VIEWED).toBe('SECURITY.STAFF_MEMBER_NOK_VIEWED')
  })
})
