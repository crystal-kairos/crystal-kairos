'use server'

import { prisma } from '@/lib/prisma'
import { hash } from 'bcryptjs'
import { revalidatePath } from 'next/cache'
import {
  AdminPermission,
  EAjoDuration,
  EAjoFrequency,
  EAjoMemberStatus,
  EAjoStatus,
  MembershipStatus,
  NotificationEventType,
  PasswordSetupTokenPurpose,
  UserRole,
  PenaltyCapType,
  EAjoPayoutStatus,
} from '@/generated/prisma/enums'
import { Prisma } from '@/generated/prisma/client'
import { sendEmail } from '@/features/notification'
import { assignMembershipNumberWithRetry } from '@/lib/membership-number'
import { issuePasswordSetupToken } from '@/lib/authz/tokens'
import {
  assertUserHasNoMemberRecords,
  requireOwner,
  requirePermission,
} from '@/lib/authz/guards'
import { ALL_ADMIN_PERMISSIONS } from '@/lib/authz/permissions'
import { requireStepUp } from '@/lib/authz/step-up'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { AppError } from '@/lib/errors/app-error'
import { createEAjoSlotPolicies } from '@/lib/services/rate-policy.service'
import { calculateEAjoPayout } from '@/lib/domain/eajo-payout'
import { recordAuditEvent, AuditAction, AuditOutcome } from '@/lib/services/audit.service'

const validPermissionSet = new Set<string>(ALL_ADMIN_PERMISSIONS)

/**
 * Creates a new administrative staff member (ADMIN only; OWNER can only be created via CLI bootstrap).
 * Only the OWNER can create administrative staff (P1-03).
 * Staff accounts can never be members (D-15).
 */
export const createAdminStaffAction = async (formData: {
  name: string
  email: string
  role: 'ADMIN' | 'OWNER'
  password?: string
  permissions?: AdminPermission[]
}) => {
  try {
    const owner = await requireOwner()

    const { name, email, role, password, permissions = [] } = formData

    if (role !== 'ADMIN') {
      return {
        success: false,
        error: 'Only ADMIN staff accounts can be created from the dashboard.',
      }
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    })

    if (existingUser) {
      await assertUserHasNoMemberRecords(existingUser.id)
      return { success: false, error: 'User with this email already exists.' }
    }

    const validGrants = permissions.filter((p) => validPermissionSet.has(p))
    const uniqueGrants = Array.from(new Set(validGrants))

    const hasProvidedPassword = Boolean(password && password.trim().length > 0)
    const passwordHash = hasProvidedPassword
      ? await hash(password!.trim(), 12)
      : null

    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          name,
          email,
          role: UserRole.ADMIN,
          passwordHash,
          hasSetPassword: hasProvidedPassword,
        },
      })

      if (uniqueGrants.length > 0) {
        await tx.adminPermissionGrant.createMany({
          data: uniqueGrants.map((permission) => ({
            adminUserId: created.id,
            permission,
            grantedById: owner.id,
          })),
        })
      }

      await recordAuditEvent(
        {
          actorId: owner.id,
          actorRole: owner.role,
          affectedUserId: created.id,
          action: AuditAction.STAFF_CREATED,
          entityType: 'User',
          entityId: created.id,
          outcome: AuditOutcome.SUCCESS,
          metadata: {
            email: created.email,
            role: created.role,
            initialPermissionsCount: uniqueGrants.length,
          },
        },
        tx
      )

      return created
    })

    if (!hasProvidedPassword) {
      const issued = await issuePasswordSetupToken({
        userId: user.id,
        purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
        createdById: owner.id,
      })
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL ||
        process.env.NEXTAUTH_URL ||
        'http://localhost:3000'
      const setPasswordUrl = `${appUrl.replace(/\/+$/, '')}/set-password?token=${encodeURIComponent(issued.rawToken)}`

      try {
        await sendEmail({
          to: email,
          subject: 'Activate Your Crystal Kairos Staff Account',
          html: `
            <h1>Welcome to Crystal Kairos, ${name}!</h1>
            <p>A staff account has been created for you.</p>
            <p><a href="${setPasswordUrl}">Click here to set your password</a> (link expires in 24 hours).</p>
          `,
          recipientId: user.id,
          type: NotificationEventType.CUSTOM,
        })
      } catch (emailErr) {
        console.error('Staff activation email failed:', emailErr)
      }
    }

    try {
      revalidatePath('/admin/settings')
      revalidatePath('/admin/settings/permissions')
    } catch {}
    return { success: true, data: user }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'createAdminStaffAction',
      fallbackMessage: 'Failed to create staff member.',
      context: { email: formData.email, role: formData.role },
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      fieldErrors: err.fieldErrors,
      correlationId: err.correlationId,
    }
  }
}

/**
 * Replaces the full set of AdminPermission grants for a target ADMIN user.
 * Only the OWNER can grant or revoke permissions (P1-03).
 * Increments the target user's `sessionVersion` so changes take effect on the very next request.
 */
export const setAdminPermissionsAction = async (
  adminUserId: string,
  permissions: AdminPermission[],
) => {
  try {
    const owner = await requireOwner()
    // Changing staff permissions requires a fresh step-up (P1-03 / P1-07).
    await requireStepUp(owner)

    const targetUser = await prisma.user.findUnique({
      where: { id: adminUserId },
      select: { id: true, role: true },
    })

    if (!targetUser) {
      return { success: false, error: 'Staff member not found.' }
    }

    if (targetUser.role !== UserRole.ADMIN) {
      return {
        success: false,
        error: 'Permissions can only be configured for ADMIN staff accounts.',
      }
    }

    await assertUserHasNoMemberRecords(targetUser.id)

    const sanitizedPermissions = Array.from(
      new Set(permissions.filter((perm) => validPermissionSet.has(perm))),
    )

    await prisma.$transaction(async (tx) => {
      await tx.adminPermissionGrant.deleteMany({
        where: { adminUserId: targetUser.id },
      })

      if (sanitizedPermissions.length > 0) {
        await tx.adminPermissionGrant.createMany({
          data: sanitizedPermissions.map((permission) => ({
            adminUserId: targetUser.id,
            permission,
            grantedById: owner.id,
          })),
        })
      }

      await tx.user.update({
        where: { id: targetUser.id },
        data: {
          sessionVersion: { increment: 1 },
        },
      })

      await recordAuditEvent(
        {
          actorId: owner.id,
          actorRole: owner.role,
          affectedUserId: targetUser.id,
          action: AuditAction.ADMIN_PERMISSION_GRANTED,
          entityType: 'User',
          entityId: targetUser.id,
          outcome: AuditOutcome.SUCCESS,
          metadata: {
            permissions: sanitizedPermissions,
            adminUserId: targetUser.id,
          },
        },
        tx
      )
    })

    try {
      revalidatePath('/admin/settings')
      revalidatePath('/admin/settings/permissions')
    } catch {}

    return {
      success: true,
      data: {
        adminUserId: targetUser.id,
        permissions: sanitizedPermissions,
      },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'setAdminPermissionsAction',
      fallbackMessage: 'Failed to update admin permissions.',
      context: { adminUserId },
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      fieldErrors: err.fieldErrors,
      correlationId: err.correlationId,
    }
  }
}

// E-ajo group actions live in models/admin/eajoActions.ts (P3-05).

export const createMemberAction = async (formData: {
  name: string
  email: string
}) => {
  try {
    const actor = await requirePermission(AdminPermission.MEMBERS_CREATE)

    const { name, email } = formData

    // Check if user exists
    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      return { success: false, error: 'User with this email already exists.' }
    }

    const { result: user } = await assignMembershipNumberWithRetry((num) =>
      prisma.user.create({
        data: {
          name,
          email,
          passwordHash: null,
          hasSetPassword: false,
          role: UserRole.USER,
          membership: {
            create: {
              membershipNumber: num,
              status: MembershipStatus.APPROVED,
              approvedAt: new Date(),
              approvedBy: actor.id,
            },
          },
        },
      }),
    )

    const issued = await issuePasswordSetupToken({
      userId: user.id,
      purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
      createdById: actor.id,
    })

    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXTAUTH_URL ||
      'http://localhost:3000'
    const setPasswordUrl = `${appUrl.replace(/\/+$/, '')}/set-password?token=${encodeURIComponent(issued.rawToken)}`

    const emailHtml = `
      <h1>Welcome to Crystal Kairos, ${name}!</h1>
      <p>An administrator has created an account for you.</p>
      <p><a href="${setPasswordUrl}">Click here to set your password and activate your account</a> (link expires in 24 hours).</p>
    `

    try {
      await sendEmail({
        to: email,
        subject: 'Welcome to Crystal Kairos - Activate Your Account',
        html: emailHtml,
        recipientId: user.id,
        type: NotificationEventType.CUSTOM,
      })
    } catch (emailErr) {
      console.error('Member activation email failed:', emailErr)
    }

    try {
      revalidatePath('/admin/members')
    } catch {}
    return { success: true, data: user }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'createMemberAction',
      fallbackMessage: 'Failed to create member.',
      context: { email: formData.email },
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      fieldErrors: err.fieldErrors,
      correlationId: err.correlationId,
    }
  }
}
