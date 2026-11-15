import { prisma } from '@/lib/prisma'
import { UserRole } from '@/generated/prisma/enums'
import { hashSha256 } from '@/lib/authz/crypto'
import { recordAuditEvent, AuditAction, AuditOutcome } from '@/lib/services/audit.service'

export interface SessionLifetimes {
  idleMinutes: number
  absoluteHours: number
}

export const SESSION_LIFETIMES: Record<'STAFF' | 'MEMBER', SessionLifetimes> = {
  STAFF: {
    idleMinutes: 30, // 30 minutes idle
    absoluteHours: 8, // 8 hours absolute
  },
  MEMBER: {
    idleMinutes: 120, // 2 hours idle
    absoluteHours: 24 * 7, // 7 days absolute
  },
}

export function getSessionConfigForRole(role: UserRole): SessionLifetimes {
  if (role === UserRole.OWNER || role === UserRole.ADMIN) {
    return SESSION_LIFETIMES.STAFF
  }
  return SESSION_LIFETIMES.MEMBER
}

export interface CreateSessionParams {
  userId: string
  role: UserRole
  userAgentLabel?: string
  clientIp?: string
  mfaVerified?: boolean
  db?: typeof prisma
}

/**
 * Creates a new active UserSession row with role-specific idle and absolute expiry.
 */
export async function createUserSession(params: CreateSessionParams) {
  const db = params.db ?? prisma
  const config = getSessionConfigForRole(params.role)
  const now = new Date()

  const idleExpiresAt = new Date(now.getTime() + config.idleMinutes * 60 * 1000)
  const expiresAt = new Date(now.getTime() + config.absoluteHours * 60 * 60 * 1000)
  const ipHash = params.clientIp ? hashSha256(params.clientIp) : null

  return db.userSession.create({
    data: {
      userId: params.userId,
      userAgentLabel: params.userAgentLabel ?? null,
      ipHash,
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt,
      expiresAt,
      mfaVerifiedAt: params.mfaVerified ? now : null,
    },
  })
}

/**
 * Validates a session by ID against the database.
 * Rejects if revoked, absolute-expired, or idle-expired.
 * Updates lastSeenAt and extends idleExpiresAt on successful validation.
 */
export async function validateAndTouchUserSession(
  sessionId: string,
  now = new Date(),
  db: typeof prisma = prisma,
) {
  const session = await db.userSession.findUnique({
    where: { id: sessionId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          sessionVersion: true,
          isActive: true,
          mfaEnabled: true,
        },
      },
    },
  })

  if (!session || session.revokedAt) {
    return { valid: false, reason: 'REVOKED' as const }
  }

  if (session.expiresAt <= now) {
    return { valid: false, reason: 'EXPIRED_ABSOLUTE' as const }
  }

  if (session.idleExpiresAt <= now) {
    return { valid: false, reason: 'EXPIRED_IDLE' as const }
  }

  if (session.user.isActive === false) {
    return { valid: false, reason: 'USER_DEACTIVATED' as const }
  }

  // Extend idle expiration based on user role
  const config = getSessionConfigForRole(session.user.role)
  const newIdleExpiresAt = new Date(now.getTime() + config.idleMinutes * 60 * 1000)

  // Touch session in DB
  await db.userSession.update({
    where: { id: session.id },
    data: {
      lastSeenAt: now,
      idleExpiresAt: newIdleExpiresAt,
    },
  })

  return {
    valid: true,
    session,
    user: session.user,
  }
}

/**
 * Marks an individual session as revoked.
 */
export async function revokeUserSession(
  sessionId: string,
  userId?: string,
  db: typeof prisma = prisma,
) {
  const whereClause: { id: string; userId?: string } = { id: sessionId }
  if (userId) {
    whereClause.userId = userId
  }

  const result = await db.userSession.updateMany({
    where: whereClause,
    data: {
      revokedAt: new Date(),
    },
  })

  await recordAuditEvent(
    {
      actorId: userId ?? null,
      affectedUserId: userId ?? null,
      action: AuditAction.AUTH_SESSION_REVOKED,
      entityType: 'UserSession',
      entityId: sessionId,
      outcome: AuditOutcome.SUCCESS,
      metadata: { sessionId, singleRevocation: true },
    },
    db as any,
  ).catch(() => {})

  return result
}

/**
 * Revokes all sessions for a user and increments their sessionVersion.
 */
export async function revokeAllUserSessions(
  userId: string,
  db: typeof prisma = prisma,
) {
  const now = new Date()
  await db.$transaction([
    db.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    }),
    db.user.update({
      where: { id: userId },
      data: { sessionVersion: { increment: 1 } },
    }),
  ])

  await recordAuditEvent(
    {
      actorId: userId,
      affectedUserId: userId,
      action: AuditAction.AUTH_SESSION_REVOKED,
      entityType: 'UserSession',
      entityId: userId,
      outcome: AuditOutcome.SUCCESS,
      metadata: { userId, allSessionsRevoked: true },
    },
    db as any,
  ).catch(() => {})
}

/** Failed MFA challenge / step-up attempts allowed on one session before it is revoked. */
export const MAX_SESSION_CHALLENGE_FAILURES = 5

/**
 * Marks the MFA login challenge as passed on the caller's own live session and
 * clears its failure counter. Never call this for step-up (see `markSessionStepUp`).
 */
export async function markSessionMfaVerified(
  sessionId: string,
  userId: string,
  db: typeof prisma = prisma,
): Promise<boolean> {
  const now = new Date()
  const res = await db.userSession.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { mfaVerifiedAt: now, challengeFailures: 0 },
  })
  return res.count === 1
}

/**
 * Records a successful step-up re-authentication on the caller's own live session.
 */
export async function markSessionStepUp(
  sessionId: string,
  userId: string,
  db: typeof prisma = prisma,
): Promise<boolean> {
  const res = await db.userSession.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { stepUpAt: new Date(), challengeFailures: 0 },
  })
  return res.count === 1
}

/**
 * Counts a failed MFA challenge or step-up attempt on a session. When the limit is
 * reached the session is revoked, so a stolen password cannot brute-force the second factor.
 */
export async function recordSessionChallengeFailure(
  sessionId: string,
  userId: string,
  db: typeof prisma = prisma,
): Promise<{ revoked: boolean; failures: number }> {
  const updated = await db.userSession.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { challengeFailures: { increment: 1 } },
  })
  if (updated.count !== 1) {
    return { revoked: true, failures: MAX_SESSION_CHALLENGE_FAILURES }
  }

  const session = await db.userSession.findUnique({
    where: { id: sessionId },
    select: { challengeFailures: true },
  })
  const failures = session?.challengeFailures ?? MAX_SESSION_CHALLENGE_FAILURES

  if (failures >= MAX_SESSION_CHALLENGE_FAILURES) {
    await db.userSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    await recordAuditEvent(
      {
        actorId: userId,
        affectedUserId: userId,
        action: AuditAction.AUTH_SESSION_REVOKED,
        entityType: 'UserSession',
        entityId: sessionId,
        outcome: AuditOutcome.BLOCKED,
        metadata: { reason: 'TOO_MANY_CHALLENGE_FAILURES', failures },
      },
      db,
    ).catch(() => {})
    return { revoked: true, failures }
  }

  return { revoked: false, failures }
}
