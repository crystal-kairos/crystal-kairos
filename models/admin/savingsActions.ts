'use server'

import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

export interface CreateSavingsProductPayload {
  type: 'FIXED' | 'REGULAR' | 'STAGGERED'
  title: string
  description: string
  rates?: string
  badge: string
  icon: string
  interestRate1Month?: number
  interestRate3Months?: number
  interestRate6Months?: number
  interestRate12Months?: number
}

export const createSavingsProductAction = async (data: CreateSavingsProductPayload) => {
  try {
    const session = await auth()
    if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { error: 'Unauthorized' }
    }

    const ratesParts: string[] = []
    if (data.interestRate1Month) ratesParts.push(`${data.interestRate1Month}% (1M)`)
    if (data.interestRate3Months) ratesParts.push(`${data.interestRate3Months}% (3M)`)
    if (data.interestRate6Months) ratesParts.push(`${data.interestRate6Months}% (6M)`)
    if (data.interestRate12Months) ratesParts.push(`${data.interestRate12Months}% (12M)`)
    const constructedRates = ratesParts.length > 0 ? ratesParts.join(' / ') : 'Flexible Rates'

    const newProduct = await prisma.savingsProduct.create({
      data: {
        type: data.type,
        title: data.title,
        description: data.description,
        rates: constructedRates,
        badge: data.badge,
        icon: data.icon,
        interestRate1Month: data.interestRate1Month ?? null,
        interestRate3Months: data.interestRate3Months ?? null,
        interestRate6Months: data.interestRate6Months ?? null,
        interestRate12Months: data.interestRate12Months ?? null,
        createdBy: session.user.id,
      },
    })

    revalidatePath('/admin/savings')
    return { success: true, data: newProduct }
  } catch (error: any) {
    console.error('Error creating savings product:', error)
    return { error: error.message || 'Failed to create savings product' }
  }
}

export const toggleSavingsProductStatusAction = async (id: string, isActive: boolean) => {
  try {
    const session = await auth()
    if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { error: 'Unauthorized' }
    }

    const updated = await prisma.savingsProduct.update({
      where: { id },
      data: { isActive },
    })

    revalidatePath('/admin/savings')
    return { success: true, data: updated }
  } catch (error: any) {
    console.error('Error updating savings product status:', error)
    return { error: error.message || 'Failed to update savings product' }
  }
}

export const updateSavingsProductAction = async (id: string, data: Partial<CreateSavingsProductPayload>) => {
  try {
    const session = await auth()
    if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { error: 'Unauthorized' }
    }

    const ratesParts: string[] = []
    if (data.interestRate1Month) ratesParts.push(`${data.interestRate1Month}% (1M)`)
    if (data.interestRate3Months) ratesParts.push(`${data.interestRate3Months}% (3M)`)
    if (data.interestRate6Months) ratesParts.push(`${data.interestRate6Months}% (6M)`)
    if (data.interestRate12Months) ratesParts.push(`${data.interestRate12Months}% (12M)`)
    
    if (ratesParts.length > 0) {
      data.rates = ratesParts.join(' / ')
    } else if (data.interestRate1Month === 0 && data.interestRate3Months === 0 && data.interestRate6Months === 0 && data.interestRate12Months === 0) {
      data.rates = 'Flexible Rates'
    }

    const updated = await prisma.savingsProduct.update({
      where: { id },
      data,
    })

    revalidatePath('/admin/savings')
    return { success: true, data: updated }
  } catch (error: any) {
    console.error('Error updating savings product:', error)
    return { error: error.message || 'Failed to update savings product' }
  }
}

export const reviewSavingsTransactionAction = async (transactionId: string, status: 'CONFIRMED' | 'REJECTED', notes?: string, rejectionReason?: string) => {
  try {
    const session = await auth()
    if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { error: 'Unauthorized' }
    }

    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { savings: true },
    })

    if (!transaction) return { error: 'Transaction not found' }
    if (transaction.status !== 'PENDING') return { error: 'Only pending transactions can be reviewed' }
    if (!transaction.savings) return { error: 'Transaction is not linked to a savings plan' }

    // Start a Prisma transaction to update both the transaction and the savings balance atomically
    await prisma.$transaction(async (tx) => {
      // 1. Update Transaction status
      await tx.transaction.update({
        where: { id: transactionId },
        data: {
          status,
          notes: notes || transaction.notes,
          rejectionReason: status === 'REJECTED' ? rejectionReason : undefined,
          processedBy: session.user.id,
          processedAt: new Date(),
        },
      })

      // 2. If approved and it's a deposit, increment the balance
      if (status === 'CONFIRMED' && transaction.type === 'DEPOSIT') {
        const amount = transaction.amount.toNumber()
        const newTotalDeposited = transaction.savings!.totalDeposited.toNumber() + amount
        const newCurrentBalance = transaction.savings!.currentBalance.toNumber() + amount

        await tx.savings.update({
          where: { id: transaction.savingsId! },
          data: {
            totalDeposited: newTotalDeposited,
            currentBalance: newCurrentBalance,
            status: transaction.savings!.status === 'PENDING' ? 'ACTIVE' : undefined,
          },
        })
      }
    })

    revalidatePath('/admin/savings')
    if (transaction.savingsId) {
      revalidatePath(`/admin/savings/accounts/${transaction.savingsId}`)
      revalidatePath(`/dashboard/${transaction.userId}/savings/${transaction.savingsId}`)
    }

    return { success: true }
  } catch (error: any) {
    console.error('Error reviewing savings transaction:', error)
    return { error: error.message || 'Failed to review transaction' }
  }
}
