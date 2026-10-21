import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  createUserSession,
  validateAndTouchUserSession,
  revokeUserSession,
  revokeAllUserSessions,
  SESSION_LIFETIMES,
} from '@/lib/authz/sessions'
import { UserRole } from '@/generated/prisma/enums'

describe('Revocable Database-Backed Sessions (P1-07, A-17)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('configures distinct idle and absolute lifetimes for staff vs members', () => {
    expect(SESSION_LIFETIMES.STAFF.idleMinutes).toBe(30)
    expect(SESSION_LIFETIMES.STAFF.absoluteHours).toBe(8)

    expect(SESSION_LIFETIMES.MEMBER.idleMinutes).toBe(120)
    expect(SESSION_LIFETIMES.MEMBER.absoluteHours).toBe(24 * 7)
  })

  it('creates sessions with appropriate expiration timestamps', async () => {
    let capturedSessionData: Record<string, unknown> = {}

    vi.spyOn(prisma.userSession, 'create').mockImplementation((async (args: {
      data: Record<string, unknown>
    }) => {
      capturedSessionData = args.data
      return { id: 'session-staff-1', ...args.data }
    }) as never)

    const now = new Date()
    const session = await createUserSession({
      userId: 'staff-user-1',
      role: UserRole.ADMIN,
      clientIp: '192.168.1.10',
      userAgentLabel: 'Chrome MacOS',
    })

    expect(session.id).toBe('session-staff-1')
    expect(capturedSessionData.userId).toBe('staff-user-1')
    expect(capturedSessionData.userAgentLabel).toBe('Chrome MacOS')
    expect(capturedSessionData.ipHash).toBeDefined()

    const idleExp = capturedSessionData.idleExpiresAt as Date
    const absExp = capturedSessionData.expiresAt as Date

    // Staff: 30 mins idle, 8 hours absolute
    expect(idleExp.getTime() - now.getTime()).toBeCloseTo(30 * 60 * 1000, -3)
    expect(absExp.getTime() - now.getTime()).toBeCloseTo(8 * 60 * 60 * 1000, -3)
  })

  it('rejects idle-expired, absolute-expired, or revoked sessions', async () => {
    const baseDate = new Date('2026-10-21T12:00:00Z')

    // 1. Revoked session
    vi.spyOn(prisma.userSession, 'findUnique').mockResolvedValueOnce({
      id: 'revoked-session',
      userId: 'user-1',
      revokedAt: new Date('2026-10-21T11:00:00Z'),
      expiresAt: new Date('2026-10-21T18:00:00Z'),
      idleExpiresAt: new Date('2026-10-21T12:30:00Z'),
      user: { id: 'user-1', isActive: true, role: UserRole.USER },
    } as never)

    const resRevoked = await validateAndTouchUserSession('revoked-session', baseDate)
    expect(resRevoked.valid).toBe(false)
    expect(resRevoked.reason).toBe('REVOKED')

    // 2. Absolute-expired session
    vi.spyOn(prisma.userSession, 'findUnique').mockResolvedValueOnce({
      id: 'abs-expired',
      userId: 'user-1',
      revokedAt: null,
      expiresAt: new Date('2026-10-21T11:59:00Z'),
      idleExpiresAt: new Date('2026-10-21T12:30:00Z'),
      user: { id: 'user-1', isActive: true, role: UserRole.USER },
    } as never)

    const resAbs = await validateAndTouchUserSession('abs-expired', baseDate)
    expect(resAbs.valid).toBe(false)
    expect(resAbs.reason).toBe('EXPIRED_ABSOLUTE')

    // 3. Idle-expired session
    vi.spyOn(prisma.userSession, 'findUnique').mockResolvedValueOnce({
      id: 'idle-expired',
      userId: 'user-1',
      revokedAt: null,
      expiresAt: new Date('2026-10-21T18:00:00Z'),
      idleExpiresAt: new Date('2026-10-21T11:59:00Z'),
      user: { id: 'user-1', isActive: true, role: UserRole.USER },
    } as never)

    const resIdle = await validateAndTouchUserSession('idle-expired', baseDate)
    expect(resIdle.valid).toBe(false)
    expect(resIdle.reason).toBe('EXPIRED_IDLE')
  })

  it('revokes a specific session or all user sessions atomically with sessionVersion increment', async () => {
    let singleRevokedId: string | null = null
    let allRevokedUserId: string | null = null
    let bumpedVersionUserId: string | null = null

    vi.spyOn(prisma.userSession, 'updateMany').mockImplementation((async (args: {
      where: { id?: string; userId?: string }
    }) => {
      if (args.where.id) singleRevokedId = args.where.id
      if (args.where.userId) allRevokedUserId = args.where.userId
      return { count: 1 }
    }) as never)

    vi.spyOn(prisma.user, 'update').mockImplementation((async (args: {
      where: { id: string }
    }) => {
      bumpedVersionUserId = args.where.id
      return {}
    }) as never)

    vi.spyOn(prisma, '$transaction').mockImplementation((async (promises: unknown[]) => {
      return Promise.all(promises)
    }) as never)

    await revokeUserSession('session-xyz', 'user-123')
    expect(singleRevokedId).toBe('session-xyz')

    await revokeAllUserSessions('user-123')
    expect(allRevokedUserId).toBe('user-123')
    expect(bumpedVersionUserId).toBe('user-123')
  })
})
