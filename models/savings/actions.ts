'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { SavingsFrequency } from '@/generated/prisma/enums'
import { serializeSavings } from '@/lib/savings'
import { requireMemberSession } from '@/lib/authz/guards'
import { extractStoredFileIdFromUrl } from '@/lib/storage/cloudinary'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { AppError } from '@/lib/errors/app-error'
import { validateAmount } from '@/lib/validation/money'
import { assertProductEligibility } from '@/lib/services/profile.service'
import {
  cancelSavingsWithdrawal,
  requestSavingsWithdrawal,
  submitSavingsDeposit,
  subscribeToSavingsPlan,
} from '@/lib/services/savings.service'
import { applyWallet } from '@/lib/services/wallet.service'

function revalidateSavings(memberId: string, savingsId?: string) {
  try {
    revalidatePath(`/dashboard/${memberId}/savings`)
    revalidatePath(`/dashboard/${memberId}`)
    if (savingsId) revalidatePath(`/dashboard/${memberId}/savings/${savingsId}`)
  } catch {
    // Ignored outside a Next.js request
  }
}

const subscribeSchema = z.object({
  productId: z.string().uuid('Choose a savings plan.'),
  durationMonths: z.coerce.number().int().min(1, 'Choose a term between 1 and 12 months.').max(12, 'Choose a term between 1 and 12 months.'),
  targetAmount: z.union([z.number(), z.string()]).optional().nullable(),
  frequency: z.nativeEnum(SavingsFrequency).optional().nullable(),
})

/**
 * Subscribes the signed-in member to a savings plan and term (D-08, D-09).
 * The plan is PENDING with no schedule until the first deposit is confirmed.
 */
export const createSavingsPlanAction = async (
  userId: string,
  data: {
    productId: string
    durationMonths: number
    targetAmount?: number | string | null
    frequency?: SavingsFrequency | null
  },
) => {
  try {
    const actor = await requireMemberSession(userId)
    await assertProductEligibility(actor.id, 'SAVINGS')
    const parsed = subscribeSchema.parse(data)
    const targetAmount =
      parsed.targetAmount === undefined || parsed.targetAmount === null || parsed.targetAmount === ''
        ? null
        : validateAmount(parsed.targetAmount, 'targetAmount')

    const savings = await subscribeToSavingsPlan({
      memberId: actor.id,
      productId: parsed.productId,
      durationMonths: parsed.durationMonths,
      targetAmount,
      frequency: parsed.frequency ?? null,
    })
    revalidateSavings(actor.id)
    return { success: true, data: serializeSavings(savings) }
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

const depositSchema = z.object({
  savingsId: z.string().uuid(),
  amount: z.union([z.number(), z.string()]),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date you paid.'),
  periodIds: z.array(z.string().uuid()).max(400).optional(),
  receiptUrl: z.string().min(1, 'Upload your payment receipt.'),
  bankReference: z.string().trim().max(100).optional(),
  payerAccountName: z.string().trim().max(150).optional(),
  narration: z.string().trim().max(200).optional(),
  resubmissionOfId: z.string().uuid().optional(),
})

/**
 * Uploads a receipt for a savings deposit (first deposit, regular periods, or a fixed/staggered
 * deposit). Creates a PaymentSubmission; nothing moves until staff confirm it.
 */
export const submitSavingsDepositAction = async (
  userId: string,
  data: {
    savingsId: string
    amount: number | string
    paidOn: string
    periodIds?: string[]
    receiptUrl: string
    bankReference?: string
    payerAccountName?: string
    narration?: string
    resubmissionOfId?: string
  },
) => {
  try {
    const actor = await requireMemberSession(userId)
    const parsed = depositSchema.parse(data)
    const amount = validateAmount(parsed.amount)
    const receiptFileId = extractStoredFileIdFromUrl(parsed.receiptUrl)
    if (!receiptFileId) {
      throw new AppError('VALIDATION_ERROR', 'Upload your payment receipt.', {
        statusCode: 400,
        fieldErrors: { receiptUrl: ['Upload your payment receipt.'] },
      })
    }

    const { submission, warnings } = await submitSavingsDeposit({
      memberId: actor.id,
      savingsId: parsed.savingsId,
      amount,
      paidOn: parsed.paidOn,
      periodIds: parsed.periodIds,
      receiptFileId,
      bankReference: parsed.bankReference || undefined,
      payerAccountName: parsed.payerAccountName || undefined,
      narration: parsed.narration || undefined,
      resubmissionOfId: parsed.resubmissionOfId,
    })
    revalidateSavings(actor.id, parsed.savingsId)
    return {
      success: true,
      data: {
        submissionId: submission.id,
        submissionNumber: submission.submissionNumber,
        possibleDuplicate: warnings.hasDuplicateHashWarning || warnings.hasDuplicateReferenceWarning,
      },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'submitSavingsDepositAction',
      fallbackMessage: 'Failed to submit savings deposit',
      context: { userId, savingsId: data?.savingsId },
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
 * Requests withdrawal of a savings plan. Early withdrawal forfeits all accrued interest;
 * at/after maturity the payout is principal plus accrued interest. Refused while the
 * principal is locked by an own loan or reserved for a guarantee (§2.1).
 */
export const requestSavingsWithdrawalAction = async (userId: string, savingsId: string) => {
  try {
    const actor = await requireMemberSession(userId)
    const id = z.string().min(1).max(64).parse(savingsId)
    const result = await requestSavingsWithdrawal({ memberId: actor.id, savingsId: id })
    revalidateSavings(actor.id, id)
    return {
      success: true,
      data: {
        savingsId: result.savingsId,
        kind: result.kind,
        principal: result.principal.toNumber(),
        interest: result.interest.toNumber(),
      },
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

/** The member cancels their own withdrawal request before staff approve it. */
export const cancelSavingsWithdrawalAction = async (userId: string, savingsId: string) => {
  try {
    const actor = await requireMemberSession(userId)
    const id = z.string().uuid().parse(savingsId)
    const result = await cancelSavingsWithdrawal({
      savingsId: id,
      actorId: actor.id,
      memberId: actor.id,
      reason: 'Cancelled by the member',
    })
    revalidateSavings(actor.id, id)
    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'cancelSavingsWithdrawalAction',
      fallbackMessage: 'Failed to cancel the withdrawal',
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

/**
 * Member-initiated wallet payment toward a savings plan or selected savings periods (§2.11, D-12, P3-06).
 */
export const paySavingsFromWalletAction = async (
  userId: string,
  data: {
    savingsId: string
    amount: number | string
    periodIds?: string[]
    idempotencyKey?: string
  },
) => {
  try {
    const actor = await requireMemberSession(userId)
    const savingsId = z.string().uuid().parse(data.savingsId)
    const amount = validateAmount(data.amount)
    const periodIds = data.periodIds?.length ? data.periodIds : [null]

    const result = await applyWallet({
      memberId: actor.id,
      mode: 'MEMBER',
      requestedAmount: amount,
      targets: periodIds.map((pid) => ({
        targetType: 'SAVINGS' as const,
        targetId: savingsId,
        targetPeriodId: pid,
        allocatedAmount: amount,
      })),
      actorId: actor.id,
      idempotencyKey:
        data.idempotencyKey ?? `wallet-savings:${savingsId}:${Date.now()}`,
    })

    revalidateSavings(actor.id, savingsId)
    return {
      success: true,
      data: {
        paymentId: result.payment?.id ?? null,
        paymentNumber: result.payment?.paymentNumber ?? null,
        totalSpent: result.payment ? Number(result.payment.totalConfirmedAmount) : 0,
        breakdown: result.breakdown,
        availableBalanceAfter: Number(result.walletSummaryAfter.availableBalance),
      },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'paySavingsFromWalletAction',
      fallbackMessage: 'Failed to pay savings from wallet',
      context: { userId, savingsId: data?.savingsId },
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

