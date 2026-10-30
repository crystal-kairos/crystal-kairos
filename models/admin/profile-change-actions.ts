'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import {
  AdminPermission,
  ProfileChangeStatus,
  ProfileChangeType,
} from '@/generated/prisma/enums'
import { requireAnyPermission } from '@/lib/authz/guards'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import {
  recordAuditEvent,
  AuditAction,
  AuditOutcome,
} from '@/lib/services/audit.service'
import { nextOfKinSchema } from '@/schema/auth.schema'

export interface ProfileChangeFilter {
  status?: ProfileChangeStatus
  changeType?: ProfileChangeType
  page?: number
  limit?: number
}

/**
 * Retrieves profile change requests for administrator review queue (§PR P3-02B).
 * Restricted to staff with PROFILE_CHANGES_REVIEW or OWNER.
 */
export const getProfileChangeRequestsAction = async (
  filters: ProfileChangeFilter = {},
) => {
  try {
    await requireAnyPermission([AdminPermission.PROFILE_CHANGES_REVIEW])

    const page = Math.max(1, filters.page || 1)
    const limit = Math.max(1, Math.min(100, filters.limit || 20))
    const skip = (page - 1) * limit

    const where: any = {}
    if (filters.status) {
      where.status = filters.status
    }
    if (filters.changeType) {
      where.changeType = filters.changeType
    }

    const [total, requests, countsByStatus] = await Promise.all([
      prisma.profileChangeRequest.count({ where }),
      prisma.profileChangeRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { submittedAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
            },
          },
          reviewedBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      }),
      prisma.profileChangeRequest.groupBy({
        by: ['status'],
        _count: { id: true },
      }),
    ])

    const stats = {
      pending: countsByStatus.find((c) => c.status === ProfileChangeStatus.PENDING)?._count.id || 0,
      approved: countsByStatus.find((c) => c.status === ProfileChangeStatus.APPROVED)?._count.id || 0,
      rejected: countsByStatus.find((c) => c.status === ProfileChangeStatus.REJECTED)?._count.id || 0,
      cancelled: countsByStatus.find((c) => c.status === ProfileChangeStatus.CANCELLED)?._count.id || 0,
      total: countsByStatus.reduce((acc, curr) => acc + curr._count.id, 0),
    }

    return {
      success: true,
      data: {
        requests,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
        stats,
      },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'getProfileChangeRequestsAction',
      fallbackMessage: 'Failed to retrieve profile change requests.',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      correlationId: err.correlationId,
    }
  }
}

/**
 * Approves a pending profile change request in an atomic transaction (§PR P3-02B).
 * Enforces separation of duties (an admin cannot approve their own request)
 * and maintains the invariant "exactly one primary account when at least one account exists".
 */
export const approveProfileChangeRequestAction = async (requestId: string) => {
  try {
    const actor = await requireAnyPermission([
      AdminPermission.PROFILE_CHANGES_REVIEW,
    ])

    const request = await prisma.profileChangeRequest.findUnique({
      where: { id: requestId },
      include: { user: true },
    })

    if (!request) {
      return { success: false, error: 'Profile change request not found.' }
    }

    if (request.status !== ProfileChangeStatus.PENDING) {
      return {
        success: false,
        error: `Request has already been ${request.status.toLowerCase()}. Only PENDING requests can be approved.`,
      }
    }

    // Separation of duties rule: administrator cannot review their own request
    if (actor.id === request.userId) {
      return {
        success: false,
        error: 'Separation of duties violation: You cannot approve your own profile change request.',
      }
    }

    await prisma.$transaction(async (tx) => {
      if (request.changeType === ProfileChangeType.PRIMARY_BANK) {
        const proposed = request.proposedValue as any
        const targetAccountId = proposed?.targetBankAccountId

        if (!targetAccountId) {
          throw new Error('Target bank account ID is missing from proposed change data.')
        }

        const targetAccount = await tx.bankAccount.findFirst({
          where: { id: targetAccountId, userId: request.userId },
        })

        if (!targetAccount) {
          throw new Error('The nominated bank account no longer exists or does not belong to the member.')
        }

        // Maintain invariant: Exactly one primary bank account
        await tx.bankAccount.updateMany({
          where: { userId: request.userId },
          data: { isPrimary: false },
        })

        await tx.bankAccount.update({
          where: { id: targetAccountId },
          data: { isPrimary: true },
        })
      } else if (request.changeType === ProfileChangeType.NEXT_OF_KIN) {
        const proposed = request.proposedValue as any
        const parsed = nextOfKinSchema.parse(proposed)

        await tx.nextOfKin.upsert({
          where: { userId: request.userId },
          update: {
            name: parsed.name,
            phoneNumber: parsed.phoneNumber,
            relationship: parsed.relationship,
            occupation: parsed.occupation,
            address: parsed.address,
            bankName: parsed.bankName,
            accountNumber: parsed.accountNumber,
            accountName: parsed.accountName,
          },
          create: {
            userId: request.userId,
            name: parsed.name,
            phoneNumber: parsed.phoneNumber,
            relationship: parsed.relationship,
            occupation: parsed.occupation,
            address: parsed.address,
            bankName: parsed.bankName,
            accountNumber: parsed.accountNumber,
            accountName: parsed.accountName,
          },
        })
      } else if (request.changeType === ProfileChangeType.BANK_DETAILS) {
        const proposed = request.proposedValue as any
        if (proposed?.bankAccountId) {
          await tx.bankAccount.update({
            where: { id: proposed.bankAccountId, userId: request.userId },
            data: {
              bankName: proposed.bankName,
              bankCode: proposed.bankCode,
              accountNumber: proposed.accountNumber,
              accountName: proposed.accountName,
            },
          })
        }
      }

      // Mark request as APPROVED
      await tx.profileChangeRequest.update({
        where: { id: requestId },
        data: {
          status: ProfileChangeStatus.APPROVED,
          reviewedAt: new Date(),
          reviewedById: actor.id,
        },
      })
    })

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.MEMBER_PROFILE_UPDATED,
      affectedUserId: request.userId,
      entityType: 'ProfileChangeRequest',
      entityId: requestId,
      metadata: {
        changeType: request.changeType,
        outcome: 'APPROVED',
        memberEmail: request.user.email,
      },
    })

    try {
      revalidatePath('/admin/profile-changes')
      revalidatePath(`/admin/members/${request.userId}`)
      revalidatePath(`/dashboard/${request.userId}/banks`)
      revalidatePath(`/dashboard/${request.userId}/profile`)
    } catch {}

    return { success: true }
  } catch (error: any) {
    const err = toActionErrorResult(error, {
      actionName: 'approveProfileChangeRequestAction',
      fallbackMessage: 'Failed to approve profile change request.',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      correlationId: err.correlationId,
    }
  }
}

/**
 * Rejects a pending profile change request (§PR P3-02B).
 * Active member records remain unchanged. Rejection reason is mandatory.
 */
export const rejectProfileChangeRequestAction = async (
  requestId: string,
  reason: string,
) => {
  try {
    const actor = await requireAnyPermission([
      AdminPermission.PROFILE_CHANGES_REVIEW,
    ])

    const trimmedReason = reason?.trim()
    if (!trimmedReason || trimmedReason.length < 3) {
      return { success: false, error: 'A clear rejection reason (at least 3 characters) is required.' }
    }

    const request = await prisma.profileChangeRequest.findUnique({
      where: { id: requestId },
      include: { user: true },
    })

    if (!request) {
      return { success: false, error: 'Profile change request not found.' }
    }

    if (request.status !== ProfileChangeStatus.PENDING) {
      return {
        success: false,
        error: `Request has already been ${request.status.toLowerCase()}. Only PENDING requests can be rejected.`,
      }
    }

    // Separation of duties rule: administrator cannot review their own request
    if (actor.id === request.userId) {
      return {
        success: false,
        error: 'Separation of duties violation: You cannot reject your own profile change request.',
      }
    }

    await prisma.profileChangeRequest.update({
      where: { id: requestId },
      data: {
        status: ProfileChangeStatus.REJECTED,
        reviewedAt: new Date(),
        reviewedById: actor.id,
        rejectionReason: trimmedReason,
      },
    })

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.MEMBER_PROFILE_UPDATED,
      affectedUserId: request.userId,
      entityType: 'ProfileChangeRequest',
      entityId: requestId,
      metadata: {
        changeType: request.changeType,
        outcome: 'REJECTED',
        rejectionReason: trimmedReason,
        memberEmail: request.user.email,
      },
    })

    try {
      revalidatePath('/admin/profile-changes')
      revalidatePath(`/admin/members/${request.userId}`)
      revalidatePath(`/dashboard/${request.userId}/banks`)
      revalidatePath(`/dashboard/${request.userId}/profile`)
    } catch {}

    return { success: true }
  } catch (error: any) {
    const err = toActionErrorResult(error, {
      actionName: 'rejectProfileChangeRequestAction',
      fallbackMessage: 'Failed to reject profile change request.',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      correlationId: err.correlationId,
    }
  }
}
