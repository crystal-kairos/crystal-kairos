'use server'

import { prisma } from '@/lib/prisma'
import { serializeSavings } from '@/lib/savings'
import { AdminPermission } from '@/generated/prisma/enums'
import {
  AuthzError,
  requireAuthenticatedSession,
  requireMemberOrStaffWithPermission,
} from '@/lib/authz/guards'

/**
 * Fetches a single savings plan by ID along with its transactions.
 * Requires either the plan owner (member) or staff with savings read/manage/review permissions.
 */
export const getSavingsPlanById = async (savingsId: string) => {
  try {
    const savings = await prisma.savings.findUnique({
      where: { id: savingsId },
      include: {
        user: { select: { name: true, email: true, username: true } },
        transactions: {
          orderBy: { createdAt: 'desc' },
        },
        periods: {
          orderBy: { periodNumber: 'asc' },
        },
      },
    })

    if (!savings) {
      return { success: false, error: 'Savings plan not found' }
    }

    await requireMemberOrStaffWithPermission(savings.userId, [
      AdminPermission.SAVINGS_READ,
      AdminPermission.SAVINGS_MANAGE,
      AdminPermission.SAVINGS_PAYMENTS_REVIEW,
    ])

    const serializedSavings = serializeSavings(savings)
    const serializedTransactions = (savings.transactions || []).map((t) => ({
      ...t,
      amount: Number(t.amount),
    }))

    const serializedPeriods = (savings.periods || []).map((p) => ({
      ...p,
      amountDue: Number(p.amountDue),
      amountPaid: Number(p.amountPaid),
    }))

    return {
      success: true,
      data: {
        ...serializedSavings,
        transactions: serializedTransactions,
        periods: serializedPeriods,
      },
    }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error fetching savings plan:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to fetch savings plan',
    }
  }
}

/**
 * Fetches all active savings products
 */
export const getSavingsProducts = async () => {
  try {
    await requireAuthenticatedSession()
    const products = await prisma.savingsProduct.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    })
    return { success: true, data: products }
  } catch (error: unknown) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Failed to fetch savings products:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to fetch products',
    }
  }
}

export const getSavingsProductById = async (id: string) => {
  try {
    await requireAuthenticatedSession()
    const product = await prisma.savingsProduct.findUnique({
      where: { id },
    })
    return { success: true, data: product }
  } catch (error: unknown) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Failed to fetch savings product:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to fetch product',
    }
  }
}
