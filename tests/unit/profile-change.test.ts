import { describe, it, expect } from 'vitest'
import { ZodError } from 'zod'
import {
  ProfileChangeStatus,
  ProfileChangeType,
  Relationship,
} from '@/generated/prisma/enums'
import {
  canTransitionProfileChange,
  maskAccountNumber,
  parseProposedValue,
  redactChangeValue,
  toRedactedProfileChange,
} from '@/lib/domain/profile-change'

const validNok = {
  name: 'Jane Doe',
  phoneNumber: '08012345678',
  relationship: Relationship.SPOUSE,
  occupation: 'Software Engineer',
  address: '12 Marina Street, Lagos',
  bankName: 'Access Bank',
  accountNumber: '0123456789',
  accountName: 'Jane Doe',
}

describe('Unit: profile change domain rules (PR P3-02B)', () => {
  describe('maskAccountNumber', () => {
    it('keeps only the last four digits', () => {
      expect(maskAccountNumber('0123456789')).toBe('******6789')
      expect(maskAccountNumber(' 2001928374 ')).toBe('******8374')
    })

    it('never leaks short or missing values', () => {
      expect(maskAccountNumber('123')).toBe('****')
      expect(maskAccountNumber('')).toBe('****')
      expect(maskAccountNumber(null)).toBe('****')
      expect(maskAccountNumber(undefined)).toBe('****')
    })
  })

  describe('canTransitionProfileChange', () => {
    it('allows PENDING to move to every terminal state', () => {
      expect(canTransitionProfileChange(ProfileChangeStatus.PENDING, ProfileChangeStatus.APPROVED)).toBe(true)
      expect(canTransitionProfileChange(ProfileChangeStatus.PENDING, ProfileChangeStatus.REJECTED)).toBe(true)
      expect(canTransitionProfileChange(ProfileChangeStatus.PENDING, ProfileChangeStatus.CANCELLED)).toBe(true)
    })

    it('treats APPROVED, REJECTED and CANCELLED as terminal', () => {
      const terminal = [
        ProfileChangeStatus.APPROVED,
        ProfileChangeStatus.REJECTED,
        ProfileChangeStatus.CANCELLED,
      ]
      for (const from of terminal) {
        for (const to of Object.values(ProfileChangeStatus)) {
          expect(canTransitionProfileChange(from, to)).toBe(false)
        }
      }
      expect(canTransitionProfileChange(ProfileChangeStatus.PENDING, ProfileChangeStatus.PENDING)).toBe(false)
    })
  })

  describe('parseProposedValue', () => {
    it('accepts a valid NEXT_OF_KIN payload and strips unknown keys', () => {
      const parsed = parseProposedValue(ProfileChangeType.NEXT_OF_KIN, {
        ...validNok,
        isPrimary: true, // not part of the schema; must not reach a Prisma update
      })
      expect(parsed.changeType).toBe(ProfileChangeType.NEXT_OF_KIN)
      expect(parsed.value).not.toHaveProperty('isPrimary')
      expect((parsed.value as { accountNumber: string }).accountNumber).toBe('0123456789')
    })

    it('rejects a NEXT_OF_KIN payload with a non-numeric account number or a bad relationship', () => {
      expect(() =>
        parseProposedValue(ProfileChangeType.NEXT_OF_KIN, { ...validNok, accountNumber: '01234abcde' }),
      ).toThrow(ZodError)
      expect(() =>
        parseProposedValue(ProfileChangeType.NEXT_OF_KIN, { ...validNok, relationship: 'BOSS' }),
      ).toThrow(ZodError)
    })

    it('requires a target account id for PRIMARY_BANK', () => {
      expect(() =>
        parseProposedValue(ProfileChangeType.PRIMARY_BANK, {
          bankName: 'GTBank',
          accountName: 'Jane Doe',
          accountNumberMasked: '******6789',
        }),
      ).toThrow(ZodError)

      const ok = parseProposedValue(ProfileChangeType.PRIMARY_BANK, {
        targetBankAccountId: 'acc-1',
        bankName: 'GTBank',
        bankCode: '058',
        accountName: 'Jane Doe',
        accountNumberMasked: '******6789',
      })
      expect(ok.changeType).toBe(ProfileChangeType.PRIMARY_BANK)
    })

    it('validates BANK_DETAILS strictly and drops unexpected fields such as userId or isPrimary', () => {
      const payload = {
        bankAccountId: 'acc-1',
        bankCode: '057',
        bankName: 'Zenith Bank',
        accountNumber: '1234567890',
        accountName: 'JANE DOE',
        accountNumberMasked: '******7890',
        userId: 'someone-else',
        isPrimary: true,
      }
      const parsed = parseProposedValue(ProfileChangeType.BANK_DETAILS, payload)
      expect(parsed.value).not.toHaveProperty('userId')
      expect(parsed.value).not.toHaveProperty('isPrimary')

      expect(() =>
        parseProposedValue(ProfileChangeType.BANK_DETAILS, { ...payload, bankCode: '' }),
      ).toThrow(ZodError)
      expect(() =>
        parseProposedValue(ProfileChangeType.BANK_DETAILS, { ...payload, accountNumber: '12345' }),
      ).toThrow(ZodError)
    })
  })

  describe('redaction', () => {
    it('removes full account numbers and keeps (or derives) the masked value', () => {
      expect(redactChangeValue({ name: 'Jane', accountNumber: '0123456789' })).toEqual({
        name: 'Jane',
        accountNumberMasked: '******6789',
      })
      expect(
        redactChangeValue({ accountNumber: '0123456789', accountNumberMasked: '******6789' }),
      ).toEqual({ accountNumberMasked: '******6789' })
      expect(redactChangeValue(null)).toBeNull()
    })

    it('redacts both snapshots of a request without touching other fields', () => {
      const redacted = toRedactedProfileChange({
        id: 'req-1',
        status: ProfileChangeStatus.PENDING,
        previousValue: { accountNumber: '1111222233' },
        proposedValue: { accountNumber: '4444555566', bankName: 'GTBank' },
      })
      expect(redacted.id).toBe('req-1')
      expect(JSON.stringify(redacted)).not.toContain('1111222233')
      expect(JSON.stringify(redacted)).not.toContain('4444555566')
      expect((redacted.proposedValue as { bankName?: string }).bankName).toBe('GTBank')
    })
  })
})
