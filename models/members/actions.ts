'use server'

import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { nextOfKinSchema } from '@/schema/auth.schema'
import { revalidatePath } from 'next/cache'
import {
  AdminPermission,
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
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { assertMockSessionAllowed } from '@/lib/authz/mock-session-guard'
import {
  recordAuditEvent,
  AuditAction,
  AuditOutcome,
} from '@/lib/services/audit.service'
import { bankProvider } from '@/lib/banking/paystack.provider'
import { checkNameSimilarity, NameMatchResult } from '@/lib/banking/provider'

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

export const updateNextOfKinAction = async (
  userId: string,
  data: NextOfKinInput,
) => {
  try {
    // 1. Authenticate and check permissions + ownership
    await requireMemberOrStaffWithPermission(userId, [
      AdminPermission.PROFILE_CHANGES_REVIEW,
      AdminPermission.MEMBERS_APPROVE,
    ])
    await assertTargetUserIsMember(userId)

    // 2. Validate input schema
    const parsedData = nextOfKinSchema.parse(data)

    // 3. Upsert Next of Kin record
    const result = await prisma.nextOfKin.upsert({
      where: { userId },
      update: {
        name: parsedData.name,
        phoneNumber: parsedData.phoneNumber,
        relationship: parsedData.relationship,
        occupation: parsedData.occupation,
        address: parsedData.address,
        bankName: parsedData.bankName,
        accountNumber: parsedData.accountNumber,
        accountName: parsedData.accountName,
      },
      create: {
        userId,
        name: parsedData.name,
        phoneNumber: parsedData.phoneNumber,
        relationship: parsedData.relationship,
        occupation: parsedData.occupation,
        address: parsedData.address,
        bankName: parsedData.bankName,
        accountNumber: parsedData.accountNumber,
        accountName: parsedData.accountName,
      },
    })

    try {
      revalidatePath(`/dashboard/${userId}/profile`)
      revalidatePath(`/admin/members/${userId}`)
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'updateNextOfKinAction',
      fallbackMessage: 'Failed to update next of kin',
      context: { userId },
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
  accountName: string
  isOverride?: boolean
  overrideReason?: string
}

export const addBankAccountAction = async (
  userId: string,
  data: BankAccountInput,
) => {
  try {
    const actor = await requireMemberOrStaffWithPermission(userId, [
      AdminPermission.PROFILE_CHANGES_REVIEW,
      AdminPermission.MEMBERS_APPROVE,
    ])
    await assertTargetUserIsMember(userId)

    if (data.accountNumber.length !== 10) {
      return { success: false, error: 'Account number must be 10 digits' }
    }

    // Check duplicate active bank account across active members (A-22)
    const existingActiveAccount = await prisma.bankAccount.findFirst({
      where: {
        bankCode: data.bankCode || null,
        accountNumber: data.accountNumber,
        user: { isActive: true },
      },
      include: { user: true },
    })

    if (existingActiveAccount && existingActiveAccount.userId !== userId) {
      // Owner can override with recorded reason
      if (!data.isOverride || actor.role !== UserRole.OWNER) {
        return {
          success: false,
          error:
            'This bank account is already registered by another member. Please contact an administrator.',
        }
      }
      if (!data.overrideReason || data.overrideReason.trim().length === 0) {
        return {
          success: false,
          error:
            'An override reason is required to register a shared bank account.',
        }
      }
    }

    // Check if user already has bank accounts
    const existingAccountsCount = await prisma.bankAccount.count({
      where: { userId },
    })

    // First account is automatically primary
    const isPrimary = existingAccountsCount === 0

    const result = await prisma.bankAccount.create({
      data: {
        userId,
        bankCode: data.bankCode || null,
        bankName: data.bankName,
        accountNumber: data.accountNumber,
        accountName: data.accountName,
        isPrimary,
        isVerified: true,
        verifiedAt: new Date(),
      },
    })

    try {
      revalidatePath(`/dashboard/${userId}/banks`)
      revalidatePath(`/dashboard/${userId}/profile`)
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'addBankAccountAction',
      fallbackMessage: 'Failed to add bank account',
      context: { userId },
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

export const setPrimaryBankAccountAction = async (
  userId: string,
  bankAccountId: string,
) => {
  try {
    await requireMemberOrStaffWithPermission(userId, [
      AdminPermission.PROFILE_CHANGES_REVIEW,
      AdminPermission.MEMBERS_APPROVE,
    ])
    await assertTargetUserIsMember(userId)

    const result = await prisma.$transaction(async (tx) => {
      // Unset all other primary accounts
      await tx.bankAccount.updateMany({
        where: { userId, isPrimary: true },
        data: { isPrimary: false },
      })

      // Set target account as primary
      const updated = await tx.bankAccount.update({
        where: { id: bankAccountId, userId },
        data: { isPrimary: true },
      })

      return updated
    })

    try {
      revalidatePath(`/dashboard/${userId}/banks`)
      revalidatePath(`/dashboard/${userId}/profile`)
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'setPrimaryBankAccountAction',
      fallbackMessage: 'Failed to set primary bank account',
      context: { userId, bankAccountId },
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

export const deleteBankAccountAction = async (
  userId: string,
  bankAccountId: string,
) => {
  try {
    await requireMemberOrStaffWithPermission(userId, [
      AdminPermission.PROFILE_CHANGES_REVIEW,
      AdminPermission.MEMBERS_APPROVE,
    ])
    await assertTargetUserIsMember(userId)

    const targetAccount = await prisma.bankAccount.findUnique({
      where: { id: bankAccountId, userId },
    })

    if (!targetAccount) {
      return { success: false, error: 'Bank account not found' }
    }

    if (targetAccount.isPrimary) {
      const totalAccounts = await prisma.bankAccount.count({
        where: { userId },
      })
      if (totalAccounts > 1) {
        return {
          success: false,
          error:
            'Cannot delete primary bank account. Please set another account as primary first.',
        }
      }
    }

    const result = await prisma.bankAccount.delete({
      where: { id: bankAccountId },
    })

    try {
      revalidatePath(`/dashboard/${userId}/banks`)
      revalidatePath(`/dashboard/${userId}/profile`)
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'deleteBankAccountAction',
      fallbackMessage: 'Failed to delete bank account',
      context: { userId, bankAccountId },
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

    if (!bankCodeOrName || !bankCodeOrName.trim()) {
      return { success: false, error: 'Bank selection is required' }
    }

    const cleanAccount = accountNumber?.trim()
    if (!cleanAccount || cleanAccount.length !== 10) {
      return { success: false, error: 'Account number must be 10 digits' }
    }

    // Resolve bank code if bank name was passed
    const banks = await bankProvider.listBanks()
    // let bankCode = bankCodeOrName.trim()
    let bankCode = '001'
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
