'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { AdminPermission } from '@/generated/prisma/enums'
import {
  AuthzError,
  requireAuthenticatedSession,
  requirePermission,
} from '@/lib/authz/guards'

export const getLoanSettingsAction = async () => {
  try {
    await requireAuthenticatedSession()

    const settings = await prisma.loanSettings.findUnique({
      where: { id: 'global' },
    })

    if (!settings) {
      // Return default if not initialized
      return { success: true, data: { interestRate: 5.0 } }
    }

    return {
      success: true,
      data: {
        interestRate: Number(settings.interestRate),
      },
    }
  } catch (error: unknown) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Failed to fetch loan settings:', error)
    return { success: false, error: 'Failed to fetch loan settings' }
  }
}

export const updateLoanSettingsAction = async (interestRate: number) => {
  try {
    const actor = await requirePermission(AdminPermission.LOAN_SETTINGS_MANAGE)

    if (interestRate < 0 || interestRate > 100) {
      return {
        success: false,
        error: 'Interest rate must be between 0 and 100',
      }
    }

    const updated = await prisma.loanSettings.upsert({
      where: { id: 'global' },
      update: {
        interestRate,
        updatedBy: actor.id,
      },
      create: {
        id: 'global',
        interestRate,
        updatedBy: actor.id,
      },
    })

    try {
      revalidatePath('/admin/loans')
    } catch {}
    return {
      success: true,
      data: { interestRate: Number(updated.interestRate) },
    }
  } catch (error: unknown) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Failed to update loan settings:', error)
    return { success: false, error: 'Failed to update loan settings' }
  }
}
