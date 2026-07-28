'use server'

import { prisma } from '@/lib/prisma'
import { serializeSavings } from '@/lib/savings'

/**
 * Fetches a single savings plan by ID along with its transactions
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
      },
    })

    if (!savings) {
      return { success: false, error: 'Savings plan not found' }
    }

    const serializedSavings = serializeSavings(savings)
    const serializedTransactions = (savings.transactions || []).map((t) => ({
      ...t,
      amount: Number(t.amount),
    }))

    return {
      success: true,
      data: {
        ...serializedSavings,
        transactions: serializedTransactions,
      },
    }
  } catch (error) {
    console.error('Error fetching savings plan:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch savings plan',
    }
  }
}

/**
 * Fetches all active savings products
 */
export const getSavingsProducts = async () => {
  try {
    const products = await prisma.savingsProduct.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    })
    return { success: true, data: products }
  } catch (error: any) {
    console.error('Failed to fetch savings products:', error)
    return { success: false, error: error.message || 'Failed to fetch products' }
  }
}

export const getSavingsProductById = async (id: string) => {
  try {
    const product = await prisma.savingsProduct.findUnique({
      where: { id },
    })
    return { success: true, data: product }
  } catch (error: any) {
    console.error('Failed to fetch savings product:', error)
    return { success: false, error: error.message || 'Failed to fetch product' }
  }
}
