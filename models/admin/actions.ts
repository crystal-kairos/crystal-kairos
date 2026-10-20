'use server'

import { prisma } from '@/lib/prisma'
import { getSessionHelper } from '../members/actions'
import { hash } from 'bcryptjs'
import { revalidatePath } from 'next/cache'
import { UserRole, EAjoFrequency, EAjoDuration, EAjoStatus, EAjoMemberStatus, NotificationEventType, MembershipStatus, PasswordSetupTokenPurpose } from '@/generated/prisma/enums'
import { sendEmail } from '@/features/notification'
import { generateMembershipNumber } from '@/lib/membership-number'
import { issuePasswordSetupToken } from '@/lib/authz/tokens'

/**
 * Creates a new administrative staff member (ADMIN or OWNER)
 */
export const createAdminStaffAction = async (formData: {
  name: string
  email: string
  role: 'ADMIN' | 'OWNER'
  password?: string
}) => {
  try {
    const session = await getSessionHelper()
    if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized admin access.' }
    }

    const { name, email, role, password } = formData

    const existingUser = await prisma.user.findUnique({ where: { email } })
    if (existingUser) {
      return { success: false, error: 'User with this email already exists.' }
    }

    const hasProvidedPassword = Boolean(password && password.trim().length > 0)
    const passwordHash = hasProvidedPassword ? await hash(password!.trim(), 12) : null

    const user = await prisma.user.create({
      data: {
        name,
        email,
        role: role as UserRole,
        passwordHash,
        hasSetPassword: hasProvidedPassword,
      },
    })

    if (!hasProvidedPassword) {
      const issued = await issuePasswordSetupToken({
        userId: user.id,
        purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
        createdById: session.user.id,
      })
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000'
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

    try { revalidatePath('/admin/settings') } catch {}
    return { success: true, data: user }
  } catch (error) {
    console.error('Error creating admin staff member:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create staff member.',
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
    const session = await getSessionHelper()
    if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized admin access.' }
    }

    // Verify the user actually exists in the DB (prevents foreign key errors on stale dev sessions)
    const adminUser = await prisma.user.findUnique({ where: { id: session.user.id } })
    if (!adminUser) {
      return { success: false, error: 'Session invalid. Please log out and log back in.' }
    }

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
        createdBy: session.user.id,
      },
    })

    try { revalidatePath('/admin/eajo') } catch {}
    return { success: true, data: { ...group, contributionAmount: Number(group.contributionAmount) } }
  } catch (error) {
    console.error('Error creating eAjo group:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create eAjo group.',
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
  }
) => {
  try {
    const session = await getSessionHelper()
    if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized admin access.' }
    }

    const group = await prisma.eAjoGroup.findUnique({ where: { id: groupId } })
    if (!group) return { success: false, error: 'Group not found.' }
    if (group.status !== EAjoStatus.PENDING) {
      return { success: false, error: 'Only PENDING groups can be edited.' }
    }

    const updated = await prisma.eAjoGroup.update({
      where: { id: groupId },
      data: {
        ...(formData.title && { title: formData.title }),
        ...(formData.description !== undefined && { description: formData.description }),
        ...(formData.contributionAmount && { contributionAmount: formData.contributionAmount }),
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
    return { success: true, data: { ...updated, contributionAmount: Number(updated.contributionAmount) } }
  } catch (error) {
    console.error('Error updating eAjo group:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update eAjo group.',
    }
  }
}

/**
 * Admin activates an eAjo group — sets status to ACTIVE, promotes approved members to ACTIVE
 */
export const activateEAjoGroupAction = async (groupId: string) => {
  try {
    const session = await getSessionHelper()
    if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized admin access.' }
    }

    const group = await prisma.eAjoGroup.findUnique({ where: { id: groupId } })
    if (!group) return { success: false, error: 'Group not found.' }

    const updated = await prisma.eAjoGroup.update({
      where: { id: groupId },
      data: { status: EAjoStatus.ACTIVE, startDate: group.startDate ?? new Date() },
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
    console.error('Error activating eAjo group:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to activate eAjo group.',
    }
  }
}

/**
 * Admin approves a member's slot application
 */
export const approveEAjoMemberAction = async (memberId: string) => {
  try {
    const session = await getSessionHelper()
    if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized admin access.' }
    }

    const member = await prisma.eAjoMember.findUnique({ where: { id: memberId } })
    if (!member) return { success: false, error: 'Member application not found.' }

    const updated = await prisma.eAjoMember.update({
      where: { id: memberId },
      data: { status: EAjoMemberStatus.APPROVED, approvedAt: new Date(), approvedBy: session.user.id },
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
    console.error('Error approving eAjo member:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to approve member.',
    }
  }
}

/**
 * Admin rejects a member application with a mandatory reason
 */
export const rejectEAjoMemberAction = async (memberId: string, rejectionReason: string) => {
  try {
    const session = await getSessionHelper()
    if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized admin access.' }
    }

    const member = await prisma.eAjoMember.findUnique({ where: { id: memberId } })
    if (!member) return { success: false, error: 'Member application not found.' }

    const updated = await prisma.eAjoMember.update({
      where: { id: memberId },
      data: { status: EAjoMemberStatus.REJECTED, rejectionReason, approvedBy: session.user.id },
    })

    try {
      revalidatePath('/admin/eajo')
      revalidatePath(`/admin/eajo/${member.groupId}`)
    } catch {}
    return { success: true, data: updated }
  } catch (error) {
    console.error('Error rejecting eAjo member:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reject member application.',
    }
  }
}

export const createMemberAction = async (formData: {
  name: string
  email: string
}) => {
  try {
    const session = await getSessionHelper()
    if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized.' }
    }

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
            approvedBy: session.user.id,
          }
        }
      }
    })

    const issued = await issuePasswordSetupToken({
      userId: user.id,
      purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
      createdById: session.user.id,
    })

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000'
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

    try { revalidatePath('/admin/members') } catch {}
    return { success: true, data: user }
  } catch (error: unknown) {
    console.error('Error creating member:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create member.',
    }
  }
}
