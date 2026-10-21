'use server'

import { revalidatePath } from 'next/cache'
import { Prisma } from '@/generated/prisma/client'
import { MembershipStatus, UserRole } from '@/generated/prisma/enums'
import { prisma } from '@/lib/prisma'
import { AllMembersQueryParams } from '@/types/members.interface'
import { generateMembershipNumber } from '@/lib/membership-number'
import {
  onMembershipApproved,
  onMembershipRejected,
} from '@/features/notification/triggers/member.triggers'
import { issuePasswordSetupToken } from '@/lib/authz/tokens'
import { AdminPermission, PasswordSetupTokenPurpose } from '@/generated/prisma/enums'
import { requirePermission } from '@/lib/authz/guards'
import { MembersLoansQueryParams } from '@/types/loans.interface'

export const getAllMembers = async (filters: AllMembersQueryParams) => {
  try {
    const {
      page = 1,
      pageSize = 5,
      sortField = 'createdAt',
      sortDirection = 'asc',
      status,
      search,
      createdFrom,
      createdTo,
      gender,
    } = filters

    const startOfCreatedFrom = createdFrom
      ? new Date(new Date(createdFrom).setHours(0, 0, 0, 0))
      : undefined
    const endOfCreatedTo = createdTo
      ? new Date(new Date(createdTo).setHours(23, 59, 59, 999))
      : undefined

    const where: Prisma.UserWhereInput = {
      role: UserRole.USER,
      ...(status ? { membership: { status } } : {}),
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      }),
      // Date range filter
      ...((startOfCreatedFrom || endOfCreatedTo) && {
        createdAt: {
          ...(startOfCreatedFrom && { gte: startOfCreatedFrom }),
          ...(endOfCreatedTo && { lte: endOfCreatedTo }),
        },
      }),
      // Gender filter (lives in UserInfo)
      ...(gender && {
        userInfo: { gender },
      }),
    }

    const [members, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          createdAt: true,
          userInfo: {
            select: {
              phoneNumber: true,
              gender: true,
            },
          },
          membership: {
            select: {
              status: true,
              interests: true,
            },
          },
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: {
          [sortField]: sortDirection,
        },
      }),
      prisma.user.count({
        where,
      }),
    ])

    return {
      success: true,
      data: members,
      meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    }
  } catch (error) {
    return {
      success: false,
      data: [],
      error: error as Error,
      meta: { total: 0, page: 1, pageSize: 5, totalPages: 1 },
    }
  }
}

export const getMembersCount = async () => {
  try {
    const membersCount = await prisma.user.count({
      where: {
        role: UserRole.USER,
      },
    })
    return { success: true, data: membersCount }
  } catch (error) {
    return { success: false, data: 0, error: error as Error }
  }
}

export const getMembersLastMonth = async () => {
  try {
    const members = await prisma.user.findMany({
      where: {
        role: UserRole.USER,
        createdAt: {
          lte: new Date(new Date().setMonth(new Date().getMonth() - 1)),
        },
      },
    })
    return { success: true, data: members }
  } catch (error) {
    return { success: false, data: [], error: error as Error }
  }
}

export const getLastMonthMembersCount = async () => {
  try {
    const membersCount = await prisma.user.count({
      where: {
        role: UserRole.USER,
        createdAt: {
          lte: new Date(new Date().setMonth(new Date().getMonth() - 1)),
        },
      },
    })
    return { success: true, data: membersCount }
  } catch (error) {
    return { success: false, data: 0, error: error as Error }
  }
}

export const getPendingApprovals = async () => {
  try {
    const pendingApprovals = await prisma.membership.findMany({
      where: {
        status: MembershipStatus.PENDING,
      },
    })
    return { success: true, data: pendingApprovals }
  } catch (error) {
    return { success: false, data: [], error: error as Error }
  }
}

export const getPendingApprovalsCount = async () => {
  try {
    const pendingApprovalsCount = await prisma.membership.count({
      where: {
        status: MembershipStatus.PENDING,
      },
    })
    return { success: true, data: pendingApprovalsCount }
  } catch (error) {
    return { success: false, data: 0, error: error as Error }
  }
}

export const getMemberById = async (memberId: string) => {
  try {
    const member = await prisma.user.findUnique({
      where: { id: memberId },
      include: {
        userInfo: true,
        membership: true,
        bankAccounts: true,
        nextOfKin: true,
      },
    })
    return { success: true, data: member }
  } catch (error) {
    return { success: false, data: null, error: error as Error }
  }
}

export const approveMember = async (
  userId: string,
  _adminId: string,
  userEmail?: string,
) => {
  try {
    void userEmail
    void _adminId
    const actor = await requirePermission(AdminPermission.MEMBERS_APPROVE)
    const actorId = actor.id
    const membershipNumber = generateMembershipNumber()
    const member = await prisma.membership.update({
      where: { userId },
      data: {
        status: MembershipStatus.APPROVED,
        approvedAt: new Date(),
        approvedBy: actorId,
        membershipNumber,
      },
    })
    try {
      revalidatePath('/admin/members')
      revalidatePath(`/admin/members/${userId}`)
    } catch (e) {
      console.warn('revalidatePath skipped:', e instanceof Error ? e.message : e)
    }

    try {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL
      if (!baseUrl) {
        return {
          success: false,
          data: null,
          error: new Error('API URL is not set'),
        }
      }
      const issued = await issuePasswordSetupToken({
        userId,
        purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
        createdById: actorId,
      })

      if (issued.rawToken) {
        await onMembershipApproved(
          userId,
          membershipNumber,
          member.tier,
          issued.rawToken,
        )
      }
    } catch (error) {
      console.error('Membership approved notification failed:', error)
    }

    return { success: true, data: member }
  } catch (error) {
    return { success: false, data: null, error: error as Error }
  }
}

export const rejectMember = async (
  userId: string,
  _adminId: string,
  reason: string,
) => {
  try {
    void _adminId
    await requirePermission(AdminPermission.MEMBERS_APPROVE)
    const member = await prisma.membership.update({
      where: { userId },
      data: {
        status: MembershipStatus.REJECTED,
        rejectionReason: reason,
      },
    })
    try {
      revalidatePath('/admin/members')
      revalidatePath(`/admin/members/${userId}`)
    } catch (e) {
      console.warn('revalidatePath skipped:', e instanceof Error ? e.message : e)
    }

    try {
      await onMembershipRejected(userId, reason)
    } catch (error) {
      console.error('Membership rejected notification failed:', error)
    }
    return { success: true, data: member }
  } catch (error) {
    return { success: false, data: null, error: error as Error }
  }
}

export const getLoanRecords = async (
  userId: string,
  filters: MembersLoansQueryParams,
) => {
  const {
    page = 1,
    pageSize = 5,
    sortField = 'createdAt',
    sortDirection = 'asc',
    search,
    createdFrom,
    createdTo,
    status,
  } = filters

  const allowedSortFields = ['createdAt', 'approvedAmount', 'status']
  const activeSortField = allowedSortFields.includes(sortField)
    ? sortField
    : 'createdAt'

  const startOfCreatedFrom = createdFrom
    ? new Date(new Date(createdFrom).setHours(0, 0, 0, 0))
    : undefined
  const endOfCreatedTo = createdTo
    ? new Date(new Date(createdTo).setHours(23, 59, 59, 999))
    : undefined

  try {
    const where: Prisma.LoanWhereInput = {
      ...(status && { status }),
      // Date range filter
      ...((startOfCreatedFrom || endOfCreatedTo) && {
        createdAt: {
          ...(startOfCreatedFrom && { gte: startOfCreatedFrom }),
          ...(endOfCreatedTo && { lte: endOfCreatedTo }),
        },
      }),
      userId,
    }

    const [loanRecords, total] = await prisma.$transaction([
      prisma.loan.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: {
          [activeSortField]: sortDirection,
        },
      }),
      prisma.loan.count({
        where,
      }),
    ])

    return {
      success: true,
      data: loanRecords,
      meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    }
  } catch (error) {
    return {
      success: false,
      data: [],
      error: error as Error,
      meta: { total: 0, page: 1, pageSize: 5, totalPages: 1 },
    }
  }
}

export const getSavingsRecords = async (userId: string) => {
  try {
    const savingsRecords = await prisma.savings.findMany({
      where: { userId },
    })
    return { success: true, data: savingsRecords }
  } catch (error) {
    return { success: false, data: [], error: error as Error }
  }
}

export const getEarningRecords = async (userId: string) => {
  try {
    const earningRecords = await prisma.eAjo.findMany({
      where: { userId },
    })
    return { success: true, data: earningRecords }
  } catch (error) {
    return { success: false, data: [], error: error as Error }
  }
}

export const getEAjoRecordsCount = async (userId: string) => {
  try {
    const eajoRecordsCount = await prisma.eAjo.count({
      where: { userId },
    })
    return { success: true, data: eajoRecordsCount }
  } catch (error) {
    return { success: false, data: 0, error: error as Error }
  }
}
