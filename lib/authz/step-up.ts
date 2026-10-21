import { prisma } from '@/lib/prisma'
import { verifyUserMfa } from '@/lib/authz/mfa'
import { AuthzError } from '@/lib/authz/guards'
import bcrypt from 'bcryptjs'

export const STEP_UP_WINDOW_MINUTES = 10

/**
 * Checks whether the current user session has a valid step-up confirmation (verified within the last 10 minutes).
 */
export async function isStepUpValid(
  userId: string,
  now = new Date(),
  db: typeof prisma = prisma,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - STEP_UP_WINDOW_MINUTES * 60 * 1000)

  // Check if any recent active session for this user has mfaVerifiedAt >= cutoff
  const recentVerification = await db.userSession.findFirst({
    where: {
      userId,
      revokedAt: null,
      mfaVerifiedAt: { gte: cutoff },
    },
  })

  return Boolean(recentVerification)
}

/**
 * Confirms step-up authentication using either an MFA token (if MFA is enabled) or password.
 */
export async function confirmStepUp(params: {
  userId: string
  sessionId?: string
  password?: string
  mfaCode?: string
  db?: typeof prisma
}): Promise<boolean> {
  const db = params.db ?? prisma

  const user = await db.user.findUnique({
    where: { id: params.userId },
    select: {
      id: true,
      mfaEnabled: true,
      passwordHash: true,
    },
  })

  if (!user) return false

  let confirmed = false

  // 1. If MFA is enabled and mfaCode provided, verify MFA
  if (user.mfaEnabled && params.mfaCode) {
    const mfaRes = await verifyUserMfa(user.id, params.mfaCode, db)
    if (mfaRes.success) {
      confirmed = true
    }
  }

  // 2. If password provided, verify password
  if (!confirmed && params.password && user.passwordHash) {
    const isMatch = await bcrypt.compare(params.password, user.passwordHash)
    if (isMatch) {
      confirmed = true
    }
  }

  if (confirmed && params.sessionId) {
    await db.userSession.update({
      where: { id: params.sessionId },
      data: { mfaVerifiedAt: new Date() },
    })
  }

  return confirmed
}

/**
 * Enforces step-up authentication. Throws AuthzError if not recently verified.
 */
export async function requireStepUp(
  userId: string,
  db: typeof prisma = prisma,
): Promise<void> {
  const valid = await isStepUpValid(userId, new Date(), db)
  if (!valid) {
    throw new AuthzError(
      'FORBIDDEN',
      'Step-up authentication required. Please re-authenticate to continue.',
    )
  }
}
