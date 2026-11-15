import { prisma } from '@/lib/prisma'
import { verifyUserMfa } from '@/lib/authz/mfa'
import { AuthzError } from '@/lib/authz/guards'
import {
  markSessionStepUp,
  recordSessionChallengeFailure,
} from '@/lib/authz/sessions'
import { recordAuditEvent, AuditAction, AuditOutcome } from '@/lib/services/audit.service'
import bcrypt from 'bcryptjs'

/**
 * Step-up re-authentication (P1-07).
 *
 * - Step-up is recorded per session in `UserSession.stepUpAt` and is valid for
 *   STEP_UP_WINDOW_MINUTES. It never sets `mfaVerifiedAt`, so it cannot be used to skip
 *   the MFA login challenge.
 * - A user with MFA enabled must step up with an MFA code (TOTP or backup code);
 *   a user without MFA steps up with their password.
 * - Failed attempts count towards the session's challenge-failure limit.
 */

export const STEP_UP_WINDOW_MINUTES = 10

export interface StepUpActor {
  id: string
  sessionId?: string
}

/**
 * True when this specific session confirmed step-up within the window.
 */
export async function isStepUpValid(
  sessionId: string | undefined,
  now = new Date(),
  db: typeof prisma = prisma,
): Promise<boolean> {
  if (!sessionId) return false
  const cutoff = new Date(now.getTime() - STEP_UP_WINDOW_MINUTES * 60 * 1000)

  const session = await db.userSession.findFirst({
    where: {
      id: sessionId,
      revokedAt: null,
      stepUpAt: { gte: cutoff },
    },
    select: { id: true },
  })

  return Boolean(session)
}

/**
 * Confirms step-up for the actor's current session. Returns false (and counts a failure)
 * when the credential is wrong or missing for the user's step-up method.
 */
export async function confirmStepUp(params: {
  userId: string
  sessionId?: string
  password?: string
  mfaCode?: string
  db?: typeof prisma
}): Promise<{ confirmed: boolean; sessionRevoked?: boolean }> {
  const db = params.db ?? prisma
  if (!params.sessionId) return { confirmed: false }

  const user = await db.user.findUnique({
    where: { id: params.userId },
    select: { id: true, mfaEnabled: true, passwordHash: true },
  })
  if (!user) return { confirmed: false }

  let confirmed = false
  if (user.mfaEnabled) {
    if (params.mfaCode) {
      const mfaRes = await verifyUserMfa(user.id, params.mfaCode, db)
      confirmed = mfaRes.success
    }
  } else if (params.password && user.passwordHash) {
    confirmed = await bcrypt.compare(params.password, user.passwordHash)
  }

  if (confirmed) {
    confirmed = await markSessionStepUp(params.sessionId, user.id, db)
  }

  await recordAuditEvent(
    {
      actorId: user.id,
      affectedUserId: user.id,
      action: confirmed ? AuditAction.AUTH_STEP_UP_CONFIRMED : AuditAction.AUTH_STEP_UP_FAILED,
      entityType: 'UserSession',
      entityId: params.sessionId,
      outcome: confirmed ? AuditOutcome.SUCCESS : AuditOutcome.FAILURE,
      metadata: { method: user.mfaEnabled ? 'MFA' : 'PASSWORD' },
    },
    db,
  ).catch(() => {})

  if (!confirmed) {
    const failure = await recordSessionChallengeFailure(params.sessionId, user.id, db)
    return { confirmed: false, sessionRevoked: failure.revoked }
  }

  return { confirmed: true }
}

/**
 * Enforces a recent step-up on the actor's current session.
 * Throws AuthzError('STEP_UP_REQUIRED') so the UI can prompt and retry.
 */
export async function requireStepUp(
  actor: StepUpActor,
  db: typeof prisma = prisma,
): Promise<void> {
  const valid = await isStepUpValid(actor.sessionId, new Date(), db)
  if (!valid) {
    throw new AuthzError(
      'STEP_UP_REQUIRED',
      'Please confirm it is you to continue.',
    )
  }
}
