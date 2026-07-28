'use server'

import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

export const getLoanSettingsAction = async () => {
  try {
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
      } 
    }
  } catch (error: any) {
    console.error('Failed to fetch loan settings:', error)
    return { success: false, error: 'Failed to fetch loan settings' }
  }
}

export const updateLoanSettingsAction = async (interestRate: number) => {
  try {
    const session = await auth()
    if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized' }
    }

    if (interestRate < 0 || interestRate > 100) {
      return { success: false, error: 'Interest rate must be between 0 and 100' }
    }

    const updated = await prisma.loanSettings.upsert({
      where: { id: 'global' },
      update: {
        interestRate,
        updatedBy: session.user.id,
      },
      create: {
        id: 'global',
        interestRate,
        updatedBy: session.user.id,
      },
    })

    revalidatePath('/admin/loans')
    return { success: true, data: { interestRate: Number(updated.interestRate) } }
  } catch (error: any) {
    console.error('Failed to update loan settings:', error)
    return { success: false, error: 'Failed to update loan settings' }
  }
}
