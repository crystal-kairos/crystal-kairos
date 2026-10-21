'use server'

import { prisma } from '@/lib/prisma'
import {
  requireAuthenticatedSession,
} from '@/lib/authz/guards'
import {
  revokeAllUserSessions,
  revokeUserSession,
} from '@/lib/authz/sessions'
import { toActionErrorResult } from '@/lib/errors/to-action-result'

/**
 * Returns all active (non-revoked, unexpired) sessions for the calling user.
 */
export async function getActiveSessionsAction() {
  try {
    const actor = await requireAuthenticatedSession()
    const now = new Date()

    const sessions = await prisma.userSession.findMany({
      where: {
        userId: actor.id,
        revokedAt: null,
        expiresAt: { gt: now },
        idleExpiresAt: { gt: now },
      },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        idleExpiresAt: true,
        userAgentLabel: true,
        mfaVerifiedAt: true,
      },
    })

    return {
      success: true,
      data: sessions.map((s) => ({
        ...s,
        isCurrent: s.id === actor.sessionId,
      })),
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'getActiveSessionsAction',
      fallbackMessage: 'Unable to load active sessions.',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
    }
  }
}

/**
 * Revokes a specific session for the authenticated user.
 */
export async function revokeSessionAction(sessionId: string) {
  try {
    const actor = await requireAuthenticatedSession()
    await revokeUserSession(sessionId, actor.id)
    return { success: true }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'revokeSessionAction',
      fallbackMessage: 'Failed to revoke session.',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
    }
  }
}

/**
 * Revokes all sessions for the authenticated user and increments their sessionVersion.
 */
export async function revokeAllSessionsAction() {
  try {
    const actor = await requireAuthenticatedSession()
    await revokeAllUserSessions(actor.id)
    return { success: true }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'revokeAllSessionsAction',
      fallbackMessage: 'Failed to revoke sessions.',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
    }
  }
}
