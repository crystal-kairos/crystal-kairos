'use server'

import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import { revalidatePath } from 'next/cache'
import {
  AdminPermission,
  ProfileChangeStatus,
  ProfileChangeType,
  Relationship,
} from '@/generated/prisma/enums'
import {
  assertTargetUserIsMember,
  requireMemberOrStaffWithPermission,
  requireMemberSession,
} from '@/lib/authz/guards'
import { AppError } from '@/lib/errors/app-error'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { lockMembers, transition } from '@/lib/db/concurrency'
import { recordAuditEvent, AuditAction } from '@/lib/services/audit.service'
import { bankProvider } from '@/lib/banking/paystack.provider'
import { checkNameSimilarity } from '@/lib/banking/provider'
import {
  maskAccountNumber,
  nextOfKinProposedSchema,
  toRedactedProfileChange,
} from '@/lib/domain/profile-change'

/**
 * Member-side actions for sensitive profile changes (PR P3-02B).
 *
 * Every write runs in one transaction that first takes the member's advisory lock
 * (`lockMembers`), so "one PENDING request per type" and the status transitions
 * cannot race. The audit event is written inside the same transaction.
 */

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

export interface BankDetailsChangeInput {
  bankCode: string
  accountNumber: string
}

const bankDetailsInputSchema = z.object({
  bankCode: z.string().trim().min(1, 'Bank selection is required'),
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'Account number must be exactly 10 digits'),
})

function failure(error: unknown, actionName: string, fallbackMessage: string) {
  return toActionErrorResult(error, { actionName, fallbackMessage })
}

function revalidateMemberProfilePaths(userId: string) {
  try {
    revalidatePath(`/dashboard/${userId}/banks`)
    revalidatePath(`/dashboard/${userId}/profile`)
    revalidatePath(`/admin/members/${userId}`)
    revalidatePath('/admin/profile-changes')
  } catch {
    // revalidatePath is unavailable outside a Next.js request (e.g. in tests)
  }
}

async function assertNoPendingRequest(
  tx: Prisma.TransactionClient,
  userId: string,
  changeType: ProfileChangeType,
  message: string,
) {
  const existing = await tx.profileChangeRequest.findFirst({
    where: { userId, changeType, status: ProfileChangeStatus.PENDING },
    select: { id: true },
  })
  if (existing) {
    throw new AppError('CONFLICT', message)
  }
}

/**
 * Requests that an existing, verified bank account becomes the member's primary
 * (default payout) account. The primary flag changes only on approval.
 */
export const requestPrimaryBankAccountChangeAction = async (
  targetBankAccountId: string,
) => {
  try {
    const actor = await requireMemberSession()
    await assertTargetUserIsMember(actor.id)

    const request = await prisma.$transaction(async (tx) => {
      await lockMembers(tx, [actor.id])

      const target = await tx.bankAccount.findFirst({
        where: { id: targetBankAccountId, userId: actor.id },
      })
      if (!target) {
        throw new AppError('NOT_FOUND', 'Bank account not found or does not belong to you.')
      }
      if (!target.isVerified) {
        throw new AppError('BAD_REQUEST', 'Only a verified bank account can become your primary account.')
      }
      if (target.isPrimary) {
        throw new AppError('BAD_REQUEST', 'This account is already your primary receiving account.')
      }

      await assertNoPendingRequest(
        tx,
        actor.id,
        ProfileChangeType.PRIMARY_BANK,
        'You already have a pending primary bank account change request under review.',
      )

      const currentPrimary = await tx.bankAccount.findFirst({
        where: { userId: actor.id, isPrimary: true },
      })

      const created = await tx.profileChangeRequest.create({
        data: {
          userId: actor.id,
          changeType: ProfileChangeType.PRIMARY_BANK,
          previousValue: currentPrimary
            ? {
                bankAccountId: currentPrimary.id,
                bankName: currentPrimary.bankName,
                bankCode: currentPrimary.bankCode,
                accountName: currentPrimary.accountName,
                accountNumberMasked: maskAccountNumber(currentPrimary.accountNumber),
              }
            : Prisma.JsonNull,
          proposedValue: {
            targetBankAccountId: target.id,
            bankName: target.bankName,
            bankCode: target.bankCode,
            accountName: target.accountName,
            accountNumberMasked: maskAccountNumber(target.accountNumber),
          },
        },
      })

      await recordAuditEvent(
        {
          actorId: actor.id,
          actorRole: actor.role,
          affectedUserId: actor.id,
          action: AuditAction.PROFILE_CHANGE_SUBMITTED,
          entityType: 'ProfileChangeRequest',
          entityId: created.id,
          metadata: {
            changeType: ProfileChangeType.PRIMARY_BANK,
            targetBankAccountId: target.id,
          },
        },
        tx,
      )

      return created
    })

    revalidateMemberProfilePaths(actor.id)
    return { success: true, data: toRedactedProfileChange(request) }
  } catch (error) {
    const err = failure(
      error,
      'requestPrimaryBankAccountChangeAction',
      'Failed to submit primary bank change request.',
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
 * Requests a change to the bank and/or account number of one of the member's existing
 * bank accounts. The new account is resolved on the server; a name mismatch does not
 * block submission but is recorded so the reviewer sees it (P3-02 additions).
 */
export const requestBankDetailsChangeAction = async (
  bankAccountId: string,
  input: BankDetailsChangeInput,
) => {
  try {
    const actor = await requireMemberSession()
    await assertTargetUserIsMember(actor.id)
    const parsed = bankDetailsInputSchema.parse(input)

    const existing = await prisma.bankAccount.findFirst({
      where: { id: bankAccountId, userId: actor.id },
    })
    if (!existing) {
      throw new AppError('NOT_FOUND', 'Bank account not found or does not belong to you.')
    }
    if (
      existing.bankCode === parsed.bankCode &&
      existing.accountNumber === parsed.accountNumber
    ) {
      throw new AppError('BAD_REQUEST', 'The new details are the same as the current details.')
    }

    // Rule A-22: an account may be registered by only one active member.
    const conflict = await prisma.bankAccount.findFirst({
      where: {
        bankCode: parsed.bankCode,
        accountNumber: parsed.accountNumber,
        userId: { not: actor.id },
        user: { isActive: true },
      },
      select: { id: true },
    })
    if (conflict) {
      throw new AppError(
        'CONFLICT',
        'This bank account is already registered by another member. Please contact an administrator.',
      )
    }

    // Resolve on the server; never trust a browser-supplied account name.
    const banks = await bankProvider.listBanks()
    const bank = banks.find((b) => b.code === parsed.bankCode)
    if (!bank) {
      throw new AppError('BAD_REQUEST', 'Please select a valid bank.')
    }
    const resolved = await bankProvider.resolveAccount(parsed.bankCode, parsed.accountNumber)
    const nameMatch = checkNameSimilarity(actor.name, resolved.accountName)

    const request = await prisma.$transaction(async (tx) => {
      await lockMembers(tx, [actor.id])

      const ownDuplicate = await tx.bankAccount.findFirst({
        where: {
          userId: actor.id,
          bankCode: parsed.bankCode,
          accountNumber: parsed.accountNumber,
          id: { not: bankAccountId },
        },
        select: { id: true },
      })
      if (ownDuplicate) {
        throw new AppError('CONFLICT', 'You have already registered this bank account.')
      }

      await assertNoPendingRequest(
        tx,
        actor.id,
        ProfileChangeType.BANK_DETAILS,
        'You already have a pending bank details change request under review.',
      )

      const created = await tx.profileChangeRequest.create({
        data: {
          userId: actor.id,
          changeType: ProfileChangeType.BANK_DETAILS,
          // The full previous number is kept so the change history can explain past payouts;
          // list views only ever receive the masked value (redactChangeValue).
          previousValue: {
            bankAccountId: existing.id,
            bankName: existing.bankName,
            bankCode: existing.bankCode,
            accountName: existing.accountName,
            accountNumber: existing.accountNumber,
            accountNumberMasked: maskAccountNumber(existing.accountNumber),
            isPrimary: existing.isPrimary,
          },
          proposedValue: {
            bankAccountId: existing.id,
            bankCode: parsed.bankCode,
            bankName: bank.name,
            accountNumber: resolved.accountNumber,
            accountName: resolved.accountName,
            accountNumberMasked: maskAccountNumber(resolved.accountNumber),
            nameMatch: {
              isMatch: nameMatch.isMatch,
              similarityScore: nameMatch.similarityScore,
            },
          },
        },
      })

      await recordAuditEvent(
        {
          actorId: actor.id,
          actorRole: actor.role,
          affectedUserId: actor.id,
          action: AuditAction.PROFILE_CHANGE_SUBMITTED,
          entityType: 'ProfileChangeRequest',
          entityId: created.id,
          metadata: {
            changeType: ProfileChangeType.BANK_DETAILS,
            bankAccountId: existing.id,
            nameMatch: nameMatch.isMatch,
          },
        },
        tx,
      )

      return created
    })

    revalidateMemberProfilePaths(actor.id)
    return {
      success: true,
      data: toRedactedProfileChange(request),
      nameMatch,
    }
  } catch (error) {
    const err = failure(
      error,
      'requestBankDetailsChangeAction',
      'Failed to submit bank details change request.',
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
 * Requests a change to the member's next-of-kin details. The active record changes
 * only on approval.
 */
export const requestNextOfKinChangeAction = async (
  userId: string,
  data: NextOfKinChangeInput,
) => {
  try {
    // A member may only submit for their own record; the session decides who that is.
    const actor = await requireMemberSession(userId)
    await assertTargetUserIsMember(actor.id)

    const parsed = nextOfKinProposedSchema.parse(data)

    const request = await prisma.$transaction(async (tx) => {
      await lockMembers(tx, [actor.id])

      await assertNoPendingRequest(
        tx,
        actor.id,
        ProfileChangeType.NEXT_OF_KIN,
        'You already have a pending Next of Kin update request awaiting administrator review.',
      )

      const existingNok = await tx.nextOfKin.findUnique({ where: { userId: actor.id } })

      const created = await tx.profileChangeRequest.create({
        data: {
          userId: actor.id,
          changeType: ProfileChangeType.NEXT_OF_KIN,
          previousValue: existingNok
            ? {
                name: existingNok.name,
                phoneNumber: existingNok.phoneNumber,
                relationship: existingNok.relationship,
                occupation: existingNok.occupation,
                address: existingNok.address,
                bankName: existingNok.bankName,
                accountNumber: existingNok.accountNumber,
                accountNumberMasked: maskAccountNumber(existingNok.accountNumber),
                accountName: existingNok.accountName,
              }
            : Prisma.JsonNull,
          proposedValue: {
            name: parsed.name,
            phoneNumber: parsed.phoneNumber,
            relationship: parsed.relationship,
            occupation: parsed.occupation,
            address: parsed.address,
            bankName: parsed.bankName,
            accountNumber: parsed.accountNumber,
            accountNumberMasked: maskAccountNumber(parsed.accountNumber),
            accountName: parsed.accountName,
          },
        },
      })

      await recordAuditEvent(
        {
          actorId: actor.id,
          actorRole: actor.role,
          affectedUserId: actor.id,
          action: AuditAction.PROFILE_CHANGE_SUBMITTED,
          entityType: 'ProfileChangeRequest',
          entityId: created.id,
          metadata: { changeType: ProfileChangeType.NEXT_OF_KIN },
        },
        tx,
      )

      return created
    })

    revalidateMemberProfilePaths(actor.id)
    return { success: true, data: toRedactedProfileChange(request) }
  } catch (error) {
    const err = failure(
      error,
      'requestNextOfKinChangeAction',
      'Failed to submit Next of Kin change request.',
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
 * Returns a member's PENDING profile change requests (account numbers redacted).
 * Members may read their own; staff need PROFILE_CHANGES_REVIEW or MEMBERS_READ.
 */
export const getMemberPendingProfileChangesAction = async (userId?: string) => {
  try {
    let targetUserId = userId
    if (!targetUserId) {
      const self = await requireMemberSession()
      targetUserId = self.id
    }
    await requireMemberOrStaffWithPermission(targetUserId, [
      AdminPermission.PROFILE_CHANGES_REVIEW,
      AdminPermission.MEMBERS_READ,
    ])

    const pendingRequests = await prisma.profileChangeRequest.findMany({
      where: { userId: targetUserId, status: ProfileChangeStatus.PENDING },
      orderBy: { submittedAt: 'desc' },
    })

    return {
      success: true,
      data: pendingRequests.map((r) => toRedactedProfileChange(r)),
    }
  } catch (error) {
    const err = failure(
      error,
      'getMemberPendingProfileChangesAction',
      'Failed to retrieve pending profile changes.',
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
 * Returns the signed-in member's recent profile change requests of every status,
 * including rejection reasons, so members can see what happened to each request.
 */
export const getMyProfileChangeHistoryAction = async (limit = 20) => {
  try {
    const actor = await requireMemberSession()
    const take = Math.max(1, Math.min(50, Math.floor(limit) || 20))

    const requests = await prisma.profileChangeRequest.findMany({
      where: { userId: actor.id },
      orderBy: { submittedAt: 'desc' },
      take,
      select: {
        id: true,
        changeType: true,
        status: true,
        previousValue: true,
        proposedValue: true,
        submittedAt: true,
        reviewedAt: true,
        rejectionReason: true,
      },
    })

    return {
      success: true,
      data: requests.map((r) => toRedactedProfileChange(r)),
    }
  } catch (error) {
    const err = failure(
      error,
      'getMyProfileChangeHistoryAction',
      'Failed to retrieve your profile change history.',
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
 * Lets a member cancel their own PENDING request before it is reviewed.
 */
export const cancelProfileChangeRequestAction = async (requestId: string) => {
  try {
    const actor = await requireMemberSession()

    await prisma.$transaction(async (tx) => {
      await lockMembers(tx, [actor.id])

      const request = await tx.profileChangeRequest.findFirst({
        where: { id: requestId, userId: actor.id },
        select: { id: true, changeType: true, status: true },
      })
      if (!request) {
        throw new AppError('NOT_FOUND', 'Profile change request not found.')
      }

      await transition(
        tx.profileChangeRequest,
        request.id,
        ProfileChangeStatus.PENDING,
        { status: ProfileChangeStatus.CANCELLED },
        'This request has already been reviewed or cancelled. Refresh and try again.',
      )

      await recordAuditEvent(
        {
          actorId: actor.id,
          actorRole: actor.role,
          affectedUserId: actor.id,
          action: AuditAction.PROFILE_CHANGE_CANCELLED,
          entityType: 'ProfileChangeRequest',
          entityId: request.id,
          metadata: { changeType: request.changeType },
        },
        tx,
      )
    })

    revalidateMemberProfilePaths(actor.id)
    return { success: true }
  } catch (error) {
    const err = failure(
      error,
      'cancelProfileChangeRequestAction',
      'Failed to cancel change request.',
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
