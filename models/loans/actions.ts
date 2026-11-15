'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import {
  AllocationTargetType,
  FeeType,
  LoanStatus,
  SubmissionPurpose,
  UserRole,
} from '@/generated/prisma/enums'
import {
  requireAuthenticatedSession,
  requireMemberSession,
} from '@/lib/authz/guards'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { AppError } from '@/lib/errors/app-error'
import { validateAmount } from '@/lib/validation/money'
import {
  decideGuarantorRequest,
  withdrawGuarantorConsent,
} from '@/lib/services/guarantees.service'
import { recordAuditEvent, AuditAction, AuditOutcome } from '@/lib/services/audit.service'
import { assertProductEligibility } from '@/lib/services/profile.service'
import {
  applyForLoan,
  cancelLoanApplication,
  getFeeOutstanding,
  getLoanSettlementQuote,
  payLoanFeeFromWallet,
  payLoanFromWallet,
  quoteNewLoan,
  refreshLoanAfterPayment,
  respondToLoanOffer,
  syncLoanWithGuarantee,
} from '@/lib/services/loans.service'
import { getLoanEligibilitySummary } from '@/lib/services/loan-capacity.service'
import { getActiveLoanTermRates } from '@/lib/services/rate-policy.service'
import { createPaymentSubmission } from '@/lib/services/payments.service'
import { LOAN_REPAYABLE_STATUSES } from '@/lib/domain/loan-workflow'
import { lagosToday } from '@/lib/domain/dates'
import {
  serializeLoan,
  serializeLoanQuote,
  serializeSettlementQuote,
} from '@/lib/loans'

function revalidateLoanPaths(memberId: string, loanId?: string) {
  try {
    revalidatePath(`/dashboard/${memberId}/loans`)
    if (loanId) revalidatePath(`/dashboard/${memberId}/loans/${loanId}`)
    revalidatePath(`/dashboard/${memberId}`)
    revalidatePath('/admin/loans')
    if (loanId) revalidatePath(`/admin/loans/${loanId}`)
  } catch {
    // Ignored outside a Next.js request
  }
}

/** Finds an active member by email for the guarantor field. Staff are never guarantors (D-15). */
async function findMemberByEmail(email: string) {
  const member = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: {
      id: true,
      name: true,
      role: true,
      isActive: true,
      userInfo: { select: { phoneNumber: true } },
    },
  })
  if (!member || member.role !== UserRole.USER || member.isActive === false) return null
  return member
}

/**
 * Searches for an active cooperative member by email to nominate as a guarantor.
 * Staff accounts (OWNER / ADMIN) are never eligible to be members or guarantors (D-15).
 */
export const searchMemberByEmailAction = async (email: string) => {
  try {
    await requireAuthenticatedSession()
    const member = await findMemberByEmail(String(email ?? ''))
    if (!member) {
      return { success: false, error: 'No cooperative member found with this email.' }
    }
    return {
      success: true,
      member: {
        id: member.id,
        name: member.name,
        phoneNumber: member.userInfo?.phoneNumber || '',
      },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'searchMemberByEmailAction',
      fallbackMessage: 'An error occurred during search.',
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
 * Data for the application form: active term rates (1–12 months), the fee and
 * the member's borrowing ceiling, optionally with a chosen guarantor (§2.1, §2.9).
 */
export const getLoanApplicationContextAction = async (
  userId: string,
  guarantorEmail?: string,
) => {
  try {
    const actor = await requireMemberSession(userId)
    const guarantor = guarantorEmail ? await findMemberByEmail(guarantorEmail) : null
    if (guarantor && guarantor.id === actor.id) {
      throw new AppError('GUARANTOR_INELIGIBLE', 'You cannot be your own guarantor.')
    }
    const [rates, eligibility] = await Promise.all([
      getActiveLoanTermRates(),
      getLoanEligibilitySummary(actor.id, guarantor?.id ?? null),
    ])
    return {
      success: true,
      data: {
        terms: rates.map((r) => ({
          durationMonths: r.durationMonths,
          monthlyInterestPercent: r.monthlyInterestPercent.toNumber(),
          latePenaltyDailyPercent: r.latePenaltyDailyPercent.toNumber(),
          penaltyCapType: r.penaltyCapType as string,
          penaltyCapValue: r.penaltyCapValue.toNumber(),
        })),
        eligibility: {
          eligibleSavings: eligibility.eligibleSavings.toNumber(),
          standaloneLimit: eligibility.standaloneLimit.toNumber(),
          existingExposure: eligibility.existingExposure.toNumber(),
          maxWithoutExtraSupport: eligibility.maxWithoutExtraSupport.toNumber(),
          maxWithGuarantor: eligibility.maxWithGuarantor?.toNumber() ?? null,
          guarantorFreeCapacity: eligibility.guarantorFreeCapacity?.toNumber() ?? null,
        },
        guarantor: guarantor ? { id: guarantor.id, name: guarantor.name } : null,
      },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'getLoanApplicationContextAction',
      fallbackMessage: 'Unable to load loan options.',
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

/** Total-cost disclosure before submission (§2.9). */
export const getLoanQuoteAction = async (
  userId: string,
  input: { requestedAmount: number; duration: number },
) => {
  try {
    await requireMemberSession(userId)
    const amount = validateAmount(input.requestedAmount, 'requestedAmount')
    const quote = await quoteNewLoan({ principal: amount, termMonths: Number(input.duration) })
    return { success: true, data: serializeLoanQuote(quote) }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'getLoanQuoteAction',
      fallbackMessage: 'Unable to price this loan.',
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

const applySchema = z.object({
  requestedAmount: z.unknown(),
  duration: z.coerce.number().int().min(1).max(12),
  purpose: z.string().trim().min(3, 'Please describe the purpose of the loan.').max(500),
  guarantorEmail: z.string().trim().email('Enter the guarantor’s email address.'),
})

/**
 * Apply for a loan (P3-04). The rate, penalty terms, cap and rate version are
 * snapshotted from the active admin-configured term rate; a guarantor consent
 * request and, if the fee is above zero, a fee assessment are created.
 */
export const applyForLoanAction = async (
  userId: string,
  data: {
    requestedAmount: number
    duration: number
    purpose: string
    guarantorEmail?: string
  },
) => {
  try {
    const actor = await requireMemberSession(userId)
    await assertProductEligibility(actor.id, 'LOAN')

    const parsed = applySchema.safeParse(data)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid application.', {
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      })
    }
    const amount = validateAmount(parsed.data.requestedAmount, 'requestedAmount')
    const guarantor = await findMemberByEmail(parsed.data.guarantorEmail)
    if (!guarantor) {
      throw new AppError('GUARANTOR_INELIGIBLE', 'No active cooperative member found with the guarantor’s email.')
    }

    const result = await applyForLoan({
      memberId: actor.id,
      requestedAmount: amount,
      termMonths: parsed.data.duration,
      purpose: parsed.data.purpose,
      guarantorId: guarantor.id,
    })

    revalidateLoanPaths(actor.id, result.loan.id)
    return {
      success: true,
      data: {
        ...serializeLoan(result.loan),
        quote: serializeLoanQuote(result.quote),
        feeAssessmentId: result.feeAssessment?.id ?? null,
      },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'applyForLoanAction',
      fallbackMessage: 'Failed to apply for loan.',
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

/** Member withdraws a pending application. */
export const cancelLoanApplicationAction = async (userId: string, loanId: string, reason?: string) => {
  try {
    const actor = await requireMemberSession(userId)
    const loan = await cancelLoanApplication({ loanId: String(loanId), memberId: actor.id, reason })
    revalidateLoanPaths(actor.id, loan.id)
    return { success: true, data: serializeLoan(loan) }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'cancelLoanApplicationAction',
      fallbackMessage: 'Failed to withdraw the application.',
      context: { userId, loanId },
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

export const acceptLoanOfferAction = async (userId: string, loanId: string) => {
  try {
    const actor = await requireMemberSession(userId)
    const res = await respondToLoanOffer({ loanId: String(loanId), memberId: actor.id, decision: 'ACCEPT' })
    revalidateLoanPaths(actor.id, res.loan.id)
    return { success: true, data: serializeLoan(res.loan) }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'acceptLoanOfferAction',
      fallbackMessage: 'Failed to accept loan',
      context: { userId, loanId },
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

export const declineLoanOfferAction = async (userId: string, loanId: string, reason: string) => {
  try {
    const actor = await requireMemberSession(userId)
    const res = await respondToLoanOffer({
      loanId: String(loanId),
      memberId: actor.id,
      decision: 'DECLINE',
      reason: String(reason ?? ''),
    })
    revalidateLoanPaths(actor.id, res.loan?.id)
    return { success: true, data: serializeLoan(res.loan) }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'declineLoanOfferAction',
      fallbackMessage: 'Failed to decline loan',
      context: { userId, loanId },
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

const receiptSchema = z.object({
  loanId: z.string().min(1),
  amount: z.unknown(),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date you paid.'),
  receiptFileId: z.string().min(1, 'Upload the payment receipt.'),
  bankReference: z.string().trim().max(100).optional(),
  instalmentId: z.string().min(1).optional(),
  settle: z.boolean().optional(),
  notes: z.string().trim().max(500).optional(),
})

async function assertOwnReceiptFile(fileId: string, actorId: string) {
  const file = await prisma.storedFile.findUnique({ where: { id: fileId } })
  if (!file || file.uploadedById !== actorId || (file.associatedId && file.associatedType !== 'PAYMENT_SUBMISSION')) {
    throw new AppError('VALIDATION_ERROR', 'Upload the payment receipt again.')
  }
}

/**
 * Submit a loan repayment receipt (P2-07 submission model). A receipt is a
 * claim, not money: only staff confirmation allocates it (penalty → interest →
 * principal, oldest instalment first). `settle` pays the whole loan (early
 * settlement quote, A-23); `instalmentId` pays one instalment.
 */
export const submitLoanRepaymentAction = async (
  userId: string,
  data: {
    loanId: string
    amount: number
    paidOn: string
    receiptFileId: string
    bankReference?: string
    instalmentId?: string
    settle?: boolean
    notes?: string
  },
) => {
  try {
    const actor = await requireMemberSession(userId)
    const parsed = receiptSchema.safeParse(data)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid receipt details.', {
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      })
    }
    const amount = validateAmount(parsed.data.amount)
    const loan = await prisma.loan.findFirst({ where: { id: parsed.data.loanId, userId: actor.id } })
    if (!loan) throw new AppError('NOT_FOUND', 'Loan not found.', { statusCode: 404 })
    if (!LOAN_REPAYABLE_STATUSES.includes(loan.status)) {
      throw new AppError('INVALID_STATE', 'Repayment is only possible on a disbursed, unfinished loan.')
    }
    if (parsed.data.instalmentId) {
      const inst = await prisma.loanInstalment.findFirst({
        where: { id: parsed.data.instalmentId, loanId: loan.id },
        select: { id: true },
      })
      if (!inst) throw new AppError('INVALID_TARGET', 'The instalment does not belong to this loan.')
    }
    await assertOwnReceiptFile(parsed.data.receiptFileId, actor.id)

    const result = await createPaymentSubmission({
      memberId: actor.id,
      claimedAmount: amount,
      paidOn: parsed.data.paidOn,
      purpose: parsed.data.settle ? SubmissionPurpose.LOAN_SETTLEMENT : SubmissionPurpose.LOAN_REPAYMENT,
      bankReference: parsed.data.bankReference || undefined,
      receiptFileId: parsed.data.receiptFileId,
      narration: parsed.data.notes || undefined,
      targets: [
        {
          targetType: AllocationTargetType.LOAN,
          targetId: loan.id,
          targetPeriodId: parsed.data.settle ? undefined : parsed.data.instalmentId,
          requestedAmount: amount,
        },
      ],
    })
    await prisma.storedFile.updateMany({
      where: { id: parsed.data.receiptFileId },
      data: { associatedType: 'PAYMENT_SUBMISSION', associatedId: result.submission.id, ownerUserId: actor.id },
    })
    // Show "payment under review" on the targeted instalments (review shield, §2.10)
    await prisma.$transaction((tx) => refreshLoanAfterPayment(tx, loan.id, { actorId: actor.id }))

    revalidateLoanPaths(actor.id, loan.id)
    return {
      success: true,
      data: {
        submissionId: result.submission.id,
        submissionNumber: result.submission.submissionNumber,
        warnings: result.warnings,
      },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'submitLoanRepaymentAction',
      fallbackMessage: 'Failed to submit loan repayment.',
      context: { userId, loanId: data?.loanId },
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

/** Submit a receipt for the loan application fee (A-14). */
export const submitLoanFeeReceiptAction = async (
  userId: string,
  data: { loanId: string; paidOn: string; receiptFileId: string; bankReference?: string },
) => {
  try {
    const actor = await requireMemberSession(userId)
    const fee = await prisma.feeAssessment.findFirst({
      where: { feeType: FeeType.LOAN_APPLICATION, targetId: String(data?.loanId), memberId: actor.id },
      orderBy: { assessedAt: 'desc' },
    })
    if (!fee) throw new AppError('NOT_FOUND', 'There is no application fee for this loan.', { statusCode: 404 })
    const { outstanding } = await getFeeOutstanding(prisma, fee.id)
    if (outstanding.lte(0)) throw new AppError('INVALID_STATE', 'The application fee is already settled.')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data?.paidOn))) {
      throw new AppError('VALIDATION_ERROR', 'Enter the date you paid.')
    }
    await assertOwnReceiptFile(String(data.receiptFileId), actor.id)

    const result = await createPaymentSubmission({
      memberId: actor.id,
      claimedAmount: outstanding,
      paidOn: data.paidOn,
      purpose: SubmissionPurpose.FEE,
      bankReference: data.bankReference?.trim() || undefined,
      receiptFileId: data.receiptFileId,
      targets: [{ targetType: AllocationTargetType.FEE, targetId: fee.id, requestedAmount: outstanding }],
    })
    await prisma.storedFile.updateMany({
      where: { id: data.receiptFileId },
      data: { associatedType: 'PAYMENT_SUBMISSION', associatedId: result.submission.id, ownerUserId: actor.id },
    })
    revalidateLoanPaths(actor.id, fee.targetId)
    return { success: true, data: { submissionId: result.submission.id } }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'submitLoanFeeReceiptAction',
      fallbackMessage: 'Failed to submit the fee receipt.',
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

/** Pay toward a loan (or settle it) from the member's wallet (§2.11, D-11). */
export const payLoanFromWalletAction = async (
  userId: string,
  data: { loanId: string; amount: number; idempotencyKey: string },
) => {
  try {
    const actor = await requireMemberSession(userId)
    const amount = validateAmount(data?.amount)
    const key = String(data?.idempotencyKey ?? '')
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) {
      throw new AppError('VALIDATION_ERROR', 'Missing request key. Refresh and try again.')
    }
    const res = await payLoanFromWallet({
      memberId: actor.id,
      loanId: String(data.loanId),
      amount,
      idempotencyKey: key,
    })
    revalidateLoanPaths(actor.id, String(data.loanId))
    return {
      success: true,
      data: {
        paymentId: res.payment.id,
        paymentNumber: res.payment.paymentNumber,
        isReplay: res.isReplay,
        loanStatus: 'loan' in res ? res.loan?.status ?? null : null,
      },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'payLoanFromWalletAction',
      fallbackMessage: 'Failed to pay from your wallet.',
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

export const payLoanFeeFromWalletAction = async (userId: string, loanId: string) => {
  try {
    const actor = await requireMemberSession(userId)
    const res = await payLoanFeeFromWallet({ memberId: actor.id, loanId: String(loanId) })
    revalidateLoanPaths(actor.id, String(loanId))
    return { success: true, data: { paymentId: res.payment.id, feeStatus: res.fee.status } }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'payLoanFeeFromWalletAction',
      fallbackMessage: 'Failed to pay the fee from your wallet.',
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

/** Early-settlement quote (A-23): remaining principal + interest + unpaid penalties. */
export const getLoanSettlementQuoteAction = async (userId: string, loanId: string) => {
  try {
    const actor = await requireMemberSession(userId)
    const loan = await prisma.loan.findFirst({
      where: { id: String(loanId), userId: actor.id },
      select: { id: true, status: true },
    })
    if (!loan) throw new AppError('NOT_FOUND', 'Loan not found.', { statusCode: 404 })
    const quote = await getLoanSettlementQuote(loan.id)
    return { success: true, data: { ...serializeSettlementQuote(quote), asOf: lagosToday() } }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'getLoanSettlementQuoteAction',
      fallbackMessage: 'Unable to calculate the settlement amount.',
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
 * Guarantor accepts or declines a guarantee request (§2.7).
 * Strictly authenticates the guarantor member actor and cannot be called by the applicant.
 */
export const decideGuarantorRequestAction = async (params: {
  reservationId: string
  decision: 'ACCEPT' | 'DECLINE'
  reason?: string
}) => {
  try {
    const actor = await requireAuthenticatedSession()
    if (actor.role !== UserRole.USER) {
      throw new AppError('FORBIDDEN', 'Staff accounts cannot act as guarantors.', { statusCode: 403 })
    }
    if (params.decision !== 'ACCEPT' && params.decision !== 'DECLINE') {
      throw new AppError('VALIDATION_ERROR', 'Invalid decision.')
    }

    const result = await prisma.$transaction(async (tx) => {
      const res = await decideGuarantorRequest(tx, {
        reservationId: params.reservationId,
        guarantorId: actor.id,
        decision: params.decision,
        reason: params.reason,
      })

      await recordAuditEvent(
        {
          actorId: actor.id,
          actorRole: actor.role,
          affectedUserId: res.reservation.applicantId,
          action:
            params.decision === 'ACCEPT'
              ? AuditAction.GUARANTEE_CONSENT_GIVEN
              : AuditAction.GUARANTEE_CONSENT_DECLINED,
          entityType: 'GuaranteeReservation',
          entityId: res.reservation.id,
          outcome: AuditOutcome.SUCCESS,
          metadata: {
            reservationId: res.reservation.id,
            loanId: res.reservation.loanId,
            decision: params.decision,
            reason: params.reason,
            termsVersion: res.reservation.termsVersion,
          },
        },
        tx,
      )

      // P3-04: re-consent completes the offer, a declined re-consent ends it
      await syncLoanWithGuarantee(tx, res.reservation.id, actor.id)
      return res
    })

    try {
      revalidatePath(`/dashboard/${actor.id}/guarantees`)
      revalidatePath(`/dashboard/${actor.id}`)
      if (result.reservation.loanId) {
        revalidateLoanPaths(result.reservation.applicantId, result.reservation.loanId)
      }
    } catch {}

    return {
      success: true,
      data: {
        reservationId: result.reservation.id,
        state: result.reservation.state,
        evidenceDocumentId: result.evidence.documentId,
      },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'decideGuarantorRequestAction',
      fallbackMessage: 'Failed to process guarantee decision.',
      context: { reservationId: params.reservationId },
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
 * Guarantor withdraws consent before loan disbursement (§2.7). After approval
 * this cancels the offer: an approval needs a consenting guarantor.
 */
export const withdrawGuarantorConsentAction = async (params: {
  reservationId: string
  reason: string
}) => {
  try {
    const actor = await requireAuthenticatedSession()
    if (actor.role !== UserRole.USER) {
      throw new AppError('FORBIDDEN', 'Staff accounts cannot act as guarantors.', { statusCode: 403 })
    }

    const result = await prisma.$transaction(async (tx) => {
      const res = await withdrawGuarantorConsent(tx, {
        reservationId: params.reservationId,
        guarantorId: actor.id,
        reason: params.reason,
      })
      await syncLoanWithGuarantee(tx, res.id, actor.id)
      return res
    })

    try {
      revalidatePath(`/dashboard/${actor.id}/guarantees`)
      if (result.loanId) revalidateLoanPaths(result.applicantId, result.loanId)
    } catch {}

    return { success: true, data: { reservationId: result.id, state: result.state } }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'withdrawGuarantorConsentAction',
      fallbackMessage: 'Failed to withdraw guarantee consent.',
      context: { reservationId: params.reservationId },
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

/** Loans of the signed-in member that are awaiting their decision (offer). */
export const getMyOpenLoanOffersAction = async (userId: string) => {
  try {
    const actor = await requireMemberSession(userId)
    const loans = await prisma.loan.findMany({
      where: {
        userId: actor.id,
        status: { in: [LoanStatus.APPROVED, LoanStatus.AWAITING_RECONSENT] },
      },
      select: { id: true, status: true, offerExpiresAt: true },
    })
    return { success: true, data: loans }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'getMyOpenLoanOffersAction',
      fallbackMessage: 'Unable to load loan offers.',
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
