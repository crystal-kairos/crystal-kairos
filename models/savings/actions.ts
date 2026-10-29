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
import { requireMemberSession } from '@/lib/authz/guards'
import { bindStoredFileToRecord } from '@/lib/storage/cloudinary'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { AppError } from '@/lib/errors/app-error'
import { validateAmount } from '@/lib/validation/money'
import { lockMembers } from '@/lib/db/concurrency'
import { assertSavingsWithdrawalAllowed } from '@/lib/services/guarantees.service'
import { recordAuditEvent, AuditAction, AuditOutcome } from '@/lib/services/audit.service'

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
    const validatedTargetAmount = validateAmount(data.targetAmount, 'targetAmount')

    let interestRate = 0
    const maturityMonthsMap: Record<SavingsMaturity, number> = {
      [SavingsMaturity.ONE_MONTH]: 1,
      [SavingsMaturity.THREE_MONTHS]: 3,
      [SavingsMaturity.SIX_MONTHS]: 6,
      [SavingsMaturity.TWELVE_MONTHS]: 12,
    }
    const durationMonths = (data as any).durationMonths ?? maturityMonthsMap[data.maturity] ?? 6
    let termRateVersion = 1

    if (data.productId) {
      const termRate = await prisma.savingsProductTermRate.findFirst({
        where: { productId: data.productId, durationMonths, isActive: true },
        orderBy: { version: 'desc' },
      })

      if (termRate) {
        interestRate = Number(termRate.ratePercent)
        termRateVersion = termRate.version
      } else {
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
      }
    } else {
      // Fallback for older creations
      interestRate = getInterestRate(data.savingsType, data.maturity)
    }

    // Calculate expected maturity amount
    const targetAmountNum = validatedTargetAmount.toNumber()
    let totalContribution = targetAmountNum
    if (data.savingsType === SavingsType.REGULAR) {
      const periods = getPeriodsCount(data.frequency, data.maturity)
      totalContribution = targetAmountNum * Math.round(periods)
    }

    const interestAmount = (totalContribution * interestRate) / 100
    const expectedMaturityAmount = totalContribution + interestAmount

    const newSavings = await prisma.savings.create({
      data: {
        userId: actor.id,
        savingsType: data.savingsType,
        targetAmount: validatedTargetAmount,
        frequency: data.frequency,
        maturity: data.maturity,
        durationMonths,
        ratePercent: new Prisma.Decimal(interestRate.toString()),
        interestCalculationMethod: 'SIMPLE_INTEREST_HELD_FRACTION',
        savingsProductTermRateVersion: termRateVersion,
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

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      affectedUserId: actor.id,
      action: AuditAction.SAVINGS_PLAN_CREATED,
      entityType: 'Savings',
      entityId: newSavings.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: {
        savingsId: newSavings.id,
        targetAmount: Number(newSavings.targetAmount),
        durationMonths,
        ratePercent: Number(newSavings.ratePercent),
        accountNumber: data.accountNumber,
      },
    }).catch(() => {})

    try {
      revalidatePath(`/dashboard/${actor.id}/savings`)
      revalidatePath(`/dashboard/${actor.id}`)
    } catch {
      // Ignored outside Next.js context
    }

    return { success: true, data: serializeSavings(newSavings) }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'createSavingsPlanAction',
      fallbackMessage: 'Failed to create savings plan',
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
    const validatedAmount = validateAmount(data.amount)

    const savings = await prisma.savings.findFirst({
      where: { id: data.savingsId, userId: actor.id },
    })

    if (!savings) {
      return { success: false, error: 'Savings plan not found' }
    }

    const newTransaction = await prisma.transaction.create({
      data: {
        userId: actor.id,
        amount: validatedAmount,
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

    await bindStoredFileToRecord({
      fileUrl: data.receiptUrl,
      ownerUserId: actor.id,
      associatedType: 'TRANSACTION',
      associatedId: newTransaction.id,
    })

    try {
      revalidatePath(`/dashboard/${actor.id}/savings`)
      revalidatePath(`/dashboard/${actor.id}`)
    } catch {
      // Ignored outside Next.js context
    }

    return { success: true, data: serializeTransaction(newTransaction) }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'submitSavingsDepositAction',
      fallbackMessage: 'Failed to submit savings deposit',
      context: { userId, savingsId: data.savingsId },
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

    const result = await prisma.$transaction(async (tx) => {
      // 1. Transaction advisory lock on member (§2.1, §2.7)
      await lockMembers(tx, [actor.id])

      const savings = await tx.savings.findFirst({
        where: { id: savingsId, userId: actor.id },
      })

      if (!savings) {
        throw new AppError('NOT_FOUND', 'Savings plan not found', {
          statusCode: 404,
        })
      }

      if (savings.status !== SavingsStatus.ACTIVE) {
        throw new AppError(
          'INVALID_STATE',
          'Only active savings plans can be withdrawn',
          { statusCode: 422 },
        )
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

      // 2. Enforce own-savings lock (FULL mode) and guarantee encumbrances (§2.1, D-02)
      await assertSavingsWithdrawalAllowed(tx, {
        memberId: actor.id,
        withdrawalAmount: currentBalance,
      })

      const updatedSavings = await tx.savings.update({
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
      const newTransaction = await tx.transaction.create({
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

      return {
        savings: serializeSavings(updatedSavings),
        transaction: serializeTransaction(newTransaction),
      }
    })

    try {
      revalidatePath(`/dashboard/${actor.id}/savings`)
      revalidatePath(`/dashboard/${actor.id}`)
    } catch {
      // Ignored outside Next.js context
    }

    return {
      success: true,
      data: result,
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'requestSavingsWithdrawalAction',
      fallbackMessage: 'Failed to request savings withdrawal',
      context: { userId, savingsId },
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
