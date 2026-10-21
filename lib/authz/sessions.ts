import { prisma } from '@/lib/prisma'
import { UserRole } from '@/generated/prisma/enums'
import { hashSha256 } from '@/lib/authz/crypto'

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

  return db.userSession.updateMany({
    where: whereClause,
    data: {
      revokedAt: new Date(),
    },
  })
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
}

/**
 * Marks MFA as verified on an existing session.
 */
export async function markSessionMfaVerified(
  sessionId: string,
  db: typeof prisma = prisma,
) {
  return db.userSession.update({
    where: { id: sessionId },
    data: {
      mfaVerifiedAt: new Date(),
    },
  })
}
