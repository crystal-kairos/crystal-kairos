import { describe, it, expect, vi } from 'vitest'
import {
  formatMembershipNumber,
  parseMembershipNumber,
  getNextMembershipNumber,
  assignMembershipNumberWithRetry,
} from '@/lib/membership-number'

describe('Membership number generator (PR P1-08)', () => {
  it('formats numeric sequences as 6-digit padded strings with CK- prefix', () => {
    expect(formatMembershipNumber(1)).toBe('CK-000001')
    expect(formatMembershipNumber(42)).toBe('CK-000042')
    expect(formatMembershipNumber(999999)).toBe('CK-999999')
    expect(formatMembershipNumber(0)).toBe('CK-000001')
    expect(formatMembershipNumber(-5)).toBe('CK-000001')
  })

  it('parses valid CK- numbers and returns null for invalid formats', () => {
    expect(parseMembershipNumber('CK-000001')).toBe(1)
    expect(parseMembershipNumber('CK-000123')).toBe(123)
    expect(parseMembershipNumber('CK-999999')).toBe(999999)
    expect(parseMembershipNumber('CRK-ABC-123')).toBeNull()
    expect(parseMembershipNumber('INVALID')).toBeNull()
  })

  it('computes next membership number from DB state', async () => {
    const mockDbEmpty = {
      membership: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as any

    const next1 = await getNextMembershipNumber(mockDbEmpty)
    expect(next1).toBe('CK-000001')

    const mockDbWithExisting = {
      membership: {
        findFirst: vi.fn().mockResolvedValue({
          membershipNumber: 'CK-000042',
        }),
      },
    } as any

    const next2 = await getNextMembershipNumber(mockDbWithExisting)
    expect(next2).toBe('CK-000043')
  })

  it('retries with the next sequence number on collision', async () => {
    const mockDb = {
      membership: {
        findFirst: vi.fn().mockResolvedValue({
          membershipNumber: 'CK-000010',
        }),
      },
    } as any

    let callCount = 0
    const attemptTracker: string[] = []

    const { membershipNumber, result } = await assignMembershipNumberWithRetry(
      async (candidate) => {
        callCount++
        attemptTracker.push(candidate)
        if (callCount < 3) {
          // Simulate unique collision error (Prisma code P2002)
          const err: any = new Error('Unique constraint failed on the fields: (`membershipNumber`)')
          err.code = 'P2002'
          err.meta = { target: ['membershipNumber'] }
          throw err
        }
        return { success: true }
      },
      mockDb,
    )

    expect(callCount).toBe(3)
    expect(attemptTracker).toEqual(['CK-000011', 'CK-000012', 'CK-000013'])
    expect(membershipNumber).toBe('CK-000013')
    expect(result).toEqual({ success: true })
  })
})
