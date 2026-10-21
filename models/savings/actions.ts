'use server'

import { prisma } from '@/lib/prisma'
import {
  SavingsType,
  SavingsFrequency,
  SavingsMaturity,
  SavingsStatus,
  TransactionCategory,
  TransactionType,
  TransactionStatus,
} from '@/generated/prisma/enums'
import { revalidatePath } from 'next/cache'
import { Prisma } from '@/generated/prisma/client'
import {
  serializeSavings,
  serializeTransaction,
  getInterestRate,
  getPeriodsCount,
} from '@/lib/savings'
import { AuthzError, requireMemberSession } from '@/lib/authz/guards'

/**
 * Creates a new savings plan in PENDING status.
 */
export const createSavingsPlanAction = async (
  userId: string,
  data: {
    savingsType: SavingsType
    targetAmount: number
    frequency: SavingsFrequency
    maturity: SavingsMaturity
    bankName: string
    accountNumber: string
    accountName: string
    productId?: string
  },
) => {
  try {
    const actor = await requireMemberSession(userId)

    let interestRate = 0
    if (data.productId) {
      const product = await prisma.savingsProduct.findUnique({
        where: { id: data.productId },
      })
      if (product) {
        switch (data.maturity) {
          case SavingsMaturity.ONE_MONTH:
            interestRate = Number(product.interestRate1Month || 0)
            break
          case SavingsMaturity.THREE_MONTHS:
            interestRate = Number(product.interestRate3Months || 0)
            break
          case SavingsMaturity.SIX_MONTHS:
            interestRate = Number(product.interestRate6Months || 0)
            break
          case SavingsMaturity.TWELVE_MONTHS:
            interestRate = Number(product.interestRate12Months || 0)
            break
        }
      }
    } else {
      // Fallback for older creations
      interestRate = getInterestRate(data.savingsType, data.maturity)
    }

    // Calculate expected maturity amount
    let totalContribution = data.targetAmount
    if (data.savingsType === SavingsType.REGULAR) {
      const periods = getPeriodsCount(data.frequency, data.maturity)
      totalContribution = data.targetAmount * Math.round(periods)
    }

    const interestAmount = (totalContribution * interestRate) / 100
    const expectedMaturityAmount = totalContribution + interestAmount

    const newSavings = await prisma.savings.create({
      data: {
        userId: actor.id,
        savingsType: data.savingsType,
        targetAmount: data.targetAmount,
        frequency: data.frequency,
        maturity: data.maturity,
        interestRate: new Prisma.Decimal(interestRate.toString()),
        bankName: data.bankName,
        accountNumber: data.accountNumber,
        accountName: data.accountName,
        expectedMaturityAmount: new Prisma.Decimal(
          expectedMaturityAmount.toString(),
        ),
        isAnonymousRequest: false,
        status: SavingsStatus.PENDING,
        productId: data.productId || null,
      },
    })

    try {
      revalidatePath(`/dashboard/${actor.id}/savings`)
      revalidatePath(`/dashboard/${actor.id}`)
    } catch {
      // Ignored outside Next.js context
    }

    return { success: true, data: serializeSavings(newSavings) }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error creating savings plan:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to create savings plan',
    }
  }
}

/**
 * Submit savings deposit receipt for verification
 */
export const submitSavingsDepositAction = async (
  userId: string,
  data: {
    savingsId: string
    amount: number
    receiptUrl: string
    referenceNumber?: string
    notes?: string
  },
) => {
  try {
    const actor = await requireMemberSession(userId)

    const savings = await prisma.savings.findFirst({
      where: { id: data.savingsId, userId: actor.id },
    })

    if (!savings) {
      return { success: false, error: 'Savings plan not found' }
    }

    const newTransaction = await prisma.transaction.create({
      data: {
        userId: actor.id,
        amount: new Prisma.Decimal(data.amount.toString()),
        category: TransactionCategory.SAVINGS_DEPOSIT,
        type: TransactionType.DEPOSIT,
        status: TransactionStatus.PENDING,
        savingsId: data.savingsId,
        receiptUrl: data.receiptUrl,
        referenceNumber: data.referenceNumber || null,
        notes: data.notes || null,
        recordedBy: actor.id,
      },
    })

    try {
      revalidatePath(`/dashboard/${actor.id}/savings`)
      revalidatePath(`/dashboard/${actor.id}`)
    } catch {
      // Ignored outside Next.js context
    }

    return { success: true, data: serializeTransaction(newTransaction) }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error submitting savings deposit:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to submit savings deposit',
    }
  }
}

/**
 * Request savings plan withdrawal.
 * Sets the plan earlyWithdrawal flag and forfeits interest if not matured yet.
 */
export const requestSavingsWithdrawalAction = async (
  userId: string,
  savingsId: string,
  notes?: string,
) => {
  try {
    const actor = await requireMemberSession(userId)

    const savings = await prisma.savings.findFirst({
      where: { id: savingsId, userId: actor.id },
    })

    if (!savings) {
      return { success: false, error: 'Savings plan not found' }
    }

    if (savings.status !== SavingsStatus.ACTIVE) {
      return {
        success: false,
        error: 'Only active savings plans can be withdrawn',
      }
    }

    const now = new Date()
    const isEarly = savings.maturityDate ? now < savings.maturityDate : true

    // Principal balance
    const currentBalance = Number(savings.currentBalance)
    const accruedInterest = Number(savings.accruedInterest)

    // If early withdrawal, interest is 100% forfeited
    const withdrawAmount = isEarly
      ? currentBalance
      : currentBalance + accruedInterest

    const updatedSavings = await prisma.savings.update({
      where: { id: savingsId },
      data: {
        status: isEarly
          ? SavingsStatus.EARLY_WITHDRAWAL
          : SavingsStatus.WITHDRAWN,
        earlyWithdrawal: isEarly,
        accruedInterest: isEarly ? 0 : savings.accruedInterest, // Forfeit interest if early
      },
    })

    // Create a pending withdrawal transaction (to enter the admin disbursement queue)
    const newTransaction = await prisma.transaction.create({
      data: {
        userId: actor.id,
        amount: new Prisma.Decimal(withdrawAmount.toString()),
        category: TransactionCategory.SAVINGS_WITHDRAWAL,
        type: TransactionType.WITHDRAWAL,
        status: TransactionStatus.PENDING,
        savingsId: savingsId,
        notes:
          notes ||
          (isEarly
            ? 'Early withdrawal request - interest forfeited'
            : 'Matured savings withdrawal request'),
        recordedBy: actor.id,
        bankAccountId: null, // Admin will disburse to the saved details on the Savings record
      },
    })

    try {
      revalidatePath(`/dashboard/${actor.id}/savings`)
      revalidatePath(`/dashboard/${actor.id}`)
    } catch {
      // Ignored outside Next.js context
    }

    return {
      success: true,
      data: {
        savings: serializeSavings(updatedSavings),
        transaction: serializeTransaction(newTransaction),
      },
    }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error requesting savings withdrawal:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to request savings withdrawal',
    }
  }
}
