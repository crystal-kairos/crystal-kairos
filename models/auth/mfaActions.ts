'use server'

import { prisma } from '@/lib/prisma'
import {
  createMfaSetupData,
  enrollMfa,
  resetUserMfa,
  verifyUserMfa,
} from '@/lib/authz/mfa'
import {
  requireAuthenticatedSession,
  requireOwner,
  requirePermission,
} from '@/lib/authz/guards'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import {
  markSessionMfaVerified,
  recordSessionChallengeFailure,
} from '@/lib/authz/sessions'
import { confirmStepUp, requireStepUp } from '@/lib/authz/step-up'
import { AppError } from '@/lib/errors/app-error'
import { recordAuditEvent, AuditAction, AuditOutcome } from '@/lib/services/audit.service'
import { AdminPermission, UserRole } from '@/generated/prisma/enums'
import { unlockUserAccount } from '@/lib/authz/lockout'

/**
 * Initiates MFA setup for the currently authenticated user.
 * Returns TOTP secret, otpauth URI, and QR code data URL.
 */
export async function initiateMfaSetupAction() {
  try {
    const actor = await requireAuthenticatedSession()
    // Replacing an existing authenticator needs a fresh step-up (P1-07).
    if (actor.mfaEnabled) {
      await requireStepUp(actor)
    }
    const setupData = await createMfaSetupData(actor.email)
    return {
      success: true,
      data: setupData,
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'initiateMfaSetupAction',
      fallbackMessage: 'Unable to initiate MFA setup. Please try again.',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
    }
  }
}

/**
 * Confirms and activates MFA setup by verifying the first TOTP code against the secret.
 * Issues and returns 10 plaintext backup codes to be saved by the user.
 */
export async function confirmMfaEnrollmentAction(formData: {
  secret: string
  token: string
}) {
  try {
    const actor = await requireAuthenticatedSession()
    if (actor.mfaEnabled) {
      await requireStepUp(actor)
    }
    const result = await enrollMfa({
      userId: actor.id,
      secret: formData.secret,
      token: formData.token,
    })

    // Proving possession of the new authenticator satisfies MFA for this session.
    if (actor.sessionId) {
      await markSessionMfaVerified(actor.sessionId, actor.id)
    }

    return {
      success: true,
      data: {
        backupCodes: result.plaintextBackupCodes,
      },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'confirmMfaEnrollmentAction',
      fallbackMessage: 'Failed to complete MFA enrollment. Please try again.',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
    }
  }
}

/**
 * MFA login challenge (P1-07). Verifies a TOTP or backup code for the signed-in user and
 * marks *their current* session as MFA-verified. The user and session come from the
 * server-side session only; nothing identifying is accepted from the browser.
 * After MAX_SESSION_CHALLENGE_FAILURES wrong codes the session is revoked.
 */
export async function verifyMfaChallengeAction(formData: { code: string }) {
  try {
    const actor = await requireAuthenticatedSession(undefined, { allowMfaPending: true })
    if (!actor.sessionId) {
      throw new AppError('UNAUTHENTICATED', 'Your session is no longer valid. Please sign in again.')
    }

    // Nothing to do if MFA is off or this session already passed the challenge.
    if (!actor.mfaEnabled || !actor.mfaPending) {
      return { success: true, data: { method: null } }
    }

    const code = typeof formData?.code === 'string' ? formData.code : ''
    const verification = code.trim()
      ? await verifyUserMfa(actor.id, code)
      : { success: false as const }

    if (!verification.success) {
      const failure = await recordSessionChallengeFailure(actor.sessionId, actor.id)
      await recordAuditEvent({
        actorId: actor.id,
        actorRole: actor.role,
        affectedUserId: actor.id,
        action: AuditAction.AUTH_MFA_CHALLENGE_FAILED,
        entityType: 'UserSession',
        entityId: actor.sessionId,
        outcome: failure.revoked ? AuditOutcome.BLOCKED : AuditOutcome.FAILURE,
        metadata: { failures: failure.failures },
      }).catch(() => {})

      if (failure.revoked) {
        return {
          success: false,
          error: 'Too many incorrect codes. Please sign in again.',
          code: 'SESSION_REVOKED',
        }
      }
      return {
        success: false,
        error: 'Invalid or already-used verification code.',
        code: 'INVALID_CREDENTIALS',
      }
    }

    const marked = await markSessionMfaVerified(actor.sessionId, actor.id)
    if (!marked) {
      throw new AppError('UNAUTHENTICATED', 'Your session is no longer valid. Please sign in again.')
    }

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      affectedUserId: actor.id,
      action: AuditAction.AUTH_MFA_CHALLENGE_PASSED,
      entityType: 'UserSession',
      entityId: actor.sessionId,
      outcome: AuditOutcome.SUCCESS,
      metadata: { method: verification.method },
    }).catch(() => {})

    return {
      success: true,
      data: { method: verification.method },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'verifyMfaChallengeAction',
      fallbackMessage: 'MFA verification failed. Please try again.',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
    }
  }
}

/**
 * Resets a member's MFA. Allowed by OWNER or admin with MEMBERS_APPROVE.
 * Only OWNER can reset an administrative staff's MFA.
 */
export async function resetMfaAction(targetUserId: string) {
  try {
    const actor = await requireAuthenticatedSession()
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true },
    })

    if (!targetUser) {
      return { success: false, error: 'User not found.', code: 'NOT_FOUND' }
    }

    if (targetUser.id === actor.id) {
      return {
        success: false,
        error: 'You cannot reset your own MFA here. Use Security settings to replace your authenticator.',
        code: 'FORBIDDEN',
      }
    }

    const isTargetStaff =
      targetUser.role === UserRole.OWNER || targetUser.role === UserRole.ADMIN

    if (isTargetStaff) {
      await requireOwner()
    } else {
      await requirePermission(AdminPermission.MEMBERS_APPROVE)
    }

    // Resetting someone's second factor is sensitive: require a fresh step-up (P1-07).
    await requireStepUp(actor)

    await resetUserMfa(targetUser.id, actor.id)

    return {
      success: true,
      data: { resetUserId: targetUser.id },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'resetMfaAction',
      fallbackMessage: 'Failed to reset MFA.',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
    }
  }
}

/**
 * Unlocks a locked user account.
 */
export async function unlockUserAccountAction(targetUserId: string) {
  try {
    const actor = await requireAuthenticatedSession()
    const isOwner = actor.role === UserRole.OWNER

    let hasMembersApprove = false
    if (!isOwner) {
      const grant = await prisma.adminPermissionGrant.findUnique({
        where: {
          adminUserId_permission: {
            adminUserId: actor.id,
            permission: AdminPermission.MEMBERS_APPROVE,
          },
        },
      })
      hasMembersApprove = Boolean(grant)
    }

    await unlockUserAccount({
      targetUserId,
      operatorRole: actor.role,
      operatorHasMembersApprove: hasMembersApprove,
    })

    return {
      success: true,
      data: { unlockedUserId: targetUserId },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'unlockUserAccountAction',
      fallbackMessage: 'Failed to unlock user account.',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
    }
  }
}

/**
 * Tells the UI which credential the signed-in user must give for step-up:
 * an MFA code when MFA is enabled, otherwise their password.
 */
export async function getStepUpMethodAction() {
  try {
    const actor = await requireAuthenticatedSession()
    return {
      success: true,
      data: { method: actor.mfaEnabled ? ('MFA' as const) : ('PASSWORD' as const) },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'getStepUpMethodAction',
      fallbackMessage: 'Unable to start verification.',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
    }
  }
}

/**
 * Confirms step-up for the current session (valid for 10 minutes).
 * MFA users must give an MFA code; other users give their password.
 */
export async function submitStepUpAction(formData: {
  password?: string
  mfaCode?: string
}) {
  try {
    const actor = await requireAuthenticatedSession()
    const result = await confirmStepUp({
      userId: actor.id,
      sessionId: actor.sessionId,
      password: formData?.password,
      mfaCode: formData?.mfaCode,
    })

    if (!result.confirmed) {
      if (result.sessionRevoked) {
        return {
          success: false,
          error: 'Too many failed attempts. Please sign in again.',
          code: 'SESSION_REVOKED',
        }
      }
      return {
        success: false,
        error: actor.mfaEnabled
          ? 'Invalid or already-used verification code.'
          : 'Incorrect password.',
        code: 'INVALID_CREDENTIALS',
      }
    }

    return { success: true }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'submitStepUpAction',
      fallbackMessage: 'Step-up authentication failed.',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
    }
  }
}
