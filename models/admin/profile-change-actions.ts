'use server'

import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import { revalidatePath } from 'next/cache'
import {
  AdminPermission,
  ProfileChangeStatus,
  ProfileChangeType,
  UserRole,
} from '@/generated/prisma/enums'
import { requireAnyPermission } from '@/lib/authz/guards'
import { AppError } from '@/lib/errors/app-error'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { lockMembers, transition } from '@/lib/db/concurrency'
import { recordAuditEvent, AuditAction } from '@/lib/services/audit.service'
import {
  parseProposedValue,
  toRedactedProfileChange,
} from '@/lib/domain/profile-change'

/**
 * Admin review actions for sensitive profile changes (PR P3-02B).
 *
 * Approval and rejection run in one transaction that takes the member's advisory lock,
 * moves the request out of PENDING with a conditional update (exactly one row, else
 * STALE_STATE), applies the change and writes the audit event. A concurrent second
 * decision therefore fails cleanly instead of overwriting the first.
 */

export interface ProfileChangeFilter {
  status?: ProfileChangeStatus
  changeType?: ProfileChangeType
  page?: number
  limit?: number
}

const rejectionReasonSchema = z
  .string()
  .trim()
  .min(3, 'A clear rejection reason (at least 3 characters) is required.')
  .max(500, 'Rejection reason must be 500 characters or fewer.')

function failure(error: unknown, actionName: string, fallbackMessage: string) {
  return toActionErrorResult(error, { actionName, fallbackMessage })
}

function revalidateReviewPaths(userId: string) {
  try {
    revalidatePath('/admin/profile-changes')
    revalidatePath(`/admin/members/${userId}`)
    revalidatePath(`/dashboard/${userId}/banks`)
    revalidatePath(`/dashboard/${userId}/profile`)
  } catch {
    // revalidatePath is unavailable outside a Next.js request (e.g. in tests)
  }
}

/** Loads the request and enforces the checks that do not need the member lock. */
async function loadReviewableRequest(requestId: string, reviewerId: string) {
  const request = await prisma.profileChangeRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      userId: true,
      changeType: true,
      status: true,
      proposedValue: true,
      user: { select: { role: true } },
    },
  })

  if (!request) {
    throw new AppError('NOT_FOUND', 'Profile change request not found.')
  }
  if (request.status !== ProfileChangeStatus.PENDING) {
    throw new AppError(
      'STALE_STATE',
      `Request has already been ${request.status.toLowerCase()}. Only PENDING requests can be reviewed.`,
    )
  }
  // Separation of duties: nobody reviews their own request.
  if (request.userId === reviewerId) {
    throw new AppError(
      'FORBIDDEN',
      'Separation of duties violation: You cannot review your own profile change request.',
    )
  }
  // D-15: staff accounts never hold member records, so a request for one is invalid.
  if (request.user.role !== UserRole.USER) {
    throw new AppError(
      'STAFF_CANNOT_BE_MEMBER',
      'Profile change requests can only be reviewed for member accounts.',
    )
  }

  return request
}

async function applyApprovedChange(
  tx: Prisma.TransactionClient,
  userId: string,
  changeType: ProfileChangeType,
  proposedValue: unknown,
): Promise<Record<string, unknown>> {
  const parsed = parseProposedValue(changeType, proposedValue)

  switch (parsed.changeType) {
    case ProfileChangeType.PRIMARY_BANK: {
      const target = await tx.bankAccount.findFirst({
        where: { id: parsed.value.targetBankAccountId, userId },
      })
      if (!target) {
        throw new AppError(
          'CONFLICT',
          'The nominated bank account no longer exists or does not belong to the member.',
        )
      }
      if (!target.isVerified) {
        throw new AppError('CONFLICT', 'The nominated bank account is not verified.')
      }

      // Invariant: exactly one primary account. Both writes run under the member lock.
      await tx.bankAccount.updateMany({
        where: { userId, isPrimary: true, id: { not: target.id } },
        data: { isPrimary: false },
      })
      await tx.bankAccount.update({
        where: { id: target.id },
        data: { isPrimary: true },
      })
      return { targetBankAccountId: target.id }
    }

    case ProfileChangeType.BANK_DETAILS: {
      const value = parsed.value
      const account = await tx.bankAccount.findFirst({
        where: { id: value.bankAccountId, userId },
      })
      if (!account) {
        throw new AppError(
          'CONFLICT',
          'The bank account to update no longer exists or does not belong to the member.',
        )
      }

      // Re-check A-22 at approval: another member may have registered the account since submission.
      const conflict = await tx.bankAccount.findFirst({
        where: {
          bankCode: value.bankCode,
          accountNumber: value.accountNumber,
          userId: { not: userId },
          user: { isActive: true },
        },
        select: { id: true },
      })
      if (conflict) {
        throw new AppError(
          'CONFLICT',
          'This bank account is now registered by another member. Reject this request or resolve the conflict first.',
        )
      }

      const ownDuplicate = await tx.bankAccount.findFirst({
        where: {
          userId,
          bankCode: value.bankCode,
          accountNumber: value.accountNumber,
          id: { not: account.id },
        },
        select: { id: true },
      })
      if (ownDuplicate) {
        throw new AppError('CONFLICT', 'The member has already registered this bank account.')
      }

      await tx.bankAccount.update({
        where: { id: account.id },
        data: {
          bankCode: value.bankCode,
          bankName: value.bankName,
          accountNumber: value.accountNumber,
          accountName: value.accountName,
          isVerified: true,
          verifiedAt: new Date(),
        },
      })
      return { bankAccountId: account.id }
    }

    case ProfileChangeType.NEXT_OF_KIN: {
      const value = parsed.value
      const data = {
        name: value.name,
        phoneNumber: value.phoneNumber,
        relationship: value.relationship,
        occupation: value.occupation,
        address: value.address,
        bankName: value.bankName,
        accountNumber: value.accountNumber,
        accountName: value.accountName,
      }
      await tx.nextOfKin.upsert({
        where: { userId },
        update: data,
        create: { userId, ...data },
      })
      return {}
    }
  }
}

/**
 * Review queue listing for staff with PROFILE_CHANGES_REVIEW (or OWNER).
 * Full account numbers are removed from the returned snapshots.
 */
export const getProfileChangeRequestsAction = async (
  filters: ProfileChangeFilter = {},
) => {
  try {
    await requireAnyPermission([AdminPermission.PROFILE_CHANGES_REVIEW])

    const page = Math.max(1, filters.page || 1)
    const limit = Math.max(1, Math.min(100, filters.limit || 20))
    const skip = (page - 1) * limit

    const where: Prisma.ProfileChangeRequestWhereInput = {}
    if (filters.status) where.status = filters.status
    if (filters.changeType) where.changeType = filters.changeType

    const [total, requests, countsByStatus] = await Promise.all([
      prisma.profileChangeRequest.count({ where }),
      prisma.profileChangeRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { submittedAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true } },
          reviewedBy: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.profileChangeRequest.groupBy({
        by: ['status'],
        _count: { id: true },
      }),
    ])

    const countFor = (status: ProfileChangeStatus) =>
      countsByStatus.find((c) => c.status === status)?._count.id || 0

    return {
      success: true,
      data: {
        requests: requests.map((r) => toRedactedProfileChange(r)),
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
        stats: {
          pending: countFor(ProfileChangeStatus.PENDING),
          approved: countFor(ProfileChangeStatus.APPROVED),
          rejected: countFor(ProfileChangeStatus.REJECTED),
          cancelled: countFor(ProfileChangeStatus.CANCELLED),
          total: countsByStatus.reduce((acc, curr) => acc + curr._count.id, 0),
        },
      },
    }
  } catch (error) {
    const err = failure(
      error,
      'getProfileChangeRequestsAction',
      'Failed to retrieve profile change requests.',
    )
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
 * Approves a PENDING request and applies the change atomically.
 */
export const approveProfileChangeRequestAction = async (requestId: string) => {
  try {
    const actor = await requireAnyPermission([AdminPermission.PROFILE_CHANGES_REVIEW])
    const request = await loadReviewableRequest(requestId, actor.id)

    await prisma.$transaction(async (tx) => {
      await lockMembers(tx, [request.userId])

      // Claim the request first; a concurrent approve/reject/cancel makes this fail.
      await transition(
        tx.profileChangeRequest,
        request.id,
        ProfileChangeStatus.PENDING,
        {
          status: ProfileChangeStatus.APPROVED,
          reviewedAt: new Date(),
          reviewedById: actor.id,
        },
        'This request was already reviewed or cancelled. Refresh and try again.',
      )

      const applied = await applyApprovedChange(
        tx,
        request.userId,
        request.changeType,
        request.proposedValue,
      )

      await recordAuditEvent(
        {
          actorId: actor.id,
          actorRole: actor.role,
          affectedUserId: request.userId,
          action: AuditAction.PROFILE_CHANGE_APPROVED,
          entityType: 'ProfileChangeRequest',
          entityId: request.id,
          metadata: { changeType: request.changeType, ...applied },
        },
        tx,
      )
    })

    revalidateReviewPaths(request.userId)
    return { success: true }
  } catch (error) {
    const err = failure(
      error,
      'approveProfileChangeRequestAction',
      'Failed to approve profile change request.',
    )
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
 * Rejects a PENDING request. Active member records stay unchanged; the reason is kept.
 */
export const rejectProfileChangeRequestAction = async (
  requestId: string,
  reason: string,
) => {
  try {
    const actor = await requireAnyPermission([AdminPermission.PROFILE_CHANGES_REVIEW])
    const trimmedReason = rejectionReasonSchema.parse(reason ?? '')
    const request = await loadReviewableRequest(requestId, actor.id)

    await prisma.$transaction(async (tx) => {
      await lockMembers(tx, [request.userId])

      await transition(
        tx.profileChangeRequest,
        request.id,
        ProfileChangeStatus.PENDING,
        {
          status: ProfileChangeStatus.REJECTED,
          reviewedAt: new Date(),
          reviewedById: actor.id,
          rejectionReason: trimmedReason,
        },
        'This request was already reviewed or cancelled. Refresh and try again.',
      )

      await recordAuditEvent(
        {
          actorId: actor.id,
          actorRole: actor.role,
          affectedUserId: request.userId,
          action: AuditAction.PROFILE_CHANGE_REJECTED,
          entityType: 'ProfileChangeRequest',
          entityId: request.id,
          metadata: { changeType: request.changeType, rejectionReason: trimmedReason },
        },
        tx,
      )
    })

    revalidateReviewPaths(request.userId)
    return { success: true }
  } catch (error) {
    const err = failure(
      error,
      'rejectProfileChangeRequestAction',
      'Failed to reject profile change request.',
    )
    return {
      success: false,
      error: err.error,
      code: err.code,
      fieldErrors: err.fieldErrors,
      correlationId: err.correlationId,
    }
  }
}
