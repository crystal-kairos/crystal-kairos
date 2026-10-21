import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  checkLockout,
  recordLoginAttempt,
  unlockUserAccount,
  calculateLockoutExpiry,
} from '@/lib/authz/lockout'
import { UserRole } from '@/generated/prisma/enums'

describe('Account Lockout & Throttling (P1-07, A-17)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('calculates exponential doubling lockout times up to 24 hours', () => {
    const baseDate = new Date('2026-10-21T10:00:00.000Z')
    // 1st lockout: 15m
    const lock1 = calculateLockoutExpiry(1, baseDate)
    expect(lock1.getTime() - baseDate.getTime()).toBe(15 * 60 * 1000)

    // 2nd lockout: 30m
    const lock2 = calculateLockoutExpiry(2, baseDate)
    expect(lock2.getTime() - baseDate.getTime()).toBe(30 * 60 * 1000)

    // 3rd lockout: 60m
    const lock3 = calculateLockoutExpiry(3, baseDate)
    expect(lock3.getTime() - baseDate.getTime()).toBe(60 * 60 * 1000)

    // Repeated high count capped at 24 hours
    const lockMax = calculateLockoutExpiry(10, baseDate)
    expect(lockMax.getTime() - baseDate.getTime()).toBe(24 * 60 * 60 * 1000)
  })

  it('locks an account after 5 failed attempts within 15 minutes', async () => {
    let userLockedUntil: Date | null = null
    let lockoutCount = 0

    vi.spyOn(prisma.user, 'findFirst').mockImplementation((async () => {
      return {
        id: 'user-lock-test',
        lockedUntil: userLockedUntil,
        lockoutCount,
      }
    }) as never)

    vi.spyOn(prisma.user, 'findUnique').mockImplementation((async () => {
      return {
        id: 'user-lock-test',
        lockedUntil: userLockedUntil,
        lockoutCount,
      }
    }) as never)

    vi.spyOn(prisma.user, 'update').mockImplementation((async (args: {
      data: { lockedUntil?: Date | null; lockoutCount?: number }
    }) => {
      if (args.data.lockedUntil !== undefined) userLockedUntil = args.data.lockedUntil
      if (args.data.lockoutCount !== undefined) lockoutCount = args.data.lockoutCount
      return {}
    }) as never)

    let failedAttempts = 0
    vi.spyOn(prisma.loginAttempt, 'create').mockImplementation((async () => {
      failedAttempts++
      return {}
    }) as never)

    vi.spyOn(prisma.loginAttempt, 'count').mockImplementation((async () => {
      return failedAttempts
    }) as never)

    // Attempts 1 to 4 do not lock
    for (let i = 1; i <= 4; i++) {
      const res = await recordLoginAttempt({
        email: 'victim@crystalkairos.coop',
        succeeded: false,
        userId: 'user-lock-test',
      })
      expect(res.newlyLocked).toBe(false)
      expect(userLockedUntil).toBeNull()
    }

    // 5th failed attempt locks the account
    const fifth = await recordLoginAttempt({
      email: 'victim@crystalkairos.coop',
      succeeded: false,
      userId: 'user-lock-test',
    })
    expect(fifth.newlyLocked).toBe(true)
    expect(userLockedUntil).not.toBeNull()
    expect(lockoutCount).toBe(1)

    // Check lockout verification
    const status = await checkLockout('victim@crystalkairos.coop')
    expect(status.isLocked).toBe(true)
    expect(status.remainingMinutes).toBeGreaterThanOrEqual(14)
  })

  it('restricts unlock permissions: admin can unlock member; only owner can unlock staff', async () => {
    let lockedState = true

    vi.spyOn(prisma.user, 'findUnique').mockImplementation((async (args: {
      where: { id: string }
    }) => {
      if (args.where.id === 'member-1') {
        return { id: 'member-1', role: UserRole.USER }
      }
      if (args.where.id === 'admin-1') {
        return { id: 'admin-1', role: UserRole.ADMIN }
      }
      return null
    }) as never)

    vi.spyOn(prisma.user, 'update').mockImplementation((async () => {
      lockedState = false
      return {}
    }) as never)

    // Admin without MEMBERS_APPROVE cannot unlock member
    await expect(
      unlockUserAccount({
        targetUserId: 'member-1',
        operatorRole: UserRole.ADMIN,
        operatorHasMembersApprove: false,
      }),
    ).rejects.toThrow(/Insufficient permissions/)

    // Admin with MEMBERS_APPROVE can unlock member
    await unlockUserAccount({
      targetUserId: 'member-1',
      operatorRole: UserRole.ADMIN,
      operatorHasMembersApprove: true,
    })
    expect(lockedState).toBe(false)

    // Admin cannot unlock another admin
    await expect(
      unlockUserAccount({
        targetUserId: 'admin-1',
        operatorRole: UserRole.ADMIN,
        operatorHasMembersApprove: true,
      }),
    ).rejects.toThrow(/Only the cooperative owner can unlock administrative staff/)

    // Owner can unlock admin
    await unlockUserAccount({
      targetUserId: 'admin-1',
      operatorRole: UserRole.OWNER,
      operatorHasMembersApprove: false,
    })
    expect(lockedState).toBe(false)
  })
})
