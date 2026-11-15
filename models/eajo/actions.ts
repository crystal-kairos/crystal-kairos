'use server'

import { AdminPermission, UserRole } from '@/generated/prisma/enums'
import { revalidatePath } from 'next/cache'
import { uploadReceipt } from '@/lib/upload'
import {
  isStoredFilePurpose,
  StoredFilePurpose,
} from '@/lib/storage/file-validation'
import {
  assertTargetUserIsMember,
  requireAuthenticatedSession,
  requireMemberOrStaffWithPermission,
} from '@/lib/authz/guards'
import { assertProductEligibility } from '@/lib/services/profile.service'
import { validateAmount } from '@/lib/validation/money'
import { toActionErrorResult } from '@/lib/errors/to-action-result'

import { applyEAjoContribution, applyToEAjoGroup } from '@/lib/services/eajo.service'

/**
 * A member applies for a slot in a PENDING group and names a guarantor by email (§2.7, §2.8).
 * Staff with EAJO_MANAGE may apply on a member's behalf; the same rules apply.
 */
export const applyToEAjoGroupAction = async (
  userId: string,
  groupId: string,
  formData: { payoutPosition: number; guarantorEmail?: string },
) => {
  try {
    const actor = await requireMemberOrStaffWithPermission(userId, [AdminPermission.EAJO_MANAGE])
    const targetUserId = actor.role === UserRole.USER ? actor.id : userId

    await assertTargetUserIsMember(targetUserId)
    await assertProductEligibility(targetUserId, 'EAJO')

    const result = await applyToEAjoGroup({
      memberId: targetUserId,
      groupId,
      slotNumber: Number(formData.payoutPosition),
      guarantorEmail: formData.guarantorEmail ?? '',
      actor,
    })

    try {
      revalidatePath(`/dashboard/${targetUserId}/eajo`)
      revalidatePath(`/admin/eajo/${groupId}`)
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'applyToEAjoGroupAction',
      fallbackMessage: 'Failed to apply to group.',
      context: { userId, groupId },
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
 * A member uploads a receipt for one or more of their own contribution periods. This creates a
 * P2-07 payment submission; money is applied only when staff confirm it (§1.2, §2.10).
 */
export const submitEAjoContributionAction = async (
  userId: string,
  eAjoMemberId: string,
  input: {
    amount: number
    paidOn: string
    receiptFileId: string
    periodIds: string[]
    bankReference?: string
    narration?: string
  },
) => {
  try {
    const actor = await requireMemberOrStaffWithPermission(userId, [
      AdminPermission.EAJO_MANAGE,
      AdminPermission.EAJO_PAYMENTS_REVIEW,
    ])
    const targetUserId = actor.role === UserRole.USER ? actor.id : userId
    await assertTargetUserIsMember(targetUserId)

    const amount = validateAmount(input?.amount)
    const result = await applyEAjoContribution({
      memberId: targetUserId,
      eajoMemberId: eAjoMemberId,
      amount: Number(amount),
      paidOn: input.paidOn,
      receiptFileId: input.receiptFileId,
      periodIds: input.periodIds ?? [],
      bankReference: input.bankReference,
      narration: input.narration,
      actorId: actor.id,
    })

    try {
      revalidatePath(`/dashboard/${targetUserId}/eajo`)
    } catch {}

    return {
      success: true,
      data: { submissionNumber: result.submission.submissionNumber, warnings: result.warnings },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'submitEAjoContributionAction',
      fallbackMessage: 'Failed to submit contribution receipt.',
      context: { userId, eAjoMemberId },
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
 * Uploads a receipt or verification file strictly to Cloudinary and returns its controlled access URL.
 * Requires an authenticated session and validates size (<= 5 MB), format, and magic-byte signature.
 */
export const uploadReceiptAction = async (formData: FormData) => {
  try {
    const actor = await requireAuthenticatedSession()

    if (formData.has('folder')) {
      return {
        success: false,
        code: 'VALIDATION_ERROR',
        error: 'Client-specified storage folders are not permitted.',
      }
    }

    const rawPurpose = formData.get('purpose')
    let purpose: StoredFilePurpose = 'receipts'
    if (rawPurpose !== null && rawPurpose !== '') {
      if (!isStoredFilePurpose(rawPurpose)) {
        return {
          success: false,
          code: 'VALIDATION_ERROR',
          error: 'Invalid file storage purpose.',
        }
      }
      purpose = rawPurpose
    }

    const file = formData.get('file') as File | null
    if (!file || typeof file.arrayBuffer !== 'function') {
      return {
        success: false,
        code: 'VALIDATION_ERROR',
        error: 'No file uploaded',
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const uploadResult = await uploadReceipt(buffer, file.name, {
      purpose,
      declaredMimeType: file.type,
      uploadedById: actor.id,
      ownerUserId: actor.id,
    })

    return {
      success: true,
      url: uploadResult.url,
      fileId: uploadResult.fileId,
      publicId: uploadResult.publicId,
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'uploadReceiptAction',
      fallbackMessage: 'Unable to upload receipt file.',
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
