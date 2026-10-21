import { prisma } from '@/lib/prisma'
import { AdminPermission, EAjoStatus } from '@/generated/prisma/enums'
import {
  requireAuthenticatedSession,
  requireMemberOrStaffWithPermission,
} from '@/lib/authz/guards'

/**
 * Fetches all open eAjo groups (PENDING status with available slots) for member browsing
 */
export const getOpenEAjoGroups = async () => {
  try {
    await requireAuthenticatedSession()

    const groups = await prisma.eAjoGroup.findMany({
      where: { status: { in: [EAjoStatus.PENDING, EAjoStatus.ACTIVE] } },
      orderBy: { createdAt: 'desc' },
      include: {
        members: {
          select: { payoutPosition: true, status: true },
        },
      },
    })

    const serialized = groups.map((g) => ({
      ...g,
      contributionAmount: Number(g.contributionAmount),
    }))

    return { success: true, data: serialized }
  } catch (error) {
    return { success: false, data: [], error: error as Error }
  }
}

/**
 * Fetches all eAjo group memberships for a specific user
 */
export const getUserEAjoMemberships = async (userId: string) => {
  try {
    await requireMemberOrStaffWithPermission(userId, [
      AdminPermission.EAJO_READ,
      AdminPermission.EAJO_MANAGE,
      AdminPermission.EAJO_PAYMENTS_REVIEW,
      AdminPermission.EAJO_PAYOUTS_MANAGE,
      AdminPermission.MEMBERS_READ,
    ])

    const memberships = await prisma.eAjoMember.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        group: {
          select: {
            id: true,
            title: true,
            description: true,
            contributionAmount: true,
            frequency: true,
            duration: true,
            totalSlots: true,
            filledSlots: true,
            status: true,
            startDate: true,
            endDate: true,
          },
        },
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    })

    const serialized = memberships.map((m) => ({
      ...m,
      feePercentage: Number(m.feePercentage),
      feeAmount: Number(m.feeAmount),
      totalExpectedPayout: Number(m.totalExpectedPayout),
      netPayoutAmount: Number(m.netPayoutAmount),
      currentBalance: Number(m.currentBalance),
      totalContributed: Number(m.totalContributed),
      group: {
        ...m.group,
        contributionAmount: Number(m.group.contributionAmount),
      },
      transactions: m.transactions.map((tx) => ({
        ...tx,
        amount: Number(tx.amount),
      })),
    }))

    return { success: true, data: serialized }
  } catch (error) {
    return { success: false, data: [], error: error as Error }
  }
}

/**
 * Fetches a single eAjo group (authenticated view — for the join flow)
 */
export const getEAjoGroupForJoin = async (groupId: string) => {
  try {
    await requireAuthenticatedSession()

    const group = await prisma.eAjoGroup.findUnique({
      where: { id: groupId },
      include: {
        members: {
          select: { payoutPosition: true, status: true },
        },
      },
    })

    if (!group) {
      return { success: false, data: null, error: new Error('Group not found') }
    }

    return {
      success: true,
      data: {
        ...group,
        contributionAmount: Number(group.contributionAmount),
      },
    }
  } catch (error) {
    return { success: false, data: null, error: error as Error }
  }
}
