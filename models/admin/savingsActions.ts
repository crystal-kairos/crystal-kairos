'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import {
  AdminPermission,
  SavingsStatus,
  TransactionCategory,
  TransactionStatus,
  TransactionType,
  SavingsType,
  SavingsFrequency,
  SavingsMaturity,
} from '@/generated/prisma/enums'
import { Prisma } from '@/generated/prisma/client'
import {
  assertTargetUserIsMember,
  requirePermission,
} from '@/lib/authz/guards'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { validateAmount } from '@/lib/validation/money'

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

export const createSavingsProductAction = async (
  data: CreateSavingsProductPayload,
) => {
  try {
    const actor = await requirePermission(AdminPermission.SAVINGS_MANAGE)

    const ratesParts: string[] = []
    if (data.interestRate1Month)
      ratesParts.push(`${data.interestRate1Month}% (1M)`)
    if (data.interestRate3Months)
      ratesParts.push(`${data.interestRate3Months}% (3M)`)
    if (data.interestRate6Months)
      ratesParts.push(`${data.interestRate6Months}% (6M)`)
    if (data.interestRate12Months)
      ratesParts.push(`${data.interestRate12Months}% (12M)`)
    const constructedRates =
      ratesParts.length > 0 ? ratesParts.join(' / ') : 'Flexible Rates'

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
        createdBy: actor.id,
      },
    })

    try {
      revalidatePath('/admin/savings')
    } catch {}
    return { success: true, data: newProduct }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'createSavingsProductAction',
      fallbackMessage: 'Failed to create savings product',
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

export const toggleSavingsProductStatusAction = async (
  id: string,
  isActive: boolean,
) => {
  try {
    await requirePermission(AdminPermission.SAVINGS_MANAGE)

    const updated = await prisma.savingsProduct.update({
      where: { id },
      data: { isActive },
    })

    try {
      revalidatePath('/admin/savings')
    } catch {}
    return { success: true, data: updated }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'toggleSavingsProductStatusAction',
      fallbackMessage: 'Failed to update savings product',
      context: { id, isActive },
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

export const updateSavingsProductAction = async (
  id: string,
  data: Partial<CreateSavingsProductPayload>,
) => {
  try {
    await requirePermission(AdminPermission.SAVINGS_MANAGE)

    const ratesParts: string[] = []
    if (data.interestRate1Month)
      ratesParts.push(`${data.interestRate1Month}% (1M)`)
    if (data.interestRate3Months)
      ratesParts.push(`${data.interestRate3Months}% (3M)`)
    if (data.interestRate6Months)
      ratesParts.push(`${data.interestRate6Months}% (6M)`)
    if (data.interestRate12Months)
      ratesParts.push(`${data.interestRate12Months}% (12M)`)

    if (ratesParts.length > 0) {
      data.rates = ratesParts.join(' / ')
    } else if (
      data.interestRate1Month === 0 &&
      data.interestRate3Months === 0 &&
      data.interestRate6Months === 0 &&
      data.interestRate12Months === 0
    ) {
      data.rates = 'Flexible Rates'
    }

    const updated = await prisma.savingsProduct.update({
      where: { id },
      data,
    })

    try {
      revalidatePath('/admin/savings')
    } catch {}
    return { success: true, data: updated }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'updateSavingsProductAction',
      fallbackMessage: 'Failed to update savings product',
      context: { id },
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

export const reviewSavingsTransactionAction = async (
  transactionId: string,
  status: 'CONFIRMED' | 'REJECTED',
  notes?: string,
  rejectionReason?: string,
) => {
  try {
    const actor = await requirePermission(
      AdminPermission.SAVINGS_PAYMENTS_REVIEW,
    )

    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { savings: true },
    })

    if (!transaction)
      return { success: false, error: 'Transaction not found' }
    if (transaction.status !== 'PENDING') {
      return {
        success: false,
        error: 'Only pending transactions can be reviewed',
      }
    }
    if (!transaction.savings) {
      return {
        success: false,
        error: 'Transaction is not linked to a savings plan',
      }
    }

    // Start a Prisma transaction to update both the transaction and the savings balance atomically
    await prisma.$transaction(async (tx) => {
      // 1. Update Transaction status
      await tx.transaction.update({
        where: { id: transactionId },
        data: {
          status,
          notes: notes || transaction.notes,
          rejectionReason: status === 'REJECTED' ? rejectionReason : undefined,
          processedBy: actor.id,
          processedAt: new Date(),
        },
      })

      // 2. If approved and it's a deposit, increment the balance
      if (status === 'CONFIRMED' && transaction.type === 'DEPOSIT') {
        const amount = transaction.amount.toNumber()
        const newTotalDeposited =
          transaction.savings!.totalDeposited.toNumber() + amount
        const newCurrentBalance =
          transaction.savings!.currentBalance.toNumber() + amount

        await tx.savings.update({
          where: { id: transaction.savingsId! },
          data: {
            totalDeposited: newTotalDeposited,
            currentBalance: newCurrentBalance,
            status:
              transaction.savings!.status === 'PENDING' ? 'ACTIVE' : undefined,
          },
        })
      }
    })

    try {
      revalidatePath('/admin/savings')
      if (transaction.savingsId) {
        revalidatePath(`/admin/savings/accounts/${transaction.savingsId}`)
        revalidatePath(
          `/dashboard/${transaction.userId}/savings/${transaction.savingsId}`,
        )
      }
    } catch {}

    return { success: true }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'reviewSavingsTransactionAction',
      fallbackMessage: 'Failed to review transaction',
      context: { transactionId, status },
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

export const createSavingsForMemberAction = async (data: {
  userId: string
  productId: string
  targetAmount: number
  frequency: SavingsFrequency
  maturity: SavingsMaturity
  receiptUrl?: string
}) => {
  try {
    const actor = await requirePermission(AdminPermission.SAVINGS_MANAGE)

    const { userId, productId, targetAmount, frequency, maturity, receiptUrl } =
      data

    const validatedTargetAmount = validateAmount(targetAmount, 'targetAmount')
    const targetAmountNum = validatedTargetAmount.toNumber()

    await assertTargetUserIsMember(userId)

    // Verify member exists and has bank accounts
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { bankAccounts: true },
    })

    if (!user) return { success: false, error: 'Member not found.' }
    if (!user.bankAccounts || user.bankAccounts.length === 0) {
      return {
        success: false,
        error: 'Member must have a bank account set up first.',
      }
    }
    const defaultBank = user.bankAccounts[0]

    // Verify product
    const product = await prisma.savingsProduct.findUnique({
      where: { id: productId },
    })
    if (!product) {
      return { success: false, error: 'Savings product not found.' }
    }

    let interestRate = 0
    switch (maturity) {
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

    const savingsType = SavingsType.REGULAR

    let periods = 1
    if (frequency === SavingsFrequency.DAILY) {
      periods =
        maturity === 'ONE_MONTH'
          ? 30
          : maturity === 'THREE_MONTHS'
            ? 90
            : maturity === 'SIX_MONTHS'
              ? 180
              : 365
    } else if (frequency === SavingsFrequency.WEEKLY) {
      periods =
        maturity === 'ONE_MONTH'
          ? 4
          : maturity === 'THREE_MONTHS'
            ? 12
            : maturity === 'SIX_MONTHS'
              ? 26
              : 52
    } else if (frequency === SavingsFrequency.MONTHLY) {
      periods =
        maturity === 'ONE_MONTH'
          ? 1
          : maturity === 'THREE_MONTHS'
            ? 3
            : maturity === 'SIX_MONTHS'
              ? 6
              : 12
    }

    const totalContribution = targetAmountNum * periods
    const interestAmount = (totalContribution * interestRate) / 100
    const expectedMaturityAmount = totalContribution + interestAmount

    const result = await prisma.$transaction(async (tx) => {
      const savings = await tx.savings.create({
        data: {
          userId,
          savingsType,
          targetAmount: validatedTargetAmount,
          frequency,
          maturity,
          interestRate: new Prisma.Decimal(interestRate),
          bankName: defaultBank.bankName,
          accountNumber: defaultBank.accountNumber,
          accountName: defaultBank.accountName,
          expectedMaturityAmount: new Prisma.Decimal(expectedMaturityAmount),
          isAnonymousRequest: false,
          status: receiptUrl ? SavingsStatus.ACTIVE : SavingsStatus.PENDING,
          productId,
        },
      })

      if (receiptUrl) {
        await tx.transaction.create({
          data: {
            userId,
            amount: new Prisma.Decimal(targetAmount),
            type: TransactionType.DEPOSIT,
            category: TransactionCategory.SAVINGS_DEPOSIT,
            status: TransactionStatus.CONFIRMED,
            savingsId: savings.id,
            receiptUrl,
            notes: 'Initial deposit by Admin',
            recordedBy: actor.id,
            processedBy: actor.id,
            processedAt: new Date(),
          },
        })

        await tx.savings.update({
          where: { id: savings.id },
          data: {
            currentBalance: new Prisma.Decimal(targetAmount),
          },
        })
      }

      return savings
    })

    try {
      revalidatePath('/admin/savings')
      revalidatePath(`/dashboard/${userId}/savings`)
    } catch {}
    return { success: true, data: result }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'createSavingsForMemberAction',
      fallbackMessage: 'Failed to create savings plan.',
      context: { userId: data.userId, productId: data.productId },
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
