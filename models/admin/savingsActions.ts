'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import {
  AdminPermission,
  AllocationTargetType,
  SavingsFrequency,
  SavingsType,
  UserRole,
} from '@/generated/prisma/enums'
import { prisma } from '@/lib/prisma'
import { assertTargetUserIsMember, requirePermission } from '@/lib/authz/guards'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { AppError } from '@/lib/errors/app-error'
import { validateAmount } from '@/lib/validation/money'
import { extractStoredFileIdFromUrl } from '@/lib/storage/cloudinary'
import { setSavingsProductTermRates } from '@/lib/services/rate-policy.service'
import { recordAuditEvent, AuditAction, AuditOutcome } from '@/lib/services/audit.service'
import { confirmPaymentSubmission, rejectPaymentSubmission } from '@/lib/services/payments.service'
import { assertProductEligibility } from '@/lib/services/profile.service'
import {
  approveSavingsWithdrawal,
  cancelSavingsWithdrawal,
  confirmSavingsWithdrawalPayout,
  subscribeToSavingsPlan,
} from '@/lib/services/savings.service'

function revalidateAdminSavings(savingsId?: string, memberId?: string) {
  try {
    revalidatePath('/admin/savings')
    if (savingsId) revalidatePath(`/admin/savings/accounts/${savingsId}`)
    if (memberId) revalidatePath(`/dashboard/${memberId}/savings`)
    if (memberId && savingsId) revalidatePath(`/dashboard/${memberId}/savings/${savingsId}`)
  } catch {
    // Ignored outside a Next.js request
  }
}

// ============================================================================
// Plan (product) management — P2-05 term rates, P3-03 admin plan management
// ============================================================================

const termRateSchema = z.object({
  durationMonths: z.coerce.number().int().min(1).max(12),
  ratePercent: z.coerce.number().min(0, 'Rates cannot be negative.').max(100, 'Rates cannot exceed 100%.'),
  isActive: z.boolean().optional(),
})

const productSchema = z.object({
  type: z.nativeEnum(SavingsType),
  title: z.string().trim().min(2, 'Enter a title.').max(80),
  description: z.string().trim().min(2, 'Enter a description.').max(500),
  badge: z.string().trim().max(30).optional().nullable(),
  icon: z.string().trim().min(1).max(40),
  termRates: z
    .array(termRateSchema)
    .min(1, 'Offer at least one term.')
    .refine((rates) => new Set(rates.map((r) => r.durationMonths)).size === rates.length, {
      message: 'Each term can appear only once.',
    }),
})

export type SavingsTermRateInput = z.input<typeof termRateSchema>
export type CreateSavingsProductPayload = z.input<typeof productSchema>

/** Creates a plan and its per-term rates (1–12 months). Rates create a policy-update draft. */
export const createSavingsProductAction = async (data: CreateSavingsProductPayload) => {
  try {
    const actor = await requirePermission(AdminPermission.SAVINGS_MANAGE)
    const parsed = productSchema.parse(data)
    if (!parsed.termRates.some((r) => r.isActive !== false)) {
      throw new AppError('VALIDATION_ERROR', 'Enable at least one term.', {
        statusCode: 400,
        fieldErrors: { termRates: ['Enable at least one term.'] },
      })
    }

    const product = await prisma.savingsProduct.create({
      data: {
        type: parsed.type,
        title: parsed.title,
        description: parsed.description,
        badge: parsed.badge || null,
        icon: parsed.icon,
        createdBy: actor.id,
      },
    })
    await setSavingsProductTermRates(actor.id, product.id, parsed.termRates)
    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.SAVINGS_PLAN_CREATED,
      entityType: 'SavingsProduct',
      entityId: product.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: { title: product.title, type: product.type, terms: parsed.termRates.length },
    })

    revalidateAdminSavings()
    return { success: true, data: { id: product.id } }
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

export const toggleSavingsProductStatusAction = async (id: string, isActive: boolean) => {
  try {
    const actor = await requirePermission(AdminPermission.SAVINGS_MANAGE)
    const productId = z.string().uuid().parse(id)
    const updated = await prisma.savingsProduct.update({
      where: { id: productId },
      data: { isActive: Boolean(isActive) },
      select: { id: true, isActive: true },
    })
    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.SETTING_CHANGED,
      entityType: 'SavingsProduct',
      entityId: productId,
      outcome: AuditOutcome.SUCCESS,
      afterState: { isActive: updated.isActive },
    })
    revalidateAdminSavings()
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

const updateProductSchema = productSchema.omit({ type: true }).partial()

/**
 * Edits a plan's text, badge, icon and term rates. A rate change creates a new rate version
 * used only by new subscriptions (D-09) and appends to the policy-update draft (P4-07).
 * The plan type cannot change once created.
 */
export const updateSavingsProductAction = async (
  id: string,
  data: z.input<typeof updateProductSchema>,
) => {
  try {
    const actor = await requirePermission(AdminPermission.SAVINGS_MANAGE)
    const productId = z.string().uuid().parse(id)
    const parsed = updateProductSchema.parse(data)
    const { termRates, ...fields } = parsed

    const updated = await prisma.savingsProduct.update({
      where: { id: productId },
      data: {
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.description !== undefined ? { description: fields.description } : {}),
        ...(fields.icon !== undefined ? { icon: fields.icon } : {}),
        ...(fields.badge !== undefined ? { badge: fields.badge || null } : {}),
      },
      select: { id: true },
    })
    if (termRates && termRates.length > 0) {
      await setSavingsProductTermRates(actor.id, productId, termRates)
    }
    revalidateAdminSavings()
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

/**
 * Staff subscribes a member to a plan (same rules as the member flow: PENDING, no schedule,
 * snapshot rate). Staff cannot record deposits here; the member uploads the receipt (P3-07).
 */
export const createSavingsForMemberAction = async (data: {
  userId: string
  productId: string
  durationMonths: number
  targetAmount?: number | string | null
  frequency?: SavingsFrequency | null
}) => {
  try {
    const actor = await requirePermission(AdminPermission.SAVINGS_MANAGE)
    // D-15 first: staff can never hold savings, whatever else is wrong with the request.
    await assertTargetUserIsMember(z.string().min(1).parse(data?.userId))
    const parsed = z
      .object({
        userId: z.string().min(1),
        productId: z.string().uuid(),
        durationMonths: z.coerce.number().int().min(1).max(12),
        targetAmount: z.union([z.number(), z.string()]).optional().nullable(),
        frequency: z.nativeEnum(SavingsFrequency).optional().nullable(),
      })
      .parse(data)
    await assertProductEligibility(parsed.userId, 'SAVINGS')

    const savings = await subscribeToSavingsPlan({
      memberId: parsed.userId,
      productId: parsed.productId,
      durationMonths: parsed.durationMonths,
      targetAmount:
        parsed.targetAmount === undefined || parsed.targetAmount === null || parsed.targetAmount === ''
          ? null
          : validateAmount(parsed.targetAmount, 'targetAmount'),
      frequency: parsed.frequency ?? null,
    })
    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      affectedUserId: parsed.userId,
      action: AuditAction.SAVINGS_PLAN_CREATED,
      entityType: 'Savings',
      entityId: savings.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: { onBehalfOfMember: true },
    })
    revalidateAdminSavings(savings.id, parsed.userId)
    return { success: true, data: { id: savings.id } }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'createSavingsForMemberAction',
      fallbackMessage: 'Failed to create savings plan.',
      context: { userId: data?.userId, productId: data?.productId },
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

// ============================================================================
// Savings receipt review (until the unified queue of P3-07)
// ============================================================================

async function loadSavingsSubmission(submissionId: string) {
  const submission = await prisma.paymentSubmission.findUnique({
    where: { id: submissionId },
    include: { targets: true },
  })
  if (!submission) throw new AppError('NOT_FOUND', 'Receipt not found.', { statusCode: 404 })
  const isSavingsOnly =
    submission.targets.length > 0 &&
    submission.targets.every((t) => t.targetType === AllocationTargetType.SAVINGS)
  if (!isSavingsOnly) {
    throw new AppError('FORBIDDEN', 'This receipt is not a savings deposit.', { statusCode: 403 })
  }
  return submission
}

const confirmSchema = z.object({
  submissionId: z.string().uuid(),
  confirmedAmount: z.union([z.number(), z.string()]).optional(),
  valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  valueDateChangeReason: z.string().trim().max(300).optional(),
})

/**
 * Confirms a savings receipt. The value date (when the money reached the cooperative,
 * default = the member's paid-on date) — not today — sets the start, maturity and lateness.
 */
export const confirmSavingsSubmissionAction = async (input: z.input<typeof confirmSchema>) => {
  try {
    const staff = await requirePermission(AdminPermission.SAVINGS_PAYMENTS_REVIEW)
    const parsed = confirmSchema.parse(input)
    const submission = await loadSavingsSubmission(parsed.submissionId)
    const result = await confirmPaymentSubmission({
      submissionId: submission.id,
      confirmedById: staff.id,
      confirmedAmount:
        parsed.confirmedAmount !== undefined && parsed.confirmedAmount !== ''
          ? validateAmount(parsed.confirmedAmount, 'confirmedAmount')
          : undefined,
      valueDate: parsed.valueDate,
      valueDateChangeReason: parsed.valueDateChangeReason || undefined,
      isOwner: staff.role === UserRole.OWNER,
    })
    const savingsId = submission.targets[0]?.targetId
    revalidateAdminSavings(savingsId, submission.memberId)
    return { success: true, data: { paymentId: result.payment.id } }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'confirmSavingsSubmissionAction',
      fallbackMessage: 'Failed to confirm the receipt.',
      context: { submissionId: input?.submissionId },
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

/** Rejects a savings receipt with a reason; the member can re-upload (a new submission). */
export const rejectSavingsSubmissionAction = async (submissionId: string, rejectionReason: string) => {
  try {
    const staff = await requirePermission(AdminPermission.SAVINGS_PAYMENTS_REVIEW)
    const parsed = z
      .object({ submissionId: z.string().uuid(), rejectionReason: z.string().trim().min(3, 'Give a reason.').max(300) })
      .parse({ submissionId, rejectionReason })
    const submission = await loadSavingsSubmission(parsed.submissionId)
    await rejectPaymentSubmission({
      submissionId: submission.id,
      reviewerId: staff.id,
      rejectionReason: parsed.rejectionReason,
    })
    revalidateAdminSavings(submission.targets[0]?.targetId, submission.memberId)
    return { success: true }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'rejectSavingsSubmissionAction',
      fallbackMessage: 'Failed to reject the receipt.',
      context: { submissionId },
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

// ============================================================================
// Withdrawal payouts
// ============================================================================

export const approveSavingsWithdrawalAction = async (savingsId: string) => {
  try {
    const staff = await requirePermission(AdminPermission.SAVINGS_PAYOUTS_MANAGE)
    const id = z.string().uuid().parse(savingsId)
    const result = await approveSavingsWithdrawal({ savingsId: id, staff })
    revalidateAdminSavings(id)
    return { success: true, data: result }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'approveSavingsWithdrawalAction',
      fallbackMessage: 'Failed to approve the withdrawal.',
      context: { savingsId },
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

const payoutSchema = z.object({
  savingsId: z.string().uuid(),
  valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the payout date.'),
  bankReference: z.string().trim().min(3, 'Enter the bank transfer reference.').max(100),
  evidenceUrl: z.string().min(1, 'Upload the payout evidence.'),
})

/** Confirms the payout (evidence, value date, bank reference). Dual control vs the approver (A-19). Permission: SAVINGS_PAYOUTS_MANAGE (OQ-11). */
export const confirmSavingsWithdrawalPayoutAction = async (input: z.input<typeof payoutSchema>) => {
  try {
    const staff = await requirePermission(AdminPermission.SAVINGS_PAYOUTS_MANAGE)
    const parsed = payoutSchema.parse(input)
    const evidenceFileId = extractStoredFileIdFromUrl(parsed.evidenceUrl)
    if (!evidenceFileId) {
      throw new AppError('EVIDENCE_REQUIRED', 'Upload the payout evidence.', {
        statusCode: 400,
        fieldErrors: { evidenceUrl: ['Upload the payout evidence.'] },
      })
    }
    const result = await confirmSavingsWithdrawalPayout({
      savingsId: parsed.savingsId,
      staff,
      valueDate: parsed.valueDate,
      bankReference: parsed.bankReference,
      evidenceFileId,
    })
    revalidateAdminSavings(parsed.savingsId)
    return { success: true, data: result }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'confirmSavingsWithdrawalPayoutAction',
      fallbackMessage: 'Failed to confirm the payout.',
      context: { savingsId: input?.savingsId },
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

/** Rejects/cancels a pending withdrawal; the plan returns to ACTIVE or MATURED. */
export const rejectSavingsWithdrawalAction = async (savingsId: string, reason: string) => {
  try {
    const staff = await requirePermission(AdminPermission.SAVINGS_PAYOUTS_MANAGE)
    const parsed = z
      .object({ savingsId: z.string().uuid(), reason: z.string().trim().min(3, 'Give a reason.').max(300) })
      .parse({ savingsId, reason })
    const result = await cancelSavingsWithdrawal({
      savingsId: parsed.savingsId,
      actorId: staff.id,
      actorRole: staff.role,
      reason: parsed.reason,
    })
    revalidateAdminSavings(parsed.savingsId)
    return { success: true, data: result }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'rejectSavingsWithdrawalAction',
      fallbackMessage: 'Failed to reject the withdrawal.',
      context: { savingsId },
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
