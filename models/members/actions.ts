'use server'

import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { nextOfKinSchema } from '@/schema/auth.schema'
import { revalidatePath } from 'next/cache'
import { AdminPermission, Relationship } from '@/generated/prisma/enums'
import {
  assertTargetUserIsMember,
  requireAuthenticatedSession,
  requireMemberOrStaffWithPermission,
} from '@/lib/authz/guards'
import { toActionErrorResult } from '@/lib/errors/to-action-result'

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
  if (
    process.env.MOCK_SESSION_USER &&
    process.env.NODE_ENV !== 'test'
  ) {
    throw new Error(
      'MOCK_SESSION_USER is forbidden outside NODE_ENV=test.',
    )
  }

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
  bankName: string
  accountNumber: string
  accountName: string
}

export const addBankAccountAction = async (
  userId: string,
  data: BankAccountInput,
) => {
  try {
    await requireMemberOrStaffWithPermission(userId, [
      AdminPermission.PROFILE_CHANGES_REVIEW,
      AdminPermission.MEMBERS_APPROVE,
    ])
    await assertTargetUserIsMember(userId)

    if (data.accountNumber.length !== 10) {
      return { success: false, error: 'Account number must be 10 digits' }
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
        bankName: data.bankName,
        accountNumber: data.accountNumber,
        accountName: data.accountName,
        isPrimary,
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

export const resolveAccountNameAction = async (
  _bankName: string,
  accountNumber: string,
) => {
  try {
    void _bankName
    await requireAuthenticatedSession()

    if (accountNumber.length !== 10) {
      return { success: false, error: 'Account number must be 10 digits' }
    }

    // Simulate NIBSS network latency (500ms)
    await new Promise((resolve) => setTimeout(resolve, 500))

    let resolvedName = 'Olumide Bakare'
    if (accountNumber.startsWith('0')) {
      resolvedName = 'Ade Wale'
    } else if (accountNumber.startsWith('1')) {
      resolvedName = 'Chinelo Ngozi'
    } else if (accountNumber.startsWith('2')) {
      resolvedName = 'Chinedu Okafor'
    } else if (accountNumber.startsWith('3')) {
      resolvedName = 'Amina Ibrahim'
    }

    return { success: true, accountName: resolvedName }
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
