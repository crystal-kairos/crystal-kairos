'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import {
  AdminPermission,
  AllocationTargetType,
  EAjoDuration,
  EAjoFrequency,
  EAjoStatus,
  PenaltyCapType,
  UserRole,
} from '@/generated/prisma/enums'
import { assertTargetUserIsMember, requirePermission } from '@/lib/authz/guards'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { AppError } from '@/lib/errors/app-error'
import { createEAjoSlotPolicies } from '@/lib/services/rate-policy.service'
import { AuditAction, AuditOutcome, recordAuditEvent } from '@/lib/services/audit.service'
import {
  activateEAjoGroup,
  approveEAjoParticipant,
  approveEAjoPayout,
  cancelEAjoParticipant,
  holdEAjoPayout,
  joinEAjoGroup,
  recordEAjoPayoutPaid,
  rejectEAjoParticipant,
  releaseEAjoPayoutHold,
} from '@/lib/services/eajo.service'
import { confirmPaymentSubmission, rejectPaymentSubmission } from '@/lib/services/payments.service'
import { runPayoutEligibilityJob } from '@/lib/jobs/payout-eligibility.job'

/*
 * Admin e-ajo actions (PR P3-05). Every action enforces its own permission; ids, amounts and
 * statuses from the browser are re-validated by lib/services/eajo.service.ts inside a transaction.
 */

const durationToSlots: Record<EAjoDuration, number> = {
  [EAjoDuration.FOUR_MONTHS]: 4,
  [EAjoDuration.SIX_MONTHS]: 6,
  [EAjoDuration.TWELVE_MONTHS]: 12,
}

export interface CreateEAjoSlotPolicyInput {
  slotNumber: number
  earlySlotPenaltyPercent: number
}

function revalidateEAjo(groupId?: string, userId?: string) {
  try {
    revalidatePath('/admin/eajo')
    if (groupId) revalidatePath(`/admin/eajo/${groupId}`)
    if (userId) revalidatePath(`/dashboard/${userId}/eajo`)
  } catch {
    // outside a Next.js request (tests)
  }
}

const createGroupSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(120),
  description: z.string().trim().max(1000).optional(),
  contributionAmount: z.number().positive('Contribution must be greater than 0').max(100_000_000),
  frequency: z.enum(EAjoFrequency),
  duration: z.enum(EAjoDuration),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  latePenaltyDailyPercent: z.number().min(0).max(100),
  penaltyCapType: z.enum(PenaltyCapType),
  penaltyCapValue: z.number().positive('Penalty cap must be greater than 0'),
  maxMembersPerSlot: z.number().int().min(1).optional().nullable(),
  minParticipants: z.number().int().min(1).optional().nullable(),
  slotPolicies: z.array(
    z.object({
      slotNumber: z.number().int().min(1),
      earlySlotPenaltyPercent: z.number().min(0).max(100),
    }),
  ),
})

/**
 * Admin creates an e-ajo group (§1.5, §2.8). An early-slot penalty is required for every slot
 * (0 allowed, never defaulted); the late penalty and cap are required.
 */
export const createEAjoGroupAction = async (formData: {
  title: string
  description?: string
  contributionAmount: number
  frequency: EAjoFrequency
  duration: EAjoDuration
  startDate?: string
  latePenaltyDailyPercent?: number
  penaltyCapType?: PenaltyCapType
  penaltyCapValue?: number
  maxMembersPerSlot?: number | null
  minParticipants?: number | null
  slotPolicies?: CreateEAjoSlotPolicyInput[]
}) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_MANAGE)

    if (formData.frequency !== EAjoFrequency.MONTHLY) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Contribution frequency is fixed to MONTHLY in this build (ASSUMPTION A-09). Other frequencies are not supported.',
        { statusCode: 422 },
      )
    }
    const totalSlots = durationToSlots[formData.duration]
    if (!totalSlots) throw new AppError('VALIDATION_ERROR', 'Duration must be 4, 6 or 12 months.', { statusCode: 422 })

    const slotNumbers = new Set((formData.slotPolicies ?? []).map((p) => p.slotNumber))
    const complete =
      formData.slotPolicies?.length === totalSlots &&
      Array.from({ length: totalSlots }, (_, i) => i + 1).every((s) => slotNumbers.has(s))
    if (!complete) {
      throw new AppError(
        'VALIDATION_ERROR',
        `A slot policy is mandatory for EVERY slot 1..${totalSlots} at group creation (received ${formData.slotPolicies?.length ?? 0}) (§2.8, A-09).`,
        { statusCode: 422 },
      )
    }

    const parsed = createGroupSchema.safeParse(formData)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid group details.', {
        statusCode: 422,
        fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
      })
    }
    const input = parsed.data

    const group = await prisma.$transaction(async (tx) => {
      const createdGroup = await tx.eAjoGroup.create({
        data: {
          title: input.title,
          description: input.description || null,
          contributionAmount: input.contributionAmount,
          frequency: input.frequency,
          duration: input.duration,
          durationMonths: totalSlots,
          contributionFrequency: 'MONTHLY',
          latePenaltyDailyPercent: input.latePenaltyDailyPercent,
          penaltyCapType: input.penaltyCapType,
          penaltyCapValue: input.penaltyCapValue,
          maxMembersPerSlot: input.maxMembersPerSlot ?? null,
          minParticipants: input.minParticipants ?? null,
          totalSlots,
          filledSlots: 0,
          status: EAjoStatus.PENDING,
          startDate: input.startDate ? new Date(`${input.startDate}T00:00:00.000Z`) : null,
          createdBy: actor.id,
        },
      })

      await createEAjoSlotPolicies(tx, {
        groupId: createdGroup.id,
        totalSlots,
        slotPolicies: input.slotPolicies,
        createdById: actor.id,
      })

      await recordAuditEvent(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: AuditAction.EAJO_GROUP_CREATED,
          entityType: 'EAjoGroup',
          entityId: createdGroup.id,
          outcome: AuditOutcome.SUCCESS,
          metadata: {
            totalSlots,
            contributionAmount: input.contributionAmount,
            latePenaltyDailyPercent: input.latePenaltyDailyPercent,
            penaltyCapType: input.penaltyCapType,
            penaltyCapValue: input.penaltyCapValue,
            maxMembersPerSlot: input.maxMembersPerSlot ?? null,
            slotPenalties: input.slotPolicies
              .slice()
              .sort((a, b) => a.slotNumber - b.slotNumber)
              .map((p) => p.earlySlotPenaltyPercent),
          },
        },
        tx,
      )
      return createdGroup
    })

    revalidateEAjo()
    return { success: true, data: { ...group, contributionAmount: Number(group.contributionAmount) } }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'createEAjoGroupAction',
      fallbackMessage: 'Failed to create e-ajo group.',
    })
    return { success: false, error: err.error, code: err.code, fieldErrors: err.fieldErrors, correlationId: err.correlationId }
  }
}

/**
 * Admin edits a PENDING group's descriptive fields. Amounts, duration and penalties cannot change
 * once anyone has applied, because guarantors consented to those figures.
 */
export const updateEAjoGroupAction = async (
  groupId: string,
  formData: {
    title?: string
    description?: string
    contributionAmount?: number
    startDate?: string | null
    maxMembersPerSlot?: number | null
    minParticipants?: number | null
  },
) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_MANAGE)
    const updated = await prisma.$transaction(async (tx) => {
      const group = await tx.eAjoGroup.findUnique({ where: { id: groupId }, include: { _count: { select: { members: true } } } })
      if (!group) throw new AppError('NOT_FOUND', 'Group not found.', { statusCode: 404 })
      if (group.status !== EAjoStatus.PENDING) {
        throw new AppError('ROSTER_LOCKED', 'Only PENDING groups can be edited.', { statusCode: 409 })
      }
      if (formData.contributionAmount !== undefined && group._count.members > 0) {
        throw new AppError(
          'TERMS_LOCKED',
          'The contribution amount cannot change after members have applied.',
          { statusCode: 409 },
        )
      }
      if (formData.contributionAmount !== undefined && !(formData.contributionAmount > 0)) {
        throw new AppError('VALIDATION_ERROR', 'Contribution must be greater than 0.', { statusCode: 422 })
      }
      const result = await tx.eAjoGroup.update({
        where: { id: groupId },
        data: {
          ...(formData.title?.trim() && { title: formData.title.trim() }),
          ...(formData.description !== undefined && { description: formData.description }),
          ...(formData.contributionAmount !== undefined && { contributionAmount: formData.contributionAmount }),
          ...(formData.startDate !== undefined && {
            startDate: formData.startDate ? new Date(`${formData.startDate.slice(0, 10)}T00:00:00.000Z`) : null,
          }),
          ...(formData.maxMembersPerSlot !== undefined && { maxMembersPerSlot: formData.maxMembersPerSlot }),
          ...(formData.minParticipants !== undefined && { minParticipants: formData.minParticipants }),
        },
      })
      await recordAuditEvent(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: AuditAction.EAJO_GROUP_UPDATED,
          entityType: 'EAjoGroup',
          entityId: groupId,
          outcome: AuditOutcome.SUCCESS,
          metadata: { fields: Object.keys(formData) },
        },
        tx,
      )
      return result
    })
    revalidateEAjo(groupId)
    return { success: true, data: { ...updated, contributionAmount: Number(updated.contributionAmount) } }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'updateEAjoGroupAction',
      fallbackMessage: 'Failed to update e-ajo group.',
      context: { groupId },
    })
    return { success: false, error: err.error, code: err.code, fieldErrors: err.fieldErrors, correlationId: err.correlationId }
  }
}

/** Activates a group: locks roster and amounts, creates periods and payout records (§2.8 rule 3). */
export const activateEAjoGroupAction = async (groupId: string, startDate?: string | null) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_MANAGE)
    const group = await prisma.$transaction((tx) => activateEAjoGroup(tx, { groupId, actor, startDate }))
    revalidateEAjo(groupId)
    return { success: true, data: { id: group.id, status: group.status } }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'activateEAjoGroupAction',
      fallbackMessage: 'Failed to activate e-ajo group.',
      context: { groupId },
    })
    return { success: false, error: err.error, code: err.code, fieldErrors: err.fieldErrors, correlationId: err.correlationId }
  }
}

/** Approves a pending application once the guarantor has consented (§2.7). */
export const approveEAjoMemberAction = async (eajoMemberId: string) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_MANAGE)
    const updated = await prisma.$transaction((tx) => approveEAjoParticipant(tx, { eajoMemberId, actor }))
    revalidateEAjo(updated.groupId, updated.userId)
    return { success: true, data: { id: updated.id, status: updated.status } }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'approveEAjoMemberAction',
      fallbackMessage: 'Failed to approve application.',
      context: { eajoMemberId },
    })
    return { success: false, error: err.error, code: err.code, fieldErrors: err.fieldErrors, correlationId: err.correlationId }
  }
}

export const rejectEAjoMemberAction = async (eajoMemberId: string, rejectionReason: string) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_MANAGE)
    const updated = await prisma.$transaction((tx) =>
      rejectEAjoParticipant(tx, { eajoMemberId, actor, reason: rejectionReason }),
    )
    revalidateEAjo(updated.groupId, updated.userId)
    return { success: true, data: { id: updated.id, status: updated.status } }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'rejectEAjoMemberAction',
      fallbackMessage: 'Failed to reject application.',
      context: { eajoMemberId },
    })
    return { success: false, error: err.error, code: err.code, fieldErrors: err.fieldErrors, correlationId: err.correlationId }
  }
}

/** Cancels a participant before payout; contributions go to the wallet (§2.8 rule 7). */
export const cancelEAjoParticipantAction = async (
  eajoMemberId: string,
  reason: string,
  options: { deductPenalties?: boolean } = {},
) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_MANAGE)
    const result = await prisma.$transaction((tx) =>
      cancelEAjoParticipant(tx, { eajoMemberId, actor, reason, deductPenalties: options.deductPenalties === true }),
    )
    const m = await prisma.eAjoMember.findUnique({ where: { id: eajoMemberId }, select: { groupId: true, userId: true } })
    revalidateEAjo(m?.groupId, m?.userId)
    return {
      success: true,
      data: {
        refundedToWallet: result.refundedToWallet.toFixed(2),
        penaltiesDeducted: result.penaltiesDeducted.toFixed(2),
      },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'cancelEAjoParticipantAction',
      fallbackMessage: 'Failed to cancel participant.',
      context: { eajoMemberId },
    })
    return { success: false, error: err.error, code: err.code, fieldErrors: err.fieldErrors, correlationId: err.correlationId }
  }
}

/**
 * Staff add a member's application on their behalf. It goes through exactly the same rules as a
 * member's own application (slot capacity, guarantor consent, approval, roster lock) — no
 * directly-active participants and no ad-hoc confirmed contributions (P3-05).
 */
export const addMemberToEAjoGroupAction = async (data: {
  userId: string
  groupId: string
  payoutPosition: number
  guarantorId?: string
}) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_MANAGE)
    await assertTargetUserIsMember(data.userId)
    if (!data.guarantorId) {
      throw new AppError('GUARANTOR_REQUIRED', 'Choose a guarantor who is an active member.', {
        statusCode: 422,
        fieldErrors: { guarantorId: ['Required'] },
      })
    }
    const res = await prisma.$transaction((tx) =>
      joinEAjoGroup(tx, {
        memberId: data.userId,
        groupId: data.groupId,
        slotNumber: data.payoutPosition,
        guarantorId: data.guarantorId!,
        actor,
      }),
    )
    revalidateEAjo(data.groupId, data.userId)
    return { success: true, data: { id: res.participant.id, status: res.participant.status } }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'addMemberToEAjoGroupAction',
      fallbackMessage: 'Failed to add member to e-ajo group.',
      context: { userId: data.userId, groupId: data.groupId },
    })
    return { success: false, error: err.error, code: err.code, fieldErrors: err.fieldErrors, correlationId: err.correlationId }
  }
}

// ---------------------------------------------------------------------------
// Payouts (EAJO_PAYOUTS_MANAGE)
// ---------------------------------------------------------------------------

async function groupAndUserForPayout(payoutId: string) {
  const p = await prisma.eAjoPayout.findUnique({
    where: { id: payoutId },
    select: { eajoMember: { select: { groupId: true, userId: true } } },
  })
  return p?.eajoMember
}

export const approveEAjoPayoutAction = async (payoutId: string) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_PAYOUTS_MANAGE)
    const res = await prisma.$transaction((tx) => approveEAjoPayout(tx, { payoutId, actor }))
    const m = await groupAndUserForPayout(payoutId)
    revalidateEAjo(m?.groupId, m?.userId)
    return { success: true, data: { disbursementNumber: res.disbursement.disbursementNumber } }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'approveEAjoPayoutAction',
      fallbackMessage: 'Failed to approve payout.',
      context: { payoutId },
    })
    return { success: false, error: err.error, code: err.code, fieldErrors: err.fieldErrors, correlationId: err.correlationId }
  }
}

/** Records the offline payout under dual control (A-19). */
export const recordEAjoPayoutPaidAction = async (input: {
  payoutId: string
  valueDate: string
  bankReference: string
  evidenceFileId: string
}) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_PAYOUTS_MANAGE)
    const res = await prisma.$transaction((tx) =>
      recordEAjoPayoutPaid(tx, {
        payoutId: input.payoutId,
        actor,
        valueDate: input.valueDate,
        bankReference: input.bankReference,
        evidenceFileId: input.evidenceFileId,
      }),
    )
    const m = await groupAndUserForPayout(input.payoutId)
    revalidateEAjo(m?.groupId, m?.userId)
    return { success: true, data: { singleOperator: res.singleOperator } }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'recordEAjoPayoutPaidAction',
      fallbackMessage: 'Failed to record payout.',
      context: { payoutId: input.payoutId },
    })
    return { success: false, error: err.error, code: err.code, fieldErrors: err.fieldErrors, correlationId: err.correlationId }
  }
}

export const holdEAjoPayoutAction = async (payoutId: string, reason: string) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_PAYOUTS_MANAGE)
    await prisma.$transaction((tx) => holdEAjoPayout(tx, { payoutId, actor, reason }))
    const m = await groupAndUserForPayout(payoutId)
    revalidateEAjo(m?.groupId, m?.userId)
    return { success: true }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'holdEAjoPayoutAction',
      fallbackMessage: 'Failed to hold payout.',
      context: { payoutId },
    })
    return { success: false, error: err.error, code: err.code, fieldErrors: err.fieldErrors, correlationId: err.correlationId }
  }
}

export const releaseEAjoPayoutHoldAction = async (payoutId: string) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_PAYOUTS_MANAGE)
    await prisma.$transaction((tx) => releaseEAjoPayoutHold(tx, { payoutId, actor }))
    const m = await groupAndUserForPayout(payoutId)
    revalidateEAjo(m?.groupId, m?.userId)
    return { success: true }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'releaseEAjoPayoutHoldAction',
      fallbackMessage: 'Failed to release payout hold.',
      context: { payoutId },
    })
    return { success: false, error: err.error, code: err.code, fieldErrors: err.fieldErrors, correlationId: err.correlationId }
  }
}

/** Re-runs the payout-eligibility job for one group (the scheduler arrives in P4-04). */
export const refreshEAjoGroupEligibilityAction = async (groupId: string) => {
  try {
    await requirePermission(AdminPermission.EAJO_PAYOUTS_MANAGE)
    const res = await runPayoutEligibilityJob({ groupId })
    revalidateEAjo(groupId)
    return { success: true, data: res }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'refreshEAjoGroupEligibilityAction',
      fallbackMessage: 'Failed to refresh payout eligibility.',
      context: { groupId },
    })
    return { success: false, error: err.error, code: err.code, fieldErrors: err.fieldErrors, correlationId: err.correlationId }
  }
}

// ---------------------------------------------------------------------------
// Contribution receipts (EAJO_PAYMENTS_REVIEW) — the unified queue arrives in P3-07
// ---------------------------------------------------------------------------

async function assertEAjoSubmission(submissionId: string, groupId: string) {
  const sub = await prisma.paymentSubmission.findUnique({
    where: { id: submissionId },
    include: { targets: true },
  })
  if (!sub) throw new AppError('NOT_FOUND', 'Payment submission not found.', { statusCode: 404 })
  const eajoTargets = sub.targets.filter((t) => t.targetType === AllocationTargetType.EAJO)
  if (eajoTargets.length === 0 || eajoTargets.length !== sub.targets.length) {
    throw new AppError('FORBIDDEN', 'This submission is not an e-ajo contribution.', { statusCode: 403 })
  }
  const participants = await prisma.eAjoMember.findMany({
    where: { id: { in: eajoTargets.map((t) => t.targetId) } },
    select: { groupId: true },
  })
  if (participants.length === 0 || participants.some((p) => p.groupId !== groupId)) {
    throw new AppError('FORBIDDEN', 'This submission does not belong to this group.', { statusCode: 403 })
  }
  return sub
}

export const confirmEAjoContributionAction = async (input: {
  groupId: string
  submissionId: string
  valueDate?: string
  valueDateChangeReason?: string
}) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_PAYMENTS_REVIEW)
    const sub = await assertEAjoSubmission(input.submissionId, input.groupId)
    await confirmPaymentSubmission({
      submissionId: input.submissionId,
      confirmedById: actor.id,
      valueDate: input.valueDate || undefined,
      valueDateChangeReason: input.valueDateChangeReason || undefined,
      isOwner: actor.role === UserRole.OWNER,
    })
    revalidateEAjo(input.groupId, sub.memberId)
    return { success: true }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'confirmEAjoContributionAction',
      fallbackMessage: 'Failed to confirm contribution.',
      context: { submissionId: input.submissionId },
    })
    return { success: false, error: err.error, code: err.code, fieldErrors: err.fieldErrors, correlationId: err.correlationId }
  }
}

export const rejectEAjoContributionAction = async (input: {
  groupId: string
  submissionId: string
  reason: string
}) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_PAYMENTS_REVIEW)
    const sub = await assertEAjoSubmission(input.submissionId, input.groupId)
    await rejectPaymentSubmission({ submissionId: input.submissionId, reviewerId: actor.id, rejectionReason: input.reason })
    revalidateEAjo(input.groupId, sub.memberId)
    return { success: true }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'rejectEAjoContributionAction',
      fallbackMessage: 'Failed to reject contribution.',
      context: { submissionId: input.submissionId },
    })
    return { success: false, error: err.error, code: err.code, fieldErrors: err.fieldErrors, correlationId: err.correlationId }
  }
}
