import { describe, it, expect, vi } from 'vitest'
import {
  calculateProfileCompleteness,
  normalizePhoneNumber,
} from '@/lib/domain/eligibility'
import {
  getProfileCompletion,
  assertProductEligibility,
} from '@/lib/services/profile.service'
import { MembershipStatus, UserRole } from '@/generated/prisma/enums'
import { AppError } from '@/lib/errors/app-error'

describe('Profile Completion & Product Gates (Unit Tests)', () => {
  describe('normalizePhoneNumber', () => {
    it('normalises standard 11-digit Nigerian local phone number to E.164', () => {
      expect(normalizePhoneNumber('08012345678')).toBe('+2348012345678')
      expect(normalizePhoneNumber('09098765432')).toBe('+2349098765432')
      expect(normalizePhoneNumber('07011223344')).toBe('+2347011223344')
    })

    it('handles numbers with spaces and dashes', () => {
      expect(normalizePhoneNumber('080 1234 5678')).toBe('+2348012345678')
      expect(normalizePhoneNumber('080-1234-5678')).toBe('+2348012345678')
    })

    it('handles Nigerian numbers provided with 234 prefix but without leading plus', () => {
      expect(normalizePhoneNumber('2348012345678')).toBe('+2348012345678')
    })

    it('preserves valid E.164 international numbers', () => {
      expect(normalizePhoneNumber('+2348012345678')).toBe('+2348012345678')
      expect(normalizePhoneNumber('+14155552671')).toBe('+14155552671')
      expect(normalizePhoneNumber('+447911123456')).toBe('+447911123456')
    })

    it('rejects invalid or empty numbers', () => {
      expect(() => normalizePhoneNumber('')).toThrow(AppError)
      expect(() => normalizePhoneNumber('12345')).toThrow(AppError)
      expect(() => normalizePhoneNumber('not-a-number')).toThrow(AppError)
      expect(() => normalizePhoneNumber('0801234')).toThrow(AppError)
    })
  })

  describe('calculateProfileCompleteness', () => {
    it('returns 0% when no sections are completed', () => {
      const res = calculateProfileCompleteness({})
      expect(res.isComplete).toBe(false)
      expect(res.completionPercentage).toBe(0)
      expect(res.missingSections).toEqual([
        'Personal Details',
        'Bank Account',
        'Next of Kin',
      ])
    })

    it('computes ~33% when only personal info is complete', () => {
      const res = calculateProfileCompleteness({
        userInfo: {
          address: '123 Victoria Island, Lagos',
          dateOfBirth: new Date('1990-01-01'),
          gender: 'MALE',
          occupation: 'Software Engineer',
          phoneNumber: '+2348012345678',
        },
      })
      expect(res.isComplete).toBe(false)
      expect(res.hasPersonalInfo).toBe(true)
      expect(res.completionPercentage).toBe(33)
      expect(res.missingSections).toEqual(['Bank Account', 'Next of Kin'])
    })

    it('computes ~67% when personal info and bank account are complete', () => {
      const res = calculateProfileCompleteness({
        userInfo: {
          address: '123 Victoria Island, Lagos',
          dateOfBirth: new Date('1990-01-01'),
          gender: 'MALE',
          occupation: 'Software Engineer',
          phoneNumber: '+2348012345678',
        },
        bankAccounts: [
          {
            accountNumber: '0123456789',
            bankName: 'First Bank of Nigeria',
            accountName: 'John Doe',
          },
        ],
      })
      expect(res.isComplete).toBe(false)
      expect(res.hasPersonalInfo).toBe(true)
      expect(res.hasBankAccount).toBe(true)
      expect(res.completionPercentage).toBe(67)
      expect(res.missingSections).toEqual(['Next of Kin'])
    })

    it('returns 100% when all 3 required sections are complete', () => {
      const res = calculateProfileCompleteness({
        userInfo: {
          address: '123 Victoria Island, Lagos',
          dateOfBirth: new Date('1990-01-01'),
          gender: 'MALE',
          occupation: 'Software Engineer',
          phoneNumber: '+2348012345678',
        },
        bankAccounts: [
          {
            accountNumber: '0123456789',
            bankName: 'First Bank of Nigeria',
            accountName: 'John Doe',
          },
        ],
        nextOfKin: {
          name: 'Jane Doe',
          phoneNumber: '+2348098765432',
          relationship: 'SPOUSE',
        },
      })
      expect(res.isComplete).toBe(true)
      expect(res.completionPercentage).toBe(100)
      expect(res.missingSections).toHaveLength(0)
    })
  })

  describe('getProfileCompletion & assertProductEligibility', () => {
    const createMockUser = (overrides: Record<string, any> = {}) => ({
      id: 'usr-123',
      name: 'John Doe',
      email: 'john@example.com',
      role: UserRole.USER,
      isActive: true,
      photoUrl: null,
      userInfo: {
        phoneNumber: '+2348012345678',
        address: '123 Victoria Island, Lagos',
        dateOfBirth: new Date('1990-01-01'),
        gender: 'MALE',
        occupation: 'Software Engineer',
      },
      bankAccounts: [
        {
          id: 'bnk-1',
          bankName: 'GTBank',
          accountNumber: '0123456789',
          accountName: 'John Doe',
          isPrimary: true,
        },
      ],
      nextOfKin: {
        id: 'nok-1',
        name: 'Jane Doe',
        phoneNumber: '+2348098765432',
        relationship: 'SPOUSE',
      },
      membership: {
        status: MembershipStatus.APPROVED,
      },
      uploadedFiles: [
        { id: 'file-1', purpose: 'PASSPORT_PHOTO' },
      ],
      ...overrides,
    })

    it('throws NOT_FOUND when user does not exist', async () => {
      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      } as any

      await expect(getProfileCompletion('non-existent', mockDb)).rejects.toThrow(
        AppError,
      )
    })

    it('reports incomplete and ineligibility when user is missing sections', async () => {
      const mockUser = createMockUser({
        bankAccounts: [],
        nextOfKin: null,
        uploadedFiles: [],
        photoUrl: null,
      })

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue(mockUser),
        },
      } as any

      const report = await getProfileCompletion('usr-123', mockDb)
      expect(report.isComplete).toBe(false)
      expect(report.completionPercentage).toBe(25) // 1 of 4 sections (personalInfo only)
      expect(report.missingSections).toContain('Bank Account')
      expect(report.missingSections).toContain('Next of Kin')
      expect(report.missingSections).toContain('Passport Photograph')

      // Check product eligibility
      expect(report.productEligibility.SAVINGS.eligible).toBe(false)
      expect(report.productEligibility.LOAN.eligible).toBe(false)
      expect(report.productEligibility.EAJO.eligible).toBe(false)
      expect(report.productEligibility.SAVINGS.reasons[0]).toContain(
        'Profile completion required',
      )
    })

    it('blocks products when membership is PENDING even if profile is 100% complete', async () => {
      const mockUser = createMockUser({
        membership: {
          status: MembershipStatus.PENDING,
        },
      })

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue(mockUser),
        },
      } as any

      const report = await getProfileCompletion('usr-123', mockDb)
      expect(report.isComplete).toBe(true)
      expect(report.completionPercentage).toBe(100)
      expect(report.isApproved).toBe(false)

      expect(report.productEligibility.LOAN.eligible).toBe(false)
      expect(report.productEligibility.LOAN.reasons[0]).toContain(
        'Membership must be approved before applying for Loans. Current status: PENDING.',
      )
    })

    it('blocks products for soft-deactivated members', async () => {
      const mockUser = createMockUser({
        isActive: false,
      })

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue(mockUser),
        },
      } as any

      const report = await getProfileCompletion('usr-123', mockDb)
      expect(report.productEligibility.SAVINGS.eligible).toBe(false)
      expect(report.productEligibility.SAVINGS.reasons[0]).toContain(
        'Account has been deactivated',
      )
    })

    it('blocks staff accounts (OWNER/ADMIN) from member products per D-15', async () => {
      const mockUser = createMockUser({
        role: UserRole.ADMIN,
      })

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue(mockUser),
        },
      } as any

      const report = await getProfileCompletion('usr-123', mockDb)
      expect(report.productEligibility.EAJO.eligible).toBe(false)
      expect(report.productEligibility.EAJO.reasons[0]).toContain(
        'Staff accounts (ADMIN) cannot participate in Digital Ajo (D-15).',
      )
    })

    it('marks all products as eligible when active, approved, USER, and 100% complete', async () => {
      const mockUser = createMockUser()

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue(mockUser),
        },
      } as any

      const report = await getProfileCompletion('usr-123', mockDb)
      expect(report.isComplete).toBe(true)
      expect(report.isApproved).toBe(true)
      expect(report.productEligibility.SAVINGS.eligible).toBe(true)
      expect(report.productEligibility.LOAN.eligible).toBe(true)
      expect(report.productEligibility.EAJO.eligible).toBe(true)

      // assertProductEligibility should resolve without throwing
      await expect(
        assertProductEligibility('usr-123', 'SAVINGS', mockDb),
      ).resolves.toBeUndefined()
      await expect(
        assertProductEligibility('usr-123', 'LOAN', mockDb),
      ).resolves.toBeUndefined()
      await expect(
        assertProductEligibility('usr-123', 'EAJO', mockDb),
      ).resolves.toBeUndefined()
    })

    it('assertProductEligibility throws INELIGIBLE_FOR_PRODUCT when ineligible', async () => {
      const mockUser = createMockUser({
        membership: { status: MembershipStatus.PENDING },
      })

      const mockDb = {
        user: {
          findUnique: vi.fn().mockResolvedValue(mockUser),
        },
      } as any

      await expect(
        assertProductEligibility('usr-123', 'LOAN', mockDb),
      ).rejects.toThrowError(AppError)
    })
  })
})
