'use server'

import { z } from 'zod'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { nextOfKinSchema } from '@/schema/auth.schema'
import { revalidatePath } from 'next/cache'
import {
  AdminPermission,
  ProfileChangeStatus,
  ProfileChangeType,
  Relationship,
  UserDeactivationReason,
  UserRole,
} from '@/generated/prisma/enums'
import {
  assertTargetUserIsMember,
  requireAnyPermission,
  requireAuthenticatedSession,
  requireMemberOrStaffWithPermission,
  requireOwner,
} from '@/lib/authz/guards'
import { AppError } from '@/lib/errors/app-error'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { assertMockSessionAllowed } from '@/lib/authz/mock-session-guard'
import {
  recordAuditEvent,
  AuditAction,
  AuditOutcome,
} from '@/lib/services/audit.service'
import { lockMembers } from '@/lib/db/concurrency'
import { bankProvider } from '@/lib/banking/paystack.provider'
import { checkNameSimilarity, NameMatchResult } from '@/lib/banking/provider'
import { maskAccountNumber } from '@/lib/domain/profile-change'

assertMockSessionAllowed()

interface NextOfKinInput {
  name: string
  phoneNumber: string
  relationship: Relationship
  occupation: string
  address: string
  bankName: string
  accountNumber: string
  accountName: string
}

/** Staff permissions that may manage a member's bank / next-of-kin records directly. */
const PROFILE_STAFF_PERMISSIONS = [
  AdminPermission.PROFILE_CHANGES_REVIEW,
  AdminPermission.MEMBERS_APPROVE,
] as const

function actionFailure(
  error: unknown,
  actionName: string,
  fallbackMessage: string,
  context?: Record<string, unknown>,
) {
  return toActionErrorResult(error, { actionName, fallbackMessage, context })
}

function revalidateMemberBankPaths(userId: string) {
  try {
    revalidatePath(`/dashboard/${userId}/banks`)
    revalidatePath(`/dashboard/${userId}/profile`)
    revalidatePath(`/admin/members/${userId}`)
  } catch {
    // revalidatePath is unavailable outside a Next.js request (e.g. in tests)
  }
}

export const getSessionHelper = async () => {
  assertMockSessionAllowed()

  try {
    return await auth()
  } catch (e) {
    if (process.env.NODE_ENV === 'test' && process.env.MOCK_SESSION_USER) {
      return JSON.parse(process.env.MOCK_SESSION_USER)
    }
    throw e
  }
}

/**
 * Directly sets a member's next of kin. Staff only (PR P3-02B): members must use
 * `requestNextOfKinChangeAction`, which goes through admin review.
 */
export const updateNextOfKinAction = async (
  userId: string,
  data: NextOfKinInput,
) => {
  try {
    const actor = await requireMemberOrStaffWithPermission(userId, PROFILE_STAFF_PERMISSIONS)
    await assertTargetUserIsMember(userId)

    if (actor.role === UserRole.USER) {
      throw new AppError(
        'FORBIDDEN',
        'Direct updates are not permitted. Please submit a Next of Kin change request for administrator approval.',
      )
    }

    const parsedData = nextOfKinSchema.parse(data)
    const nokData = {
      name: parsedData.name,
      phoneNumber: parsedData.phoneNumber,
      relationship: parsedData.relationship,
      occupation: parsedData.occupation,
      address: parsedData.address,
      bankName: parsedData.bankName,
      accountNumber: parsedData.accountNumber,
      accountName: parsedData.accountName,
    }

    const result = await prisma.$transaction(async (tx) => {
      await lockMembers(tx, [userId])

      const saved = await tx.nextOfKin.upsert({
        where: { userId },
        update: nokData,
        create: { userId, ...nokData },
      })

      await recordAuditEvent(
        {
          actorId: actor.id,
          actorRole: actor.role,
          affectedUserId: userId,
          action: AuditAction.MEMBER_NEXT_OF_KIN_SET,
          entityType: 'NextOfKin',
          entityId: saved.id,
          metadata: { source: 'STAFF_DIRECT_UPDATE' },
        },
        tx,
      )

      return saved
    })

    revalidateMemberBankPaths(userId)
    return { success: true, data: result }
  } catch (error) {
    const err = actionFailure(error, 'updateNextOfKinAction', 'Failed to update next of kin', {
      userId,
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

interface BankAccountInput {
  bankCode?: string
  bankName: string
  accountNumber: string
  /** Ignored: the account name is always resolved on the server. Kept for form compatibility. */
  accountName?: string
  isOverride?: boolean
  overrideReason?: string
}

const addBankAccountInputSchema = z.object({
  bankCode: z.string().trim().min(1, 'Bank selection is required'),
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'Account number must be 10 digits'),
  isOverride: z.boolean().optional(),
  overrideReason: z.string().trim().max(500).optional(),
})

/**
 * Adds a bank account for a member (P3-02 / P3-02B).
 *
 * - The account name is resolved on the server; the browser-supplied name is never stored.
 * - A member whose resolved name does not match their registered name is asked to contact an
 *   administrator; staff may add such an account and the mismatch is recorded in the audit log.
 * - The account becomes primary only when the member has no primary account yet.
 * - A-22: an account already registered by another active member needs an OWNER override with a reason.
 */
export const addBankAccountAction = async (
  userId: string,
  data: BankAccountInput,
) => {
  try {
    const actor = await requireMemberOrStaffWithPermission(userId, PROFILE_STAFF_PERMISSIONS)
    const member = await assertTargetUserIsMember(userId)
    const input = addBankAccountInputSchema.parse({
      bankCode: data.bankCode ?? '',
      accountNumber: data.accountNumber,
      isOverride: data.isOverride,
      overrideReason: data.overrideReason,
    })

    // Rule A-22: one active member per bank account, unless the OWNER overrides with a reason.
    const existingActiveAccount = await prisma.bankAccount.findFirst({
      where: {
        bankCode: input.bankCode,
        accountNumber: input.accountNumber,
        userId: { not: userId },
        user: { isActive: true },
      },
      select: { id: true },
    })

    let overrideReason: string | null = null
    if (existingActiveAccount) {
      if (!input.isOverride || actor.role !== UserRole.OWNER) {
        throw new AppError(
          'CONFLICT',
          'This bank account is already registered by another member. Please contact an administrator.',
        )
      }
      if (!input.overrideReason) {
        throw new AppError(
          'BAD_REQUEST',
          'An override reason is required to register a shared bank account.',
        )
      }
      overrideReason = input.overrideReason
    }

    // Resolve on the server (P3-02): bank must be a known bank code.
    const banks = await bankProvider.listBanks()
    const bank = banks.find((b) => b.code === input.bankCode)
    if (!bank) {
      throw new AppError('BAD_REQUEST', 'Please select a valid bank.')
    }
    const resolved = await bankProvider.resolveAccount(input.bankCode, input.accountNumber)
    const nameMatch = checkNameSimilarity(member.name, resolved.accountName)

    if (!nameMatch.isMatch && actor.role === UserRole.USER) {
      throw new AppError(
        'NAME_MISMATCH',
        `The account name returned by the bank (${resolved.accountName}) does not match your registered name. Please contact an administrator to add this account.`,
      )
    }

    const result = await prisma.$transaction(async (tx) => {
      await lockMembers(tx, [userId])

      const ownDuplicate = await tx.bankAccount.findFirst({
        where: { userId, bankCode: input.bankCode, accountNumber: input.accountNumber },
        select: { id: true },
      })
      if (ownDuplicate) {
        throw new AppError('CONFLICT', 'This bank account is already registered on this profile.')
      }

      // Only the first primary is automatic; afterwards a switch needs approval (P3-02B).
      const primaryCount = await tx.bankAccount.count({ where: { userId, isPrimary: true } })
      const isPrimary = primaryCount === 0

      const created = await tx.bankAccount.create({
        data: {
          userId,
          bankCode: input.bankCode,
          bankName: bank.name,
          accountNumber: resolved.accountNumber,
          accountName: resolved.accountName,
          isPrimary,
          isVerified: true,
          verifiedAt: new Date(),
        },
      })

      await recordAuditEvent(
        {
          actorId: actor.id,
          actorRole: actor.role,
          affectedUserId: userId,
          action: AuditAction.MEMBER_BANK_ACCOUNT_ADDED,
          entityType: 'BankAccount',
          entityId: created.id,
          metadata: {
            isPrimary,
            nameMatch: nameMatch.isMatch,
            similarityScore: nameMatch.similarityScore,
            ...(overrideReason ? { duplicateOverride: true, overrideReason } : {}),
          },
        },
        tx,
      )

      return created
    })

    revalidateMemberBankPaths(userId)
    return { success: true, data: result, nameMatch }
  } catch (error) {
    const err = actionFailure(error, 'addBankAccountAction', 'Failed to add bank account', {
      userId,
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
 * Sets the primary bank account directly.
 * - Members may only do this when they have no primary account yet; otherwise they must
 *   use `requestPrimaryBankAccountChangeAction` (admin approval, P3-02B).
 * - Staff with the profile permissions may switch it directly; the switch is audited.
 */
export const setPrimaryBankAccountAction = async (
  userId: string,
  bankAccountId: string,
) => {
  try {
    const actor = await requireMemberOrStaffWithPermission(userId, PROFILE_STAFF_PERMISSIONS)
    await assertTargetUserIsMember(userId)

    const result = await prisma.$transaction(async (tx) => {
      await lockMembers(tx, [userId])

      const target = await tx.bankAccount.findFirst({
        where: { id: bankAccountId, userId },
      })
      if (!target) {
        throw new AppError('NOT_FOUND', 'Bank account not found.')
      }
      if (!target.isVerified) {
        throw new AppError('BAD_REQUEST', 'Only a verified bank account can be the primary account.')
      }

      const currentPrimary = await tx.bankAccount.findFirst({
        where: { userId, isPrimary: true },
        select: { id: true },
      })
      if (actor.role === UserRole.USER && currentPrimary && currentPrimary.id !== target.id) {
        throw new AppError(
          'FORBIDDEN',
          'Direct primary bank updates are not permitted. Please submit a primary bank change request for administrator approval.',
        )
      }

      await tx.bankAccount.updateMany({
        where: { userId, isPrimary: true, id: { not: target.id } },
        data: { isPrimary: false },
      })
      const updated = await tx.bankAccount.update({
        where: { id: target.id },
        data: { isPrimary: true },
      })

      await recordAuditEvent(
        {
          actorId: actor.id,
          actorRole: actor.role,
          affectedUserId: userId,
          action: AuditAction.MEMBER_PRIMARY_BANK_SET,
          entityType: 'BankAccount',
          entityId: target.id,
          metadata: { previousPrimaryId: currentPrimary?.id ?? null },
        },
        tx,
      )

      return updated
    })

    revalidateMemberBankPaths(userId)
    return { success: true, data: result }
  } catch (error) {
    const err = actionFailure(error, 'setPrimaryBankAccountAction', 'Failed to set primary bank account', {
      userId,
      bankAccountId,
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
 * Removes a member bank account.
 * - A member can never remove their primary account (replacing it needs an approved
 *   primary switch or bank-details change, P3-02B). Staff may remove a primary account
 *   only when it is the member's only account.
 * - An account referenced by a pending change request, a payment, a disbursement or a
 *   wallet withdrawal cannot be removed (history must stay explainable).
 */
export const deleteBankAccountAction = async (
  userId: string,
  bankAccountId: string,
) => {
  try {
    const actor = await requireMemberOrStaffWithPermission(userId, PROFILE_STAFF_PERMISSIONS)
    await assertTargetUserIsMember(userId)

    const result = await prisma.$transaction(async (tx) => {
      await lockMembers(tx, [userId])

      const target = await tx.bankAccount.findFirst({
        where: { id: bankAccountId, userId },
        include: {
          _count: {
            select: { transactions: true, walletWithdrawals: true, disbursements: true },
          },
        },
      })
      if (!target) {
        throw new AppError('NOT_FOUND', 'Bank account not found')
      }

      if (target.isPrimary) {
        if (actor.role === UserRole.USER) {
          throw new AppError(
            'FORBIDDEN',
            'Cannot delete primary bank account. Add another account and request it as your primary account first.',
          )
        }
        const totalAccounts = await tx.bankAccount.count({ where: { userId } })
        if (totalAccounts > 1) {
          throw new AppError(
            'BAD_REQUEST',
            'Cannot delete primary bank account. Please set another account as primary first.',
          )
        }
      }

      const pendingRequests = await tx.profileChangeRequest.findMany({
        where: {
          userId,
          status: ProfileChangeStatus.PENDING,
          changeType: { in: [ProfileChangeType.PRIMARY_BANK, ProfileChangeType.BANK_DETAILS] },
        },
        select: { proposedValue: true },
      })
      const referencedByPending = pendingRequests.some((r) => {
        const v = (r.proposedValue ?? {}) as Record<string, unknown>
        return v.targetBankAccountId === target.id || v.bankAccountId === target.id
      })
      if (referencedByPending) {
        throw new AppError(
          'CONFLICT',
          'This account has a pending change request. Cancel the request or wait for it to be reviewed first.',
        )
      }

      const { transactions, walletWithdrawals, disbursements } = target._count
      if (transactions + walletWithdrawals + disbursements > 0) {
        throw new AppError(
          'CONFLICT',
          'This account is linked to past payments or payouts and cannot be removed.',
        )
      }

      const deleted = await tx.bankAccount.delete({ where: { id: target.id } })

      await recordAuditEvent(
        {
          actorId: actor.id,
          actorRole: actor.role,
          affectedUserId: userId,
          action: AuditAction.MEMBER_BANK_ACCOUNT_REMOVED,
          entityType: 'BankAccount',
          entityId: target.id,
          // Snapshot kept in the audit log so the removed account remains explainable.
          beforeState: {
            bankName: target.bankName,
            bankCode: target.bankCode,
            accountName: target.accountName,
            accountNumberMasked: maskAccountNumber(target.accountNumber),
            isPrimary: target.isPrimary,
          },
        },
        tx,
      )

      return deleted
    })

    revalidateMemberBankPaths(userId)
    return { success: true, data: result }
  } catch (error) {
    const err = actionFailure(error, 'deleteBankAccountAction', 'Failed to delete bank account', {
      userId,
      bankAccountId,
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

export const getBankListAction = async () => {
  try {
    await requireAuthenticatedSession()
    const banks = await bankProvider.listBanks()
    const sorted = [...banks].sort((a, b) => a.name.localeCompare(b.name))
    return { success: true, data: sorted }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'getBankListAction',
      fallbackMessage: 'Failed to retrieve bank list',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      correlationId: err.correlationId,
    }
  }
}

export const resolveAccountNameAction = async (
  bankCodeOrName: string,
  accountNumber: string,
  targetUserId?: string,
) => {
  try {
    const actor = await requireAuthenticatedSession()

    // Resolving for someone else (name-match against their profile) needs the same
    // authority as managing their bank accounts.
    if (targetUserId && targetUserId !== actor.id) {
      await requireMemberOrStaffWithPermission(targetUserId, PROFILE_STAFF_PERMISSIONS)
    }

    if (!bankCodeOrName || !bankCodeOrName.trim()) {
      return { success: false, error: 'Bank selection is required' }
    }

    const cleanAccount = accountNumber?.trim()
    if (!cleanAccount || cleanAccount.length !== 10) {
      return { success: false, error: 'Account number must be 10 digits' }
    }

    // Resolve bank code if bank name was passed
    const banks = await bankProvider.listBanks()
    let bankCode = bankCodeOrName.trim()
    let bankName = bankCodeOrName.trim()

    const matchedByCode = banks.find((b) => b.code === bankCode)
    if (matchedByCode) {
      bankName = matchedByCode.name
    } else {
      const matchedByName = banks.find(
        (b) => b.name.toLowerCase() === bankCodeOrName.trim().toLowerCase(),
      )
      if (matchedByName) {
        bankCode = matchedByName.code
        bankName = matchedByName.name
      }
    }

    const memberId = targetUserId || actor.id

    // Check duplicate active bank account across active members (Rule A-22)
    const existingActiveAccount = await prisma.bankAccount.findFirst({
      where: {
        bankCode: bankCode || undefined,
        accountNumber: cleanAccount,
        user: { isActive: true },
      },
      include: { user: true },
    })

    if (existingActiveAccount && existingActiveAccount.userId !== memberId) {
      return {
        success: false,
        error:
          'This bank account is already registered by another member. Please contact an administrator.',
      }
    }

    // Call bank provider to resolve account name
    const resolved = await bankProvider.resolveAccount(bankCode, cleanAccount)

    // Name similarity check
    let nameMatch: NameMatchResult = { isMatch: true, similarityScore: 1 }
    if (memberId) {
      const targetUser = await prisma.user.findUnique({
        where: { id: memberId },
        select: { name: true },
      })
      if (targetUser?.name) {
        nameMatch = checkNameSimilarity(targetUser.name, resolved.accountName)
      }
    }

    return {
      success: true,
      accountName: resolved.accountName,
      accountNumber: resolved.accountNumber,
      bankCode: resolved.bankCode,
      bankName,
      nameMatch,
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'resolveAccountNameAction',
      fallbackMessage: 'Failed to resolve account name',
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
 * Soft deactivates a user account, revoking active sessions and recording reasons (§4.6, P2-01).
 * Preserves all financial and audit records intact.
 */
export const deactivateUserAction = async (data: {
  userId: string
  reason: UserDeactivationReason
  notes?: string
}) => {
  try {
    const actor = await requireAnyPermission([
      AdminPermission.MEMBERS_APPROVE,
      AdminPermission.STAFF_MANAGE,
    ])

    const targetUser = await prisma.user.findUnique({
      where: { id: data.userId },
      select: { id: true, role: true, isActive: true },
    })

    if (!targetUser) {
      return { success: false, error: 'User not found.' }
    }

    if (!targetUser.isActive) {
      return { success: false, error: 'User is already deactivated.' }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: data.userId },
        data: {
          isActive: false,
          deactivatedAt: new Date(),
          deactivatedById: actor.id,
          deactivationReason: data.reason,
          sessionVersion: { increment: 1 },
        },
      })

      // Revoke any active sessions immediately
      await tx.userSession.updateMany({
        where: { userId: data.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      })

      await recordAuditEvent(
        {
          actorId: actor.id,
          actorRole: actor.role,
          affectedUserId: data.userId,
          action: AuditAction.MEMBER_DEACTIVATED,
          entityType: 'User',
          entityId: data.userId,
          outcome: AuditOutcome.SUCCESS,
          metadata: {
            reason: data.reason,
            notes: data.notes,
          },
        },
        tx,
      )

      return user
    })

    try {
      revalidatePath(`/admin/members/${data.userId}`)
      revalidatePath('/admin/members')
    } catch {}

    return { success: true, data: updated }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'deactivateUserAction',
      fallbackMessage: 'Failed to deactivate user.',
      context: { userId: data.userId },
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
 * Reactivates a previously soft-deactivated user account (§4.6, P2-01).
 */
export const reactivateUserAction = async (data: { userId: string }) => {
  try {
    await requireAnyPermission([
      AdminPermission.MEMBERS_APPROVE,
      AdminPermission.STAFF_MANAGE,
    ])

    const targetUser = await prisma.user.findUnique({
      where: { id: data.userId },
      select: { id: true, isActive: true },
    })

    if (!targetUser) {
      return { success: false, error: 'User not found.' }
    }

    if (targetUser.isActive) {
      return { success: false, error: 'User is already active.' }
    }

    const updated = await prisma.user.update({
      where: { id: data.userId },
      data: {
        isActive: true,
        deactivatedAt: null,
        deactivatedById: null,
        deactivationReason: null,
        sessionVersion: { increment: 1 },
      },
    })

    await recordAuditEvent({
      actorId: data.userId,
      affectedUserId: data.userId,
      action: AuditAction.MEMBER_REACTIVATED,
      entityType: 'User',
      entityId: data.userId,
      outcome: AuditOutcome.SUCCESS,
      metadata: {
        userId: data.userId,
      },
    }).catch(() => {})

    try {
      revalidatePath(`/admin/members/${data.userId}`)
      revalidatePath('/admin/members')
    } catch {}

    return { success: true, data: updated }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'reactivateUserAction',
      fallbackMessage: 'Failed to reactivate user.',
      context: { userId: data.userId },
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
 * Fetches all society receiving accounts for admin configuration.
 */
export const getSocietyBankAccountsAction = async () => {
  try {
    await requireAnyPermission([AdminPermission.SOCIETY_SETTINGS_MANAGE])

    const accounts = await prisma.societyBankAccount.findMany({
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    })

    return { success: true, data: accounts }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'getSocietyBankAccountsAction',
      fallbackMessage: 'Failed to fetch society bank accounts.',
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
 * Fetches the active society receiving bank account for members and staff.
 */
export const getActiveSocietyBankAccountAction = async () => {
  try {
    await requireAuthenticatedSession()

    const activeAccount = await prisma.societyBankAccount.findFirst({
      where: { isActive: true },
    })

    return { success: true, data: activeAccount }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'getActiveSocietyBankAccountAction',
      fallbackMessage: 'Failed to fetch active society bank account.',
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
 * Activates a specific society receiving bank account, deactivating all others in a transaction.
 */
export const setActiveSocietyBankAccountAction = async (id: string) => {
  try {
    const actor = await requireAnyPermission([
      AdminPermission.SOCIETY_SETTINGS_MANAGE,
    ])

    const target = await prisma.societyBankAccount.findUnique({
      where: { id },
    })

    if (!target) {
      return { success: false, error: 'Society bank account not found.' }
    }

    await prisma.$transaction(async (tx) => {
      await tx.societyBankAccount.updateMany({
        data: { isActive: false },
      })
      await tx.societyBankAccount.update({
        where: { id },
        data: { isActive: true },
      })
    })

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.SETTING_CHANGED,
      entityType: 'SocietyBankAccount',
      entityId: id,
      metadata: {
        accountNumber: target.accountNumber,
        bankName: target.bankName,
        status: 'ACTIVATED',
      },
    })

    try {
      revalidatePath('/admin/settings')
      revalidatePath('/dashboard')
    } catch {}

    return { success: true }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'setActiveSocietyBankAccountAction',
      fallbackMessage: 'Failed to set active society bank account.',
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
 * Deletes an inactive society bank account.
 */
export const deleteSocietyBankAccountAction = async (id: string) => {
  try {
    const actor = await requireAnyPermission([
      AdminPermission.SOCIETY_SETTINGS_MANAGE,
    ])

    const target = await prisma.societyBankAccount.findUnique({
      where: { id },
    })

    if (!target) {
      return { success: false, error: 'Society bank account not found.' }
    }

    if (target.isActive) {
      return {
        success: false,
        error:
          'Cannot delete the active receiving account. Please activate another account first.',
      }
    }

    await prisma.societyBankAccount.delete({
      where: { id },
    })

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.SETTING_CHANGED,
      entityType: 'SocietyBankAccount',
      entityId: id,
      metadata: {
        accountNumber: target.accountNumber,
        bankName: target.bankName,
        status: 'DELETED',
      },
    })

    try {
      revalidatePath('/admin/settings')
    } catch {}

    return { success: true }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'deleteSocietyBankAccountAction',
      fallbackMessage: 'Failed to delete society bank account.',
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
 * Creates a cooperative receiving bank account shown to members for offline payments (P2-01).
 * Never confused with member payout accounts.
 */
export const createSocietyBankAccountAction = async (data: {
  bankCode?: string
  bankName: string
  accountNumber: string
  accountName: string
  isActive?: boolean
}) => {
  try {
    const actor = await requireAnyPermission([
      AdminPermission.SOCIETY_SETTINGS_MANAGE,
    ])

    const isFirstAccount = (await prisma.societyBankAccount.count()) === 0
    const shouldBeActive = data.isActive ?? isFirstAccount

    const created = await prisma.$transaction(async (tx) => {
      if (shouldBeActive) {
        await tx.societyBankAccount.updateMany({
          data: { isActive: false },
        })
      }

      return tx.societyBankAccount.create({
        data: {
          bankCode: data.bankCode || null,
          bankName: data.bankName,
          accountNumber: data.accountNumber,
          accountName: data.accountName,
          isActive: shouldBeActive,
          createdById: actor.id,
        },
      })
    })

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.SETTING_CHANGED,
      entityType: 'SocietyBankAccount',
      entityId: created.id,
      metadata: {
        accountNumber: created.accountNumber,
        bankName: created.bankName,
        isActive: created.isActive,
      },
    })

    try {
      revalidatePath('/admin/settings')
      revalidatePath('/dashboard')
    } catch {}

    return { success: true, data: created }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'createSocietyBankAccountAction',
      fallbackMessage: 'Failed to create society bank account.',
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
 * Records privacy consent version and timestamp (D-21, §1.10).
 */
export const recordPrivacyConsentAction = async (data: {
  userId: string
  noticeVersion: string
  ipHash?: string
  userAgent?: string
}) => {
  try {
    await requireMemberOrStaffWithPermission(data.userId, [
      AdminPermission.MEMBERS_APPROVE,
    ])

    const consent = await prisma.privacyConsent.upsert({
      where: {
        userId_noticeVersion: {
          userId: data.userId,
          noticeVersion: data.noticeVersion,
        },
      },
      update: {
        acceptedAt: new Date(),
        ipHash: data.ipHash,
        userAgent: data.userAgent,
      },
      create: {
        userId: data.userId,
        noticeVersion: data.noticeVersion,
        acceptedAt: new Date(),
        ipHash: data.ipHash,
        userAgent: data.userAgent,
      },
    })

    return { success: true, data: consent }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'recordPrivacyConsentAction',
      fallbackMessage: 'Failed to record privacy consent.',
      context: { userId: data.userId },
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      correlationId: err.correlationId,
    }
  }
}
