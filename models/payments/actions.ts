'use server'

import {
  createPaymentSubmission,
  confirmPaymentSubmission,
  rejectPaymentSubmission,
  resubmitPaymentSubmission,
  reversePayment,
  CreatePaymentSubmissionInput,
  ConfirmPaymentSubmissionInput,
  ReversePaymentInput,
} from '@/lib/services/payments.service'
import {
  requestDisbursement,
  approveDisbursement,
  disbursePayment,
  RequestDisbursementInput,
  ApproveDisbursementInput,
  DisbursePaymentInput,
} from '@/lib/services/disbursement.service'
import {
  requireAuthenticatedSession,
  requireStaffSession,
  requirePermission,
} from '@/lib/authz/guards'
import { AdminPermission, UserRole } from '@/generated/prisma/enums'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { revalidatePath } from 'next/cache'

/**
 * Server action to create a payment submission (§2.10, §3.4.1)
 */
export async function createPaymentSubmissionAction(
  input: CreatePaymentSubmissionInput,
) {
  try {
    const actor = await requireAuthenticatedSession()
    // Members can only submit payments for themselves unless staff
    const memberId =
      actor.role === UserRole.USER ? actor.id : input.memberId || actor.id

    const result = await createPaymentSubmission({
      ...input,
      memberId,
    })

    try {
      revalidatePath('/dashboard')
      revalidatePath('/admin/transactions')
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'createPaymentSubmissionAction',
      fallbackMessage: 'Failed to submit payment receipt.',
    })
    return { success: false, error: err.error, code: err.code }
  }
}

/**
 * Server action to confirm a payment submission (§2.10, §2.12)
 */
export async function confirmPaymentSubmissionAction(
  input: Omit<ConfirmPaymentSubmissionInput, 'confirmedById'>,
) {
  try {
    const staff = await requirePermission(AdminPermission.TRANSACTIONS_REVIEW)

    const result = await confirmPaymentSubmission({
      ...input,
      confirmedById: staff.id,
      isOwner: staff.role === UserRole.OWNER,
    })

    try {
      revalidatePath('/admin/transactions')
      revalidatePath('/dashboard')
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'confirmPaymentSubmissionAction',
      fallbackMessage: 'Failed to confirm payment submission.',
    })
    return { success: false, error: err.error, code: err.code }
  }
}

/**
 * Server action to reject a payment submission (§2.10)
 */
export async function rejectPaymentSubmissionAction(params: {
  submissionId: string
  rejectionReason: string
}) {
  try {
    const staff = await requirePermission(AdminPermission.TRANSACTIONS_REVIEW)

    const result = await rejectPaymentSubmission({
      submissionId: params.submissionId,
      reviewerId: staff.id,
      rejectionReason: params.rejectionReason,
    })

    try {
      revalidatePath('/admin/transactions')
      revalidatePath('/dashboard')
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'rejectPaymentSubmissionAction',
      fallbackMessage: 'Failed to reject payment submission.',
    })
    return { success: false, error: err.error, code: err.code }
  }
}

/**
 * Server action to resubmit a rejected payment submission
 */
export async function resubmitPaymentSubmissionAction(params: {
  rejectedSubmissionId: string
  input: Omit<CreatePaymentSubmissionInput, 'memberId'>
}) {
  try {
    await requireAuthenticatedSession()

    const result = await resubmitPaymentSubmission(
      params.rejectedSubmissionId,
      params.input,
    )

    try {
      revalidatePath('/dashboard')
      revalidatePath('/admin/transactions')
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'resubmitPaymentSubmissionAction',
      fallbackMessage: 'Failed to resubmit payment receipt.',
    })
    return { success: false, error: err.error, code: err.code }
  }
}

/**
 * Server action to reverse a confirmed payment (§2.10)
 */
export async function reversePaymentAction(input: {
  paymentId: string
  reversalReason: string
}) {
  try {
    const staff = await requirePermission(AdminPermission.PAYMENTS_REVERSE)

    const result = await reversePayment({
      paymentId: input.paymentId,
      reversedById: staff.id,
      reversalReason: input.reversalReason,
      isOwner: staff.role === UserRole.OWNER,
    })

    try {
      revalidatePath('/admin/transactions')
      revalidatePath('/dashboard')
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'reversePaymentAction',
      fallbackMessage: 'Failed to reverse payment.',
    })
    return { success: false, error: err.error, code: err.code }
  }
}

/**
 * Server action to request a disbursement (§3.4.5)
 */
export async function requestDisbursementAction(
  input: Omit<RequestDisbursementInput, 'requestedById'>,
) {
  try {
    const staff = await requireStaffSession()

    const result = await requestDisbursement({
      ...input,
      requestedById: staff.id,
    })

    try {
      revalidatePath('/admin/disbursements')
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'requestDisbursementAction',
      fallbackMessage: 'Failed to request disbursement.',
    })
    return { success: false, error: err.error, code: err.code }
  }
}

/**
 * Server action to approve a disbursement
 */
export async function approveDisbursementAction(disbursementId: string) {
  try {
    const staff = await requirePermission(AdminPermission.LOANS_DISBURSE)

    const result = await approveDisbursement({
      disbursementId,
      approvedById: staff.id,
    })

    try {
      revalidatePath('/admin/disbursements')
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'approveDisbursementAction',
      fallbackMessage: 'Failed to approve disbursement.',
    })
    return { success: false, error: err.error, code: err.code }
  }
}

/**
 * Server action to execute a disbursement
 */
export async function disbursePaymentAction(input: {
  disbursementId: string
  bankReference: string
  valueDate: Date | string
}) {
  try {
    const staff = await requirePermission(AdminPermission.LOANS_DISBURSE)

    const result = await disbursePayment({
      ...input,
      disbursedById: staff.id,
      actorStaff: staff,
    })

    try {
      revalidatePath('/admin/disbursements')
      revalidatePath('/dashboard')
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'disbursePaymentAction',
      fallbackMessage: 'Failed to execute disbursement.',
    })
    return { success: false, error: err.error, code: err.code }
  }
}
