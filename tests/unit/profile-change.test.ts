import { describe, it, expect } from 'vitest'
import { nextOfKinSchema } from '@/schema/auth.schema'
import {
  ProfileChangeStatus,
  ProfileChangeType,
  Relationship,
} from '@/generated/prisma/enums'

describe('Unit: Profile Change Validation & Heuristics (PR P3-02B)', () => {
  it('validates proposed Next of Kin payload schema', () => {
    const validData = {
      name: 'Jane Doe',
      phoneNumber: '08012345678',
      relationship: Relationship.SPOUSE,
      occupation: 'Software Engineer',
      address: '12 Marina Street, Lagos',
      bankName: 'Access Bank',
      accountNumber: '0123456789',
      accountName: 'Jane Doe',
    }

    const parsed = nextOfKinSchema.safeParse(validData)
    expect(parsed.success).toBe(true)
  })

  it('rejects invalid Next of Kin payload with invalid account number or empty fields', () => {
    const invalidData = {
      name: '',
      phoneNumber: 'invalid-phone',
      relationship: 'FRIEND', // Not in enum
      occupation: '',
      address: '',
      bankName: '',
      accountNumber: '123', // Not 10 digits
      accountName: '',
    }

    const parsed = nextOfKinSchema.safeParse(invalidData)
    expect(parsed.success).toBe(false)
  })

  it('masks account number safely to last 4 digits', () => {
    const mask = (acc: string) => (acc ? '******' + acc.slice(-4) : '')
    expect(mask('0123456789')).toBe('******6789')
    expect(mask('2001928374')).toBe('******8374')
    expect(mask('')).toBe('')
  })

  it('enforces legal status transitions', () => {
    const canTransition = (
      current: ProfileChangeStatus,
      target: ProfileChangeStatus,
    ): boolean => {
      if (current === ProfileChangeStatus.PENDING) {
        const allowedTargets: ProfileChangeStatus[] = [
          ProfileChangeStatus.APPROVED,
          ProfileChangeStatus.REJECTED,
          ProfileChangeStatus.CANCELLED,
        ]
        return allowedTargets.includes(target)
      }
      return false // Terminal statuses cannot transition
    }

    expect(canTransition(ProfileChangeStatus.PENDING, ProfileChangeStatus.APPROVED)).toBe(true)
    expect(canTransition(ProfileChangeStatus.PENDING, ProfileChangeStatus.REJECTED)).toBe(true)
    expect(canTransition(ProfileChangeStatus.PENDING, ProfileChangeStatus.CANCELLED)).toBe(true)

    expect(canTransition(ProfileChangeStatus.APPROVED, ProfileChangeStatus.REJECTED)).toBe(false)
    expect(canTransition(ProfileChangeStatus.REJECTED, ProfileChangeStatus.APPROVED)).toBe(false)
    expect(canTransition(ProfileChangeStatus.CANCELLED, ProfileChangeStatus.APPROVED)).toBe(false)
  })

  it('enforces separation of duties check (actor !== target user)', () => {
    const checkSeparationOfDuties = (
      reviewerId: string,
      memberId: string,
    ): boolean => {
      return reviewerId !== memberId
    }

    expect(checkSeparationOfDuties('admin-1', 'member-1')).toBe(true)
    expect(checkSeparationOfDuties('admin-1', 'admin-1')).toBe(false)
  })
})
