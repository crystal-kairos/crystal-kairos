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
} from '@/generated/prisma/enums'
import { sendEmail } from '@/features/notification'
import { generateMembershipNumber } from '@/lib/membership-number'
import { issuePasswordSetupToken } from '@/lib/authz/tokens'
import {
  assertUserHasNoMemberRecords,
  AuthzError,
  requireOwner,
  requirePermission,
} from '@/lib/authz/guards'
import { ALL_ADMIN_PERMISSIONS } from '@/lib/authz/permissions'

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
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error creating admin staff member:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to create staff member.',
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
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error updating admin permissions:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to update admin permissions.',
    }
  }
}

// ============================================
// E-AJO GROUP ADMIN ACTIONS
// ============================================

const durationToSlots: Record<EAjoDuration, number> = {
  [EAjoDuration.FOUR_MONTHS]: 4,
  [EAjoDuration.SIX_MONTHS]: 6,
  [EAjoDuration.TWELVE_MONTHS]: 12,
}

/**
 * Admin creates a new eAjo group pool
 */
export const createEAjoGroupAction = async (formData: {
  title: string
  description?: string
  contributionAmount: number
  frequency: EAjoFrequency
  duration: EAjoDuration
  startDate?: string
}) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_MANAGE)

    const totalSlots = durationToSlots[formData.duration]

    const group = await prisma.eAjoGroup.create({
      data: {
        title: formData.title,
        description: formData.description,
        contributionAmount: formData.contributionAmount,
        frequency: formData.frequency,
        duration: formData.duration,
        totalSlots,
        filledSlots: 0,
        status: EAjoStatus.PENDING,
        startDate: formData.startDate ? new Date(formData.startDate) : null,
        createdBy: actor.id,
      },
    })

    try {
      revalidatePath('/admin/eajo')
    } catch {}
    return {
      success: true,
      data: { ...group, contributionAmount: Number(group.contributionAmount) },
    }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error creating eAjo group:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to create eAjo group.',
    }
  }
}

/**
 * Admin updates an existing eAjo group (only while PENDING)
 */
export const updateEAjoGroupAction = async (
  groupId: string,
  formData: {
    title?: string
    description?: string
    contributionAmount?: number
    frequency?: EAjoFrequency
    startDate?: string | null
  },
) => {
  try {
    await requirePermission(AdminPermission.EAJO_MANAGE)

    const group = await prisma.eAjoGroup.findUnique({ where: { id: groupId } })
    if (!group) return { success: false, error: 'Group not found.' }
    if (group.status !== EAjoStatus.PENDING) {
      return { success: false, error: 'Only PENDING groups can be edited.' }
    }

    const updated = await prisma.eAjoGroup.update({
      where: { id: groupId },
      data: {
        ...(formData.title && { title: formData.title }),
        ...(formData.description !== undefined && {
          description: formData.description,
        }),
        ...(formData.contributionAmount && {
          contributionAmount: formData.contributionAmount,
        }),
        ...(formData.frequency && { frequency: formData.frequency }),
        ...(formData.startDate !== undefined && {
          startDate: formData.startDate ? new Date(formData.startDate) : null,
        }),
      },
    })

    try {
      revalidatePath('/admin/eajo')
      revalidatePath(`/admin/eajo/${groupId}`)
    } catch {}
    return {
      success: true,
      data: {
        ...updated,
        contributionAmount: Number(updated.contributionAmount),
      },
    }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error updating eAjo group:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to update eAjo group.',
    }
  }
}

/**
 * Admin activates an eAjo group — sets status to ACTIVE, promotes approved members to ACTIVE
 */
export const activateEAjoGroupAction = async (groupId: string) => {
  try {
    await requirePermission(AdminPermission.EAJO_MANAGE)

    const group = await prisma.eAjoGroup.findUnique({ where: { id: groupId } })
    if (!group) return { success: false, error: 'Group not found.' }

    const updated = await prisma.eAjoGroup.update({
      where: { id: groupId },
      data: {
        status: EAjoStatus.ACTIVE,
        startDate: group.startDate ?? new Date(),
      },
    })

    await prisma.eAjoMember.updateMany({
      where: { groupId, status: EAjoMemberStatus.APPROVED },
      data: { status: EAjoMemberStatus.ACTIVE },
    })

    try {
      revalidatePath('/admin/eajo')
      revalidatePath(`/admin/eajo/${groupId}`)
    } catch {}
    return { success: true, data: updated }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error activating eAjo group:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to activate eAjo group.',
    }
  }
}

/**
 * Admin approves a member's slot application
 */
export const approveEAjoMemberAction = async (memberId: string) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_MANAGE)

    const member = await prisma.eAjoMember.findUnique({
      where: { id: memberId },
    })
    if (!member)
      return { success: false, error: 'Member application not found.' }

    const updated = await prisma.eAjoMember.update({
      where: { id: memberId },
      data: {
        status: EAjoMemberStatus.APPROVED,
        approvedAt: new Date(),
        approvedBy: actor.id,
      },
    })

    // Increment filled slots count
    await prisma.eAjoGroup.update({
      where: { id: member.groupId },
      data: { filledSlots: { increment: 1 } },
    })

    try {
      revalidatePath('/admin/eajo')
      revalidatePath(`/admin/eajo/${member.groupId}`)
    } catch {}
    return { success: true, data: updated }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error approving eAjo member:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to approve member.',
    }
  }
}

/**
 * Admin rejects a member application with a mandatory reason
 */
export const rejectEAjoMemberAction = async (
  memberId: string,
  rejectionReason: string,
) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_MANAGE)

    const member = await prisma.eAjoMember.findUnique({
      where: { id: memberId },
    })
    if (!member)
      return { success: false, error: 'Member application not found.' }

    const updated = await prisma.eAjoMember.update({
      where: { id: memberId },
      data: {
        status: EAjoMemberStatus.REJECTED,
        rejectionReason,
        approvedBy: actor.id,
      },
    })

    try {
      revalidatePath('/admin/eajo')
      revalidatePath(`/admin/eajo/${member.groupId}`)
    } catch {}
    return { success: true, data: updated }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error rejecting eAjo member:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to reject member application.',
    }
  }
}

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

    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: null,
        hasSetPassword: false,
        role: UserRole.USER,
        membership: {
          create: {
            membershipNumber: generateMembershipNumber(),
            status: MembershipStatus.APPROVED,
            approvedAt: new Date(),
            approvedBy: actor.id,
          },
        },
      },
    })

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
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error creating member:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to create member.',
    }
  }
}
