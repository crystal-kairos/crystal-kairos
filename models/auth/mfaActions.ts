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
import { markSessionMfaVerified } from '@/lib/authz/sessions'
import { confirmStepUp } from '@/lib/authz/step-up'
import { AdminPermission, UserRole } from '@/generated/prisma/enums'
import { unlockUserAccount } from '@/lib/authz/lockout'

/**
 * Initiates MFA setup for the currently authenticated user.
 * Returns TOTP secret, otpauth URI, and QR code data URL.
 */
export async function initiateMfaSetupAction() {
  try {
    const actor = await requireAuthenticatedSession()
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
    const result = await enrollMfa({
      userId: actor.id,
      secret: formData.secret,
      token: formData.token,
    })

    if (actor.sessionId) {
      await markSessionMfaVerified(actor.sessionId)
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
 * Verifies MFA code during login challenge and marks the active UserSession as MFA-verified.
 */
export async function verifyMfaChallengeAction(formData: {
  userId: string
  code: string
  sessionId?: string
}) {
  try {
    const verification = await verifyUserMfa(formData.userId, formData.code)
    if (!verification.success) {
      return {
        success: false,
        error: 'Invalid or already-used verification code.',
        code: 'INVALID_CREDENTIALS',
      }
    }

    if (formData.sessionId) {
      await markSessionMfaVerified(formData.sessionId)
    }

    return {
      success: true,
      data: {
        method: verification.method,
      },
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

    const isTargetStaff =
      targetUser.role === UserRole.OWNER || targetUser.role === UserRole.ADMIN

    if (isTargetStaff) {
      await requireOwner()
    } else {
      await requirePermission(AdminPermission.MEMBERS_APPROVE)
    }

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
 * Submits step-up authentication (recent MFA or password confirmation).
 */
export async function submitStepUpAction(formData: {
  password?: string
  mfaCode?: string
}) {
  try {
    const actor = await requireAuthenticatedSession()
    const confirmed = await confirmStepUp({
      userId: actor.id,
      sessionId: actor.sessionId,
      password: formData.password,
      mfaCode: formData.mfaCode,
    })

    if (!confirmed) {
      return {
        success: false,
        error: 'Invalid password or verification code.',
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
