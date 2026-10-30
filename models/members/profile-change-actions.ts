'use server'

import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import { nextOfKinSchema } from '@/schema/auth.schema'
import { revalidatePath } from 'next/cache'
import {
  ProfileChangeStatus,
  ProfileChangeType,
  Relationship,
} from '@/generated/prisma/enums'
import {
  assertTargetUserIsMember,
  requireAuthenticatedSession,
} from '@/lib/authz/guards'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import {
  recordAuditEvent,
  AuditAction,
  AuditOutcome,
} from '@/lib/services/audit.service'

export interface NextOfKinChangeInput {
  name: string
  phoneNumber: string
  relationship: Relationship
  occupation: string
  address: string
  bankName: string
  accountNumber: string
  accountName: string
}

/**
 * Submits a request to change the member's default (primary) bank account (§PR P3-02B).
 * The primary flag remains unchanged until an administrator reviews and approves the request.
 */
export const requestPrimaryBankAccountChangeAction = async (
  targetBankAccountId: string,
) => {
  try {
    const actor = await requireAuthenticatedSession()
    await assertTargetUserIsMember(actor.id)

    // 1. Verify target bank account exists and belongs to the actor
    const targetAccount = await prisma.bankAccount.findFirst({
      where: { id: targetBankAccountId, userId: actor.id },
    })

    if (!targetAccount) {
      return { success: false, error: 'Target bank account not found or does not belong to you.' }
    }

    if (targetAccount.isPrimary) {
      return { success: false, error: 'This account is already your primary receiving account.' }
    }

    // 2. Check current primary account for previous value snapshot
    const currentPrimary = await prisma.bankAccount.findFirst({
      where: { userId: actor.id, isPrimary: true },
    })

    // 3. Prevent duplicate pending primary bank requests
    const existingPending = await prisma.profileChangeRequest.findFirst({
      where: {
        userId: actor.id,
        changeType: ProfileChangeType.PRIMARY_BANK,
        status: ProfileChangeStatus.PENDING,
      },
    })

    if (existingPending) {
      return {
        success: false,
        error: 'You already have a pending primary bank account change request under review.',
      }
    }

    const previousValue = currentPrimary
      ? {
          bankAccountId: currentPrimary.id,
          bankName: currentPrimary.bankName,
          accountNumberMasked: '******' + currentPrimary.accountNumber.slice(-4),
          accountName: currentPrimary.accountName,
          bankCode: currentPrimary.bankCode,
        }
      : null

    const proposedValue = {
      targetBankAccountId: targetAccount.id,
      bankName: targetAccount.bankName,
      accountNumberMasked: '******' + targetAccount.accountNumber.slice(-4),
      accountName: targetAccount.accountName,
      bankCode: targetAccount.bankCode,
    }

    const request = await prisma.profileChangeRequest.create({
      data: {
        userId: actor.id,
        changeType: ProfileChangeType.PRIMARY_BANK,
        previousValue: previousValue ?? Prisma.JsonNull,
        proposedValue,
        status: ProfileChangeStatus.PENDING,
      },
    })

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.MEMBER_PROFILE_UPDATED,
      entityType: 'ProfileChangeRequest',
      entityId: request.id,
      metadata: {
        changeType: ProfileChangeType.PRIMARY_BANK,
        targetBankAccountId: targetAccount.id,
        status: 'SUBMITTED',
      },
    })

    try {
      revalidatePath(`/dashboard/${actor.id}/banks`)
      revalidatePath(`/dashboard/${actor.id}/profile`)
      revalidatePath('/admin/profile-changes')
    } catch {}

    return { success: true, data: request }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'requestPrimaryBankAccountChangeAction',
      fallbackMessage: 'Failed to submit primary bank change request.',
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
 * Submits a request to update Next of Kin contact or payout details (§PR P3-02B).
 * Active Next of Kin details remain unchanged until reviewed and approved.
 */
export const requestNextOfKinChangeAction = async (
  userId: string,
  data: NextOfKinChangeInput,
) => {
  try {
    const actor = await requireAuthenticatedSession()

    // Separation of duties / self-service rule: member may only submit for their own records
    if (actor.id !== userId) {
      return { success: false, error: 'You may only submit profile change requests for your own account.' }
    }
    await assertTargetUserIsMember(actor.id)

    // Validate proposed schema
    const parsedData = nextOfKinSchema.parse(data)

    // Snapshot existing active next of kin if present
    const existingNok = await prisma.nextOfKin.findUnique({
      where: { userId: actor.id },
    })

    const previousValue = existingNok
      ? {
          name: existingNok.name,
          phoneNumber: existingNok.phoneNumber,
          relationship: existingNok.relationship,
          occupation: existingNok.occupation,
          address: existingNok.address,
          bankName: existingNok.bankName,
          accountNumberMasked: '******' + existingNok.accountNumber.slice(-4),
          accountName: existingNok.accountName,
        }
      : null

    const proposedValue = {
      name: parsedData.name,
      phoneNumber: parsedData.phoneNumber,
      relationship: parsedData.relationship,
      occupation: parsedData.occupation,
      address: parsedData.address,
      bankName: parsedData.bankName,
      accountNumber: parsedData.accountNumber,
      accountNumberMasked: '******' + parsedData.accountNumber.slice(-4),
      accountName: parsedData.accountName,
    }

    // Check if there is already an existing pending request
    const existingPending = await prisma.profileChangeRequest.findFirst({
      where: {
        userId: actor.id,
        changeType: ProfileChangeType.NEXT_OF_KIN,
        status: ProfileChangeStatus.PENDING,
      },
    })

    if (existingPending) {
      return {
        success: false,
        error: 'You already have a pending Next of Kin update request awaiting administrator review.',
      }
    }

    const request = await prisma.profileChangeRequest.create({
      data: {
        userId: actor.id,
        changeType: ProfileChangeType.NEXT_OF_KIN,
        previousValue: previousValue ?? Prisma.JsonNull,
        proposedValue,
        status: ProfileChangeStatus.PENDING,
      },
    })

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.MEMBER_PROFILE_UPDATED,
      entityType: 'ProfileChangeRequest',
      entityId: request.id,
      metadata: {
        changeType: ProfileChangeType.NEXT_OF_KIN,
        status: 'SUBMITTED',
      },
    })

    try {
      revalidatePath(`/dashboard/${actor.id}/profile`)
      revalidatePath('/admin/profile-changes')
    } catch {}

    return { success: true, data: request }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'requestNextOfKinChangeAction',
      fallbackMessage: 'Failed to submit Next of Kin change request.',
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
 * Returns any active pending profile change requests for a member.
 */
export const getMemberPendingProfileChangesAction = async (userId?: string) => {
  try {
    const actor = await requireAuthenticatedSession()
    const targetUserId = userId || actor.id

    // Member can view own, staff with permission can view member's
    if (actor.id !== targetUserId && actor.role === 'USER') {
      return { success: false, error: 'Unauthorized to view profile changes for another user.' }
    }

    const pendingRequests = await prisma.profileChangeRequest.findMany({
      where: {
        userId: targetUserId,
        status: ProfileChangeStatus.PENDING,
      },
      orderBy: { submittedAt: 'desc' },
    })

    return { success: true, data: pendingRequests }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'getMemberPendingProfileChangesAction',
      fallbackMessage: 'Failed to retrieve pending profile changes.',
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
 * Allows a member to cancel their own pending profile change request before admin review.
 */
export const cancelProfileChangeRequestAction = async (requestId: string) => {
  try {
    const actor = await requireAuthenticatedSession()

    const request = await prisma.profileChangeRequest.findUnique({
      where: { id: requestId },
    })

    if (!request) {
      return { success: false, error: 'Profile change request not found.' }
    }

    if (request.userId !== actor.id) {
      return { success: false, error: 'You can only cancel your own change requests.' }
    }

    if (request.status !== ProfileChangeStatus.PENDING) {
      return {
        success: false,
        error: `Cannot cancel request because it is already ${request.status.toLowerCase()}.`,
      }
    }

    const updated = await prisma.profileChangeRequest.update({
      where: { id: requestId },
      data: { status: ProfileChangeStatus.CANCELLED },
    })

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.MEMBER_PROFILE_UPDATED,
      entityType: 'ProfileChangeRequest',
      entityId: requestId,
      metadata: {
        status: 'CANCELLED',
      },
    })

    try {
      revalidatePath(`/dashboard/${actor.id}/banks`)
      revalidatePath(`/dashboard/${actor.id}/profile`)
      revalidatePath('/admin/profile-changes')
    } catch {}

    return { success: true, data: updated }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'cancelProfileChangeRequestAction',
      fallbackMessage: 'Failed to cancel change request.',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      correlationId: err.correlationId,
    }
  }
}
