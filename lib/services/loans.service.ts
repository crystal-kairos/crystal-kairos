import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import {
  AdminPermission,
  AllocationStatus,
  AllocationTargetType,
  BorrowerOfferDecision,
  DisbursementPurpose,
  DisbursementStatus,
  FeeStatus,
  FeeType,
  GuaranteeState,
  GuaranteeType,
  LedgerAccountType,
  LoanStatus,
  PaymentComponentType,
  PaymentSource,
  PaymentStatus,
  PaymentSubmissionStatus,
  PenaltyCapType,
  UserRole,
} from '@/generated/prisma/enums'
import { AppError } from '@/lib/errors/app-error'
import { lockMembers, transition } from '@/lib/db/concurrency'
import { lockSequence } from '@/lib/db/sequence'
import { enforceDualControl, type StaffActor } from '@/lib/authz/guards'
import { roundMoney, type DecimalValue } from '@/lib/domain/money'
import { lagosToday, parseDateOnly, isBefore, toLagosDateString } from '@/lib/domain/dates'
import { formatSequentialNumber, nextSequenceAfter } from '@/lib/domain/payment-reference'
import {
  computeSettlementQuote,
  dateOnlyString,
  deriveInstalmentStatus,
  deriveLoanStatus,
  describeLoanTerms,
  evaluateApprovalTerms,
  instalmentOutstanding,
  LOAN_EXPOSURE_STATUSES,
  LOAN_PRE_DISBURSEMENT_STATUSES,
  LOAN_REPAYABLE_STATUSES,
  quoteLoan,
  type LoanQuote,
  type SettlementQuote,
} from '@/lib/domain/loan-workflow'
import { evaluateOwnSavingsLien } from '@/lib/domain/capacity'
import { getActiveLoanRateForDuration } from '@/lib/services/rate-policy.service'
import { getSocietySetting } from '@/lib/services/society-settings.service'
import { requestLoanGuarantor } from '@/lib/services/guarantees.service'
import {
  computeLoanSupportNeeded,
  getGuarantorFreeCapacity,
  getLoanEligibilitySummary,
  recomputeApplicantLoanReservations,
} from '@/lib/services/loan-capacity.service'
import { createAndStoreConsentEvidence } from '@/lib/services/guarantor-evidence.service'
import { generateAndPersistLoanSchedule } from '@/lib/services/schedules.service'
import { postJournalEntry, postLoanDisbursement, type JournalLineInput } from '@/lib/services/ledger.service'
import { getWalletSummary } from '@/lib/services/wallet.service'
import {
  calculatePaymentAllocation,
  type AllocationPeriodItem,
  type CalculatedAllocation,
} from '@/lib/services/allocation.service'
import { recordAuditEvent, AuditAction, AuditOutcome } from '@/lib/services/audit.service'
import { recalculateLatenessInTx } from '@/lib/services/lateness.service'

/**
 * Loan workflow (guide P3-04; §1.4, §1.9, §2.1, §2.7, §2.9, §2.11, §4.1).
 *
 * PENDING → APPROVED → ACCEPTED → ACTIVE → COMPLETED
 *         → AWAITING_RECONSENT → ACCEPTED   (approved amount/term changed, D-10)
 *         → REJECTED / CANCELLED; offers → DECLINED / EXPIRED
 *
 * Every status change uses transition() (conditional update) inside a
 * transaction that first takes lockMembers on the borrower and guarantor.
 */

type Tx = Prisma.TransactionClient
const ZERO = new Prisma.Decimal(0)

// Statuses whose guarantee is released when the loan ends
const OPEN_GUARANTEE_STATES: GuaranteeState[] = [
  GuaranteeState.PENDING,
  GuaranteeState.CONSENTED,
  GuaranteeState.AWAITING_RECONSENT,
]

/**
 * Loan transactions take several member locks and some generate PDF evidence
 * (with a storage upload) before committing; Prisma's 5 s default interactive
 * timeout is too tight for that under load.
 */
export function loanTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { maxWait: 10_000, timeout: 30_000 })
}

function err(code: string, message: string, statusCode = 422): AppError {
  return new AppError(code, message, { statusCode })
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export interface ActiveLoanTerms {
  termMonths: number
  monthlyInterestPercent: Prisma.Decimal
  latePenaltyDailyPercent: Prisma.Decimal
  penaltyCapType: PenaltyCapType
  penaltyCapValue: Prisma.Decimal
  version: number
}

/** The active admin-configured term rate (D-05). No hardcoded fallback: no rate, no loan. */
export async function requireActiveLoanTerms(termMonths: number): Promise<ActiveLoanTerms> {
  if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 12) {
    throw err('VALIDATION_ERROR', 'The loan term must be between 1 and 12 months.', 400)
  }
  const rate = await getActiveLoanRateForDuration(termMonths)
  if (!rate) {
    throw err(
      'LOAN_TERM_UNAVAILABLE',
      `Loans for ${termMonths} month(s) are not offered at the moment. Choose another term.`,
    )
  }
  return {
    termMonths,
    monthlyInterestPercent: rate.monthlyInterestPercent,
    latePenaltyDailyPercent: rate.latePenaltyDailyPercent,
    penaltyCapType: rate.penaltyCapType,
    penaltyCapValue: rate.penaltyCapValue,
    version: rate.version,
  }
}

export async function getLoanApplicationFee(): Promise<Prisma.Decimal> {
  // ASSUMPTION A-14: one configurable application fee, default ₦0
  const fee = await getSocietySetting('loanApplicationFee', 0)
  const d = roundMoney(fee ?? 0)
  return d.lt(0) ? ZERO : d
}

/** Price a prospective loan with the currently active term rate and fee (§2.9). */
export async function quoteNewLoan(params: { principal: DecimalValue; termMonths: number }) {
  const terms = await requireActiveLoanTerms(params.termMonths)
  const fee = await getLoanApplicationFee()
  return quoteLoan({
    principal: params.principal,
    termMonths: terms.termMonths,
    monthlyInterestRatePercent: terms.monthlyInterestPercent,
    latePenaltyDailyPercent: terms.latePenaltyDailyPercent,
    penaltyCapType: terms.penaltyCapType,
    penaltyCapValue: terms.penaltyCapValue,
    applicationFee: fee,
  })
}

type LoanSnapshot = {
  approvedAmount: Prisma.Decimal | null
  requestedAmount: Prisma.Decimal
  duration: number
  monthlyInterestRatePercent: Prisma.Decimal | null
  interestRate: Prisma.Decimal
  latePenaltyDailyPercent: Prisma.Decimal | null
  penaltyCapType: PenaltyCapType | null
  penaltyCapValue: Prisma.Decimal | null
  applicationFee: Prisma.Decimal
}

/** Quote from the loan's own snapshot (what the member and guarantor agree to). */
export function quoteFromLoan(loan: LoanSnapshot): LoanQuote {
  if (!loan.latePenaltyDailyPercent || !loan.penaltyCapType || !loan.penaltyCapValue) {
    throw err('LOAN_TERMS_MISSING', 'This loan has no snapshotted penalty terms.')
  }
  return quoteLoan({
    principal: loan.approvedAmount ?? loan.requestedAmount,
    termMonths: loan.duration,
    monthlyInterestRatePercent: loan.monthlyInterestRatePercent ?? loan.interestRate,
    latePenaltyDailyPercent: loan.latePenaltyDailyPercent,
    penaltyCapType: loan.penaltyCapType,
    penaltyCapValue: loan.penaltyCapValue,
    applicationFee: loan.applicationFee,
  })
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function loadLoanForUpdate(tx: Tx, loanId: string) {
  const loan = await tx.loan.findUnique({
    where: { id: loanId },
    include: {
      guaranteeReservations: {
        where: { guaranteeType: GuaranteeType.LOAN },
        orderBy: { createdAt: 'desc' },
      },
      offerAcceptance: true,
    },
  })
  if (!loan) throw err('NOT_FOUND', 'Loan not found.', 404)
  return loan
}

/** Current guarantee of a loan: the newest one that is not ended. */
function activeGuarantee<T extends { state: GuaranteeState }>(reservations: T[]): T | null {
  return (
    reservations.find(
      (r) =>
        r.state !== GuaranteeState.RELEASED &&
        r.state !== GuaranteeState.REPLACED &&
        r.state !== GuaranteeState.DECLINED &&
        r.state !== GuaranteeState.WITHDRAWN_BEFORE_ACTIVATION,
    ) ?? reservations[0] ?? null
  )
}

/** Lock borrower and every guarantor of the loan (sorted, deadlock-free). */
async function lockLoanParties(tx: Tx, loanId: string) {
  const parties = await tx.loan.findUnique({
    where: { id: loanId },
    select: { userId: true, guaranteeReservations: { select: { guarantorId: true } } },
  })
  if (!parties) throw err('NOT_FOUND', 'Loan not found.', 404)
  await lockMembers(tx, [parties.userId, ...parties.guaranteeReservations.map((r) => r.guarantorId)])
}

async function releaseLoanGuarantees(tx: Tx, loanId: string, reason: string) {
  await tx.guaranteeReservation.updateMany({
    where: { loanId, state: { in: OPEN_GUARANTEE_STATES } },
    data: {
      state: GuaranteeState.RELEASED,
      reservedAmount: ZERO,
      releasedAt: new Date(),
      decisionReason: reason,
    },
  })
}

/**
 * An unpaid application fee is not a debt once the application ends; it is
 * waived (it was never recognised as income). A paid fee is kept (OQ-03).
 */
async function waiveUnpaidApplicationFee(tx: Tx, loanId: string) {
  await tx.feeAssessment.updateMany({
    where: { feeType: FeeType.LOAN_APPLICATION, targetId: loanId, status: FeeStatus.PENDING },
    data: { status: FeeStatus.WAIVED },
  })
}

async function endLoanApplication(
  tx: Tx,
  params: {
    loanId: string
    from: LoanStatus[]
    to: LoanStatus
    reason: string
    actorId: string | null
    actorRole?: UserRole | null
    action: string
    extra?: Prisma.LoanUpdateManyMutationInput
  },
) {
  const loan = await tx.loan.findUniqueOrThrow({ where: { id: params.loanId } })
  await transition(tx.loan, params.loanId, params.from, {
    status: params.to,
    rejectionReason: params.reason,
    offerExpiresAt: null,
    ...(params.to === LoanStatus.CANCELLED || params.to === LoanStatus.EXPIRED
      ? { cancelledAt: new Date() }
      : {}),
    ...params.extra,
  })
  await releaseLoanGuarantees(tx, params.loanId, `Loan ${params.to.toLowerCase()}: ${params.reason}`)
  await waiveUnpaidApplicationFee(tx, params.loanId)
  await recomputeApplicantLoanReservations(tx, loan.userId)
  await recordAuditEvent(
    {
      actorId: params.actorId,
      actorRole: params.actorRole ?? null,
      affectedUserId: loan.userId,
      action: params.action,
      entityType: 'Loan',
      entityId: loan.id,
      outcome: AuditOutcome.SUCCESS,
      beforeState: { status: loan.status },
      afterState: { status: params.to },
      metadata: { loanId: loan.id, reason: params.reason },
    },
    tx,
  )
}

// ---------------------------------------------------------------------------
// Application (§1.4, §1.9, §2.1)
// ---------------------------------------------------------------------------

export interface ApplyForLoanInput {
  memberId: string
  requestedAmount: DecimalValue
  termMonths: number
  purpose: string
  guarantorId: string
}

export async function applyForLoan(input: ApplyForLoanInput) {
  const amount = roundMoney(input.requestedAmount)
  if (amount.lte(0)) throw err('VALIDATION_ERROR', 'The loan amount must be greater than zero.', 400)
  const purpose = input.purpose.trim()
  if (purpose.length < 3) throw err('VALIDATION_ERROR', 'Please describe the purpose of the loan.', 400)
  if (!input.guarantorId) {
    throw err('GUARANTOR_REQUIRED', 'Every loan needs a Crystal Kairos guarantor.', 400)
  }
  if (input.guarantorId === input.memberId) {
    throw err('GUARANTOR_INELIGIBLE', 'You cannot be your own guarantor.')
  }

  const terms = await requireActiveLoanTerms(input.termMonths)
  const fee = await getLoanApplicationFee()
  const quote = quoteLoan({
    principal: amount,
    termMonths: terms.termMonths,
    monthlyInterestRatePercent: terms.monthlyInterestPercent,
    latePenaltyDailyPercent: terms.latePenaltyDailyPercent,
    penaltyCapType: terms.penaltyCapType,
    penaltyCapValue: terms.penaltyCapValue,
    applicationFee: fee,
  })

  return loanTransaction(async (tx) => {
    await lockMembers(tx, [input.memberId, input.guarantorId])

    const member = await tx.user.findUnique({
      where: { id: input.memberId },
      select: { id: true, role: true, isActive: true },
    })
    if (!member || member.role !== UserRole.USER || !member.isActive) {
      throw err('FORBIDDEN', 'Only active members can apply for a loan.', 403)
    }
    const guarantor = await tx.user.findUnique({
      where: { id: input.guarantorId },
      select: { id: true, name: true, role: true, isActive: true, userInfo: { select: { phoneNumber: true } } },
    })
    if (!guarantor || guarantor.role !== UserRole.USER || !guarantor.isActive) {
      throw err('GUARANTOR_INELIGIBLE', 'The selected guarantor is not an active Crystal Kairos member.')
    }

    const loan = await tx.loan.create({
      data: {
        userId: member.id,
        requestedAmount: amount,
        interestRate: terms.monthlyInterestPercent,
        monthlyInterestRatePercent: terms.monthlyInterestPercent,
        interestCalculationMethod: 'FLAT_MONTHLY_ON_ORIGINAL_PRINCIPAL',
        latePenaltyDailyPercent: terms.latePenaltyDailyPercent,
        penaltyCapType: terms.penaltyCapType,
        penaltyCapValue: terms.penaltyCapValue,
        loanTermRateVersion: terms.version,
        duration: terms.termMonths,
        requestedDurationMonths: terms.termMonths,
        purpose,
        guarantorId: guarantor.id,
        guarantorName: guarantor.name,
        guarantorPhoneNumber: guarantor.userInfo?.phoneNumber ?? null,
        applicationFee: fee,
        outstandingBalance: ZERO,
        termsVersion: 1,
        status: LoanStatus.PENDING,
      },
    })

    // Validates guarantor eligibility and that the guarantor's free capacity
    // covers the support this loan needs beyond the standalone limit (§2.1, C3).
    const reservation = await requestLoanGuarantor(tx, {
      loanId: loan.id,
      applicantId: member.id,
      guarantorId: guarantor.id,
      requestedAmount: amount,
      termMonths: terms.termMonths,
      monthlyInterestRate: terms.monthlyInterestPercent,
      penaltyTerms: describeLoanTerms(quote),
      termsVersion: 1,
    })

    let feeAssessment = null
    if (fee.gt(0)) {
      feeAssessment = await tx.feeAssessment.create({
        data: {
          memberId: member.id,
          feeType: FeeType.LOAN_APPLICATION,
          targetId: loan.id,
          amount: fee,
          status: FeeStatus.PENDING,
        },
      })
      await recordAuditEvent(
        {
          actorId: member.id,
          actorRole: UserRole.USER,
          affectedUserId: member.id,
          action: AuditAction.LOAN_FEE_ASSESSED,
          entityType: 'FeeAssessment',
          entityId: feeAssessment.id,
          outcome: AuditOutcome.SUCCESS,
          metadata: { loanId: loan.id, amount: fee.toString() },
        },
        tx,
      )
    }

    await recordAuditEvent(
      {
        actorId: member.id,
        actorRole: UserRole.USER,
        affectedUserId: member.id,
        action: AuditAction.LOAN_APPLIED,
        entityType: 'Loan',
        entityId: loan.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: {
          loanId: loan.id,
          amount: amount.toString(),
          durationMonths: terms.termMonths,
          monthlyInterestRatePercent: terms.monthlyInterestPercent.toString(),
          rateVersion: terms.version,
          applicationFee: fee.toString(),
          guaranteeSupportRequested: reservation.requestedAmount.toString(),
        },
      },
      tx,
    )
    await recordAuditEvent(
      {
        actorId: member.id,
        actorRole: UserRole.USER,
        affectedUserId: guarantor.id,
        action: AuditAction.GUARANTEE_CONSENT_REQUESTED,
        entityType: 'GuaranteeReservation',
        entityId: reservation.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: { loanId: loan.id },
      },
      tx,
    )

    return { loan, reservation, feeAssessment, quote }
  })
}

/** Member withdraws their own application before an admin decides (PENDING → CANCELLED). */
export async function cancelLoanApplication(params: { loanId: string; memberId: string; reason?: string }) {
  return loanTransaction(async (tx) => {
    await lockLoanParties(tx, params.loanId)
    const loan = await loadLoanForUpdate(tx, params.loanId)
    if (loan.userId !== params.memberId) throw err('FORBIDDEN', 'Not authorised.', 403)
    if (loan.status !== LoanStatus.PENDING) {
      throw err('INVALID_STATE', 'Only a pending application can be withdrawn.')
    }
    await endLoanApplication(tx, {
      loanId: loan.id,
      from: [LoanStatus.PENDING],
      to: LoanStatus.CANCELLED,
      reason: params.reason?.trim() || 'Withdrawn by the member',
      actorId: params.memberId,
      actorRole: UserRole.USER,
      action: AuditAction.LOAN_CANCELLED,
    })
    return tx.loan.findUniqueOrThrow({ where: { id: loan.id } })
  })
}

// ---------------------------------------------------------------------------
// Admin review (§1.4, D-07, D-10, A-14, A-19)
// ---------------------------------------------------------------------------

async function isApplicationFeeSettled(tx: Tx | typeof prisma, loanId: string, fee: Prisma.Decimal) {
  if (fee.lte(0)) return true
  const assessment = await tx.feeAssessment.findFirst({
    where: { feeType: FeeType.LOAN_APPLICATION, targetId: loanId },
    orderBy: { assessedAt: 'desc' },
  })
  return !!assessment && (assessment.status === FeeStatus.PAID || assessment.status === FeeStatus.WAIVED)
}

export interface ApproveLoanInput {
  loanId: string
  actor: Pick<StaffActor, 'id' | 'role'>
  approvedAmount: DecimalValue
  approvedTermMonths?: number
  note?: string
}

/**
 * Admin approval. Never automatic, never defaults to the eligible amount.
 * Unchanged terms → APPROVED (offer to the borrower). Changed amount/term →
 * AWAITING_RECONSENT: the borrower must accept and the guarantor must consent
 * again to the final figures before disbursement (D-10).
 */
export async function approveLoan(input: ApproveLoanInput) {
  const approvedAmount = roundMoney(input.approvedAmount)
  const offerDays = await getSocietySetting('loanOfferValidityDays', 14)

  return loanTransaction(async (tx) => {
    await lockLoanParties(tx, input.loanId)
    const loan = await loadLoanForUpdate(tx, input.loanId)
    if (loan.status !== LoanStatus.PENDING) {
      throw err('INVALID_STATE', 'Only a pending application can be approved.')
    }

    const guarantee = activeGuarantee(loan.guaranteeReservations)
    if (
      !guarantee ||
      guarantee.state !== GuaranteeState.CONSENTED ||
      guarantee.termsVersion !== loan.termsVersion
    ) {
      throw err(
        'GUARANTOR_CONSENT_REQUIRED',
        'The loan cannot be approved until the guarantor has consented to this application.',
      )
    }

    if (!(await isApplicationFeeSettled(tx, loan.id, loan.applicationFee))) {
      // ASSUMPTION A-14: the application fee must be paid before approval
      throw err('APPLICATION_FEE_UNPAID', 'The application fee must be paid before the loan can be approved.')
    }

    const requestedTerm = loan.requestedDurationMonths ?? loan.duration
    const approvedTerm = input.approvedTermMonths ?? loan.duration
    const check = evaluateApprovalTerms({
      requestedAmount: loan.requestedAmount,
      consentedAmount: guarantee.consentedAmount,
      approvedAmount,
      requestedTermMonths: requestedTerm,
      approvedTermMonths: approvedTerm,
    })
    if (!check.ok) throw err('INVALID_APPROVAL', check.reason)

    // Term change → the rate and penalty terms of the new term apply.
    let rateFields: Prisma.LoanUpdateManyMutationInput = {}
    if (approvedTerm !== loan.duration) {
      const terms = await requireActiveLoanTerms(approvedTerm)
      rateFields = {
        duration: terms.termMonths,
        interestRate: terms.monthlyInterestPercent,
        monthlyInterestRatePercent: terms.monthlyInterestPercent,
        latePenaltyDailyPercent: terms.latePenaltyDailyPercent,
        penaltyCapType: terms.penaltyCapType,
        penaltyCapValue: terms.penaltyCapValue,
        loanTermRateVersion: terms.version,
      }
    }

    // Capacity re-check inside the lock: never approve on stale capacity (§2.1).
    const support = await computeLoanSupportNeeded(
      { applicantId: loan.userId, loanId: loan.id, principal: approvedAmount },
      tx,
    )
    if (support.needed.gt(guarantee.reservedAmount)) {
      const free = await getGuarantorFreeCapacity(guarantee.guarantorId, tx, guarantee.id)
      if (support.needed.gt(free)) {
        throw err(
          'CAPACITY_EXCEEDED',
          `The guarantor's free capacity (₦${free.toFixed(2)}) no longer covers the ₦${support.needed.toFixed(2)} of support this loan needs.`,
        )
      }
    }

    const termsChanged = check.termsChanged
    const newTermsVersion = termsChanged ? loan.termsVersion + 1 : loan.termsVersion
    const now = new Date()
    const offerExpiresAt = new Date(now.getTime() + offerDays * 24 * 60 * 60 * 1000)

    await transition(tx.loan, loan.id, [LoanStatus.PENDING], {
      status: termsChanged ? LoanStatus.AWAITING_RECONSENT : LoanStatus.APPROVED,
      approvedAmount,
      approvedBy: input.actor.id,
      approvedAt: now,
      approvalNote: input.note?.trim() || null,
      termsVersion: newTermsVersion,
      offerExpiresAt,
      ...rateFields,
    })
    const updated = await tx.loan.findUniqueOrThrow({ where: { id: loan.id } })
    const quote = quoteFromLoan(updated)

    await tx.guaranteeReservation.update({
      where: { id: guarantee.id },
      data: termsChanged
        ? {
            state: GuaranteeState.AWAITING_RECONSENT,
            requestedAmount: support.needed,
            reservedAmount: support.needed, // held until the guarantor decides
            termMonths: updated.duration,
            monthlyInterestRate: updated.monthlyInterestRatePercent,
            penaltyTerms: describeLoanTerms(quote),
            termsVersion: newTermsVersion,
          }
        : { reservedAmount: support.needed },
    })

    await tx.borrowerOfferAcceptance.upsert({
      where: { loanId: loan.id },
      create: {
        loanId: loan.id,
        borrowerId: loan.userId,
        decision: BorrowerOfferDecision.PENDING,
        offeredPrincipal: quote.principal,
        offeredTermMonths: quote.termMonths,
        offeredMonthlyInterestRate: quote.monthlyInterestRatePercent,
        totalScheduledRepayment: quote.totalScheduledRepayment,
        monthlyInstalment: quote.monthlyInstalment,
        termsVersion: newTermsVersion,
      },
      update: {
        decision: BorrowerOfferDecision.PENDING,
        offeredPrincipal: quote.principal,
        offeredTermMonths: quote.termMonths,
        offeredMonthlyInterestRate: quote.monthlyInterestRatePercent,
        totalScheduledRepayment: quote.totalScheduledRepayment,
        monthlyInstalment: quote.monthlyInstalment,
        termsVersion: newTermsVersion,
        decidedAt: null,
        evidenceCloudinaryPublicId: null,
        evidenceDocumentId: null,
        evidenceSha256: null,
      },
    })

    await recomputeApplicantLoanReservations(tx, loan.userId)

    await recordAuditEvent(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        affectedUserId: loan.userId,
        action: termsChanged ? AuditAction.LOAN_RECONSENT_REQUESTED : AuditAction.LOAN_APPROVED,
        entityType: 'Loan',
        entityId: loan.id,
        outcome: AuditOutcome.SUCCESS,
        beforeState: {
          status: loan.status,
          requestedAmount: loan.requestedAmount.toString(),
          termMonths: loan.duration,
        },
        afterState: {
          status: updated.status,
          approvedAmount: approvedAmount.toString(),
          termMonths: updated.duration,
          termsVersion: newTermsVersion,
        },
        metadata: {
          loanId: loan.id,
          termsChanged,
          guaranteeReserved: support.needed.toString(),
          note: input.note?.trim() || undefined,
        },
      },
      tx,
    )

    return { loan: updated, termsChanged, quote }
  })
}

export async function rejectLoan(params: {
  loanId: string
  actor: Pick<StaffActor, 'id' | 'role'>
  reason: string
}) {
  const reason = params.reason?.trim()
  if (!reason) throw err('REASON_REQUIRED', 'A rejection reason is required.', 400)
  return loanTransaction(async (tx) => {
    await lockLoanParties(tx, params.loanId)
    const loan = await loadLoanForUpdate(tx, params.loanId)
    if (loan.status !== LoanStatus.PENDING) {
      throw err('INVALID_STATE', 'Only a pending application can be rejected.')
    }
    await endLoanApplication(tx, {
      loanId: loan.id,
      from: [LoanStatus.PENDING],
      to: LoanStatus.REJECTED,
      reason,
      actorId: params.actor.id,
      actorRole: params.actor.role,
      action: AuditAction.LOAN_REJECTED,
      extra: { approvedBy: params.actor.id, approvedAt: new Date() },
    })
    return tx.loan.findUniqueOrThrow({ where: { id: loan.id } })
  })
}

// ---------------------------------------------------------------------------
// Offer acceptance, re-consent and expiry (§2.7, A-03)
// ---------------------------------------------------------------------------

async function promoteIfFullyAccepted(tx: Tx, loanId: string, actorId: string | null) {
  const loan = await loadLoanForUpdate(tx, loanId)
  if (loan.status !== LoanStatus.APPROVED && loan.status !== LoanStatus.AWAITING_RECONSENT) return loan
  const offer = loan.offerAcceptance
  const guarantee = activeGuarantee(loan.guaranteeReservations)
  const borrowerAccepted =
    !!offer && offer.decision === BorrowerOfferDecision.ACCEPTED && offer.termsVersion === loan.termsVersion
  const guarantorConsented =
    !!guarantee &&
    guarantee.state === GuaranteeState.CONSENTED &&
    guarantee.termsVersion === loan.termsVersion
  if (!borrowerAccepted || !guarantorConsented) return loan

  await transition(tx.loan, loan.id, [loan.status], { status: LoanStatus.ACCEPTED, offerExpiresAt: null })
  await recordAuditEvent(
    {
      actorId,
      affectedUserId: loan.userId,
      action: AuditAction.LOAN_STATUS_CHANGED,
      entityType: 'Loan',
      entityId: loan.id,
      outcome: AuditOutcome.SUCCESS,
      beforeState: { status: loan.status },
      afterState: { status: LoanStatus.ACCEPTED },
      metadata: { loanId: loan.id, termsVersion: loan.termsVersion },
    },
    tx,
  )
  return tx.loan.findUniqueOrThrow({ where: { id: loan.id } })
}

/** The borrower accepts or declines the final offer; both produce PDF evidence. */
export async function respondToLoanOffer(params: {
  loanId: string
  memberId: string
  decision: 'ACCEPT' | 'DECLINE'
  reason?: string
  now?: Date
}) {
  const now = params.now ?? new Date()
  if (params.decision === 'DECLINE' && !params.reason?.trim()) {
    throw err('REASON_REQUIRED', 'Please give a reason for declining the offer.', 400)
  }
  return loanTransaction(async (tx) => {
    await lockLoanParties(tx, params.loanId)
    const loan = await loadLoanForUpdate(tx, params.loanId)
    if (loan.userId !== params.memberId) throw err('FORBIDDEN', 'Not authorised.', 403)
    if (loan.status !== LoanStatus.APPROVED && loan.status !== LoanStatus.AWAITING_RECONSENT) {
      throw err('INVALID_STATE', 'There is no open loan offer to respond to.')
    }
    if (loan.offerExpiresAt && loan.offerExpiresAt.getTime() < now.getTime()) {
      throw err('OFFER_EXPIRED', 'This loan offer has expired. Please apply again.')
    }
    const offer = loan.offerAcceptance
    if (!offer || offer.termsVersion !== loan.termsVersion) {
      throw err('INVALID_STATE', 'The offer is being updated. Refresh and try again.', 409)
    }
    if (offer.decision !== BorrowerOfferDecision.PENDING) {
      throw err('INVALID_STATE', 'You have already responded to this offer.', 409)
    }

    const borrower = await tx.user.findUniqueOrThrow({
      where: { id: loan.userId },
      select: { id: true, name: true, email: true },
    })
    const quote = quoteFromLoan(loan)
    const evidence = await createAndStoreConsentEvidence({
      evidenceType: 'BORROWER_OFFER_ACCEPTANCE',
      applicationId: loan.id,
      borrower,
      consentedTerms: {
        amount: quote.principal.toString(),
        termMonths: quote.termMonths,
        monthlyInterestRate: quote.monthlyInterestRatePercent.toString(),
        termsVersion: loan.termsVersion,
        penaltyTerms: describeLoanTerms(quote),
      },
      decision: params.decision === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED',
      decisionReason: params.reason?.trim(),
      decidedAt: now,
      uploadedById: params.memberId,
    })

    const res = await tx.borrowerOfferAcceptance.updateMany({
      where: { loanId: loan.id, decision: BorrowerOfferDecision.PENDING, termsVersion: loan.termsVersion },
      data: {
        decision:
          params.decision === 'ACCEPT' ? BorrowerOfferDecision.ACCEPTED : BorrowerOfferDecision.DECLINED,
        decidedAt: now,
        evidenceCloudinaryPublicId: evidence.publicId,
        evidenceDocumentId: evidence.documentId,
        evidenceSha256: evidence.sha256,
      },
    })
    if (res.count !== 1) throw err('STALE_STATE', 'This offer was already answered.', 409)

    await recordAuditEvent(
      {
        actorId: params.memberId,
        actorRole: UserRole.USER,
        affectedUserId: loan.userId,
        action:
          params.decision === 'ACCEPT' ? AuditAction.LOAN_OFFER_ACCEPTED : AuditAction.LOAN_OFFER_DECLINED,
        entityType: 'Loan',
        entityId: loan.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: {
          loanId: loan.id,
          termsVersion: loan.termsVersion,
          evidenceDocumentId: evidence.documentId,
        },
      },
      tx,
    )

    if (params.decision === 'DECLINE') {
      await endLoanApplication(tx, {
        loanId: loan.id,
        from: [LoanStatus.APPROVED, LoanStatus.AWAITING_RECONSENT],
        to: LoanStatus.DECLINED,
        reason: params.reason!.trim(),
        actorId: params.memberId,
        actorRole: UserRole.USER,
        action: AuditAction.LOAN_STATUS_CHANGED,
      })
      return { loan: await tx.loan.findUniqueOrThrow({ where: { id: loan.id } }), evidence }
    }

    const after = await promoteIfFullyAccepted(tx, loan.id, params.memberId)
    return { loan: after, evidence }
  })
}

/**
 * Keeps the loan in step with its guarantor's decision (call in the same
 * transaction, after decideGuarantorRequest / withdrawGuarantorConsent):
 * - re-consent given + borrower accepted → ACCEPTED;
 * - re-consent declined → DECLINED (offer ends, reservations released);
 * - consent withdrawn after approval → CANCELLED (an approval without a
 *   consenting guarantor cannot stand, §2.7). A pending application stays
 *   pending and cannot be approved.
 */
export async function syncLoanWithGuarantee(tx: Tx, reservationId: string, actorId: string | null) {
  const reservation = await tx.guaranteeReservation.findUnique({ where: { id: reservationId } })
  if (!reservation?.loanId) return null
  const loan = await tx.loan.findUnique({ where: { id: reservation.loanId } })
  if (!loan) return null

  if (reservation.state === GuaranteeState.CONSENTED) {
    return promoteIfFullyAccepted(tx, loan.id, actorId)
  }
  const ended =
    reservation.state === GuaranteeState.DECLINED ||
    reservation.state === GuaranteeState.WITHDRAWN_BEFORE_ACTIVATION
  if (!ended) return loan

  if (loan.status === LoanStatus.AWAITING_RECONSENT && reservation.state === GuaranteeState.DECLINED) {
    await endLoanApplication(tx, {
      loanId: loan.id,
      from: [LoanStatus.AWAITING_RECONSENT],
      to: LoanStatus.DECLINED,
      reason: 'The guarantor declined the revised terms',
      actorId,
      action: AuditAction.LOAN_STATUS_CHANGED,
    })
  } else if (
    loan.status === LoanStatus.APPROVED ||
    loan.status === LoanStatus.AWAITING_RECONSENT ||
    loan.status === LoanStatus.ACCEPTED
  ) {
    await endLoanApplication(tx, {
      loanId: loan.id,
      from: [loan.status],
      to: LoanStatus.CANCELLED,
      reason: 'The guarantor withdrew consent before disbursement',
      actorId,
      action: AuditAction.LOAN_CANCELLED,
    })
  }
  return tx.loan.findUnique({ where: { id: loan.id } })
}

/**
 * Expires open offers whose acceptance window passed (idempotent; called by
 * lib/jobs/loan-offers.job.ts and safe to run any number of times).
 */
export async function expireLoanOffer(tx: Tx, loanId: string, now: Date) {
  const loan = await tx.loan.findUnique({ where: { id: loanId } })
  if (
    !loan ||
    (loan.status !== LoanStatus.APPROVED && loan.status !== LoanStatus.AWAITING_RECONSENT) ||
    !loan.offerExpiresAt ||
    loan.offerExpiresAt.getTime() >= now.getTime()
  ) {
    return false
  }
  await lockLoanParties(tx, loanId)
  await endLoanApplication(tx, {
    loanId,
    from: [LoanStatus.APPROVED, LoanStatus.AWAITING_RECONSENT],
    to: LoanStatus.EXPIRED,
    reason: 'The offer was not accepted in time',
    actorId: null,
    action: AuditAction.LOAN_OFFER_EXPIRED,
  })
  return true
}

// ---------------------------------------------------------------------------
// Disbursement (ACCEPTED → ACTIVE)
// ---------------------------------------------------------------------------

export interface DisburseLoanInput {
  loanId: string
  actor: StaffActor
  amount: DecimalValue
  valueDate: string // YYYY-MM-DD, Lagos calendar day the money left the cooperative
  bankReference: string
  evidenceFileId: string
  bankAccountId?: string
}

/**
 * Records the offline disbursement in one locked transaction: disbursement
 * record, instalments from the persisted schedule anchored on the value date,
 * the principal journal (LOAN_RECEIVABLE_PRINCIPAL vs COOPERATIVE_CASH), and
 * ACCEPTED → ACTIVE. The own-savings lock already applies (derived from the
 * loan state). Idempotent: a repeat returns the existing disbursement.
 */
export async function disburseLoan(input: DisburseLoanInput) {
  const bankReference = input.bankReference?.trim()
  if (!bankReference) throw err('BANK_REFERENCE_REQUIRED', 'The bank reference is required.', 400)
  if (!input.evidenceFileId) {
    throw err('EVIDENCE_REQUIRED', 'Upload the transfer evidence before recording the disbursement.', 400)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.valueDate ?? '')) {
    throw err('VALIDATION_ERROR', 'A valid value date (YYYY-MM-DD) is required.', 400)
  }
  const valueDate = parseDateOnly(input.valueDate)
  if (isBefore(lagosToday(), input.valueDate)) {
    throw err('VALIDATION_ERROR', 'The value date cannot be in the future.', 400)
  }
  const amount = roundMoney(input.amount)

  return loanTransaction(async (tx) => {
    await lockLoanParties(tx, input.loanId)
    const loan = await loadLoanForUpdate(tx, input.loanId)

    // Idempotent replay
    if (loan.disbursementId && LOAN_REPAYABLE_STATUSES.concat([LoanStatus.COMPLETED]).includes(loan.status)) {
      const disbursement = await tx.disbursement.findUniqueOrThrow({ where: { id: loan.disbursementId } })
      return { loan, disbursement, isReplay: true }
    }
    if (loan.status !== LoanStatus.ACCEPTED) {
      throw err('INVALID_STATE', 'Only an accepted loan offer can be disbursed.')
    }
    if (!loan.approvedAmount || !amount.equals(loan.approvedAmount)) {
      throw err(
        'AMOUNT_MISMATCH',
        `The disbursed amount must equal the approved amount (₦${loan.approvedAmount?.toFixed(2) ?? '0.00'}).`,
      )
    }
    if (loan.approvedAt && isBefore(input.valueDate, toLagosDateString(loan.approvedAt))) {
      throw err('VALIDATION_ERROR', 'The value date cannot be before the approval date.', 400)
    }
    const offer = loan.offerAcceptance
    if (!offer || offer.decision !== BorrowerOfferDecision.ACCEPTED || offer.termsVersion !== loan.termsVersion) {
      throw err('OFFER_NOT_ACCEPTED', 'The borrower has not accepted the final loan offer.')
    }
    const guarantee = activeGuarantee(loan.guaranteeReservations)
    if (!guarantee || guarantee.state !== GuaranteeState.CONSENTED || guarantee.termsVersion !== loan.termsVersion) {
      throw err('GUARANTOR_CONSENT_REQUIRED', 'The guarantor has not consented to the final terms.')
    }

    // Dual control (A-19): the approver cannot also disburse when two eligible staff exist.
    // ASSUMPTION A-19
    const dual = await enforceDualControl(
      { actor: input.actor, previousActorId: loan.approvedBy, requiredPermission: AdminPermission.LOANS_DISBURSE },
      tx as unknown as typeof prisma,
    )

    const evidence = await tx.storedFile.findUnique({ where: { id: input.evidenceFileId } })
    if (!evidence || evidence.uploadedById !== input.actor.id || (evidence.associatedId && evidence.associatedType !== 'DISBURSEMENT')) {
      throw err('EVIDENCE_INVALID', 'The disbursement evidence file was not found.', 400)
    }

    const bankAccount = await tx.bankAccount.findFirst({
      where: input.bankAccountId
        ? { id: input.bankAccountId, userId: loan.userId }
        : { userId: loan.userId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    })
    if (!bankAccount) {
      throw err('BANK_ACCOUNT_REQUIRED', 'The member has no bank account on file to receive the loan.')
    }

    await lockSequence(tx, 'DSB')
    const lastDisbursement = await tx.disbursement.findFirst({
      orderBy: { disbursementNumber: 'desc' },
      select: { disbursementNumber: true },
    })
    const disbursement = await tx.disbursement.create({
      data: {
        disbursementNumber: formatSequentialNumber('DSB', nextSequenceAfter(lastDisbursement?.disbursementNumber)),
        recipientUserId: loan.userId,
        purpose: DisbursementPurpose.LOAN_DISBURSEMENT,
        amount,
        bankAccountId: bankAccount.id,
        bankReference,
        valueDate,
        status: DisbursementStatus.PAID,
        requestedById: loan.approvedBy ?? input.actor.id,
        approvedById: loan.approvedBy ?? input.actor.id,
        disbursedById: input.actor.id,
        disbursedAt: new Date(),
        idempotencyKey: `loan-disbursement:${loan.id}`,
      },
    })

    const journal = await postLoanDisbursement(tx, {
      amount,
      memberId: loan.userId,
      loanId: loan.id,
      effectiveDate: valueDate,
      idempotencyKey: `loan-disbursement:${loan.id}`,
      postedById: input.actor.id,
      description: `Loan disbursement ${disbursement.disbursementNumber}`,
    })
    await tx.disbursement.update({ where: { id: disbursement.id }, data: { journalEntryId: journal.id } })
    await tx.storedFile.update({
      where: { id: evidence.id },
      data: { associatedType: 'DISBURSEMENT', associatedId: disbursement.id, ownerUserId: loan.userId },
    })

    const instalments = await generateAndPersistLoanSchedule(tx, {
      loanId: loan.id,
      principal: amount,
      termMonths: loan.duration,
      monthlyInterestRatePercent: loan.monthlyInterestRatePercent ?? loan.interestRate,
      disbursementValueDate: input.valueDate,
    })
    const quote = quoteFromLoan(loan)

    await transition(tx.loan, loan.id, [LoanStatus.ACCEPTED], {
      status: LoanStatus.ACTIVE,
      disbursementId: disbursement.id,
      disbursementValueDate: valueDate,
      disbursedAt: new Date(),
      repaymentStartDate: instalments[0].dueDate,
      repaymentEndDate: instalments[instalments.length - 1].dueDate,
      outstandingBalance: quote.totalScheduledRepayment,
      offerExpiresAt: null,
    })

    await recordAuditEvent(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        affectedUserId: loan.userId,
        action: AuditAction.LOAN_DISBURSED,
        entityType: 'Loan',
        entityId: loan.id,
        outcome: AuditOutcome.SUCCESS,
        isSingleOperator: dual.singleOperator,
        metadata: {
          loanId: loan.id,
          disbursementId: disbursement.id,
          disbursementNumber: disbursement.disbursementNumber,
          amount: amount.toString(),
          valueDate: input.valueDate,
          bankReference,
          journalEntryId: journal.id,
          instalments: instalments.length,
          singleOperator: dual.singleOperator || undefined,
        },
      },
      tx,
    )

    const updated = await tx.loan.findUniqueOrThrow({ where: { id: loan.id } })
    return { loan: updated, disbursement, journalEntryId: journal.id, isReplay: false }
  })
}

// ---------------------------------------------------------------------------
// Repayment: allocation targets, instalment updates, derived statuses
// ---------------------------------------------------------------------------

/**
 * Allocation periods for a LOAN payment target (used by payments.service).
 * A target with a period pays that instalment; a target without a period pays
 * the whole loan, oldest instalment first (early settlement / pay ahead).
 */
export async function getLoanAllocationPeriods(
  tx: Tx,
  params: { memberId: string; loanId: string; instalmentId?: string | null },
): Promise<AllocationPeriodItem[]> {
  const loan = await tx.loan.findUnique({
    where: { id: params.loanId },
    select: { id: true, userId: true, status: true },
  })
  if (!loan || loan.userId !== params.memberId) {
    throw err('INVALID_TARGET', 'The loan does not belong to this member.')
  }
  const instalments = await tx.loanInstalment.findMany({
    where: { loanId: loan.id, ...(params.instalmentId ? { id: params.instalmentId } : {}) },
    orderBy: { instalmentNumber: 'asc' },
  })
  if (params.instalmentId && instalments.length === 0) {
    throw err('INVALID_TARGET', 'The instalment does not belong to this loan.')
  }
  return instalments
    .map((i) => ({ i, o: instalmentOutstanding(i) }))
    .filter(({ o }) => o.total.gt(0))
    .map(({ i, o }) => ({
      periodId: i.id,
      targetType: 'LOAN' as const,
      targetId: loan.id,
      periodNumber: i.instalmentNumber,
      dueDate: i.dueDate,
      penaltyDue: o.penalty.toNumber(),
      interestDue: o.interest.toNumber(),
      principalDue: o.principal.toNumber(),
    }))
}

/** Applies one confirmed LOAN allocation to its instalment balances. */
export async function applyLoanAllocation(
  tx: Tx,
  alloc: { periodId: string | null; componentType: PaymentComponentType; amount: DecimalValue },
) {
  if (!alloc.periodId) return
  const amount = roundMoney(alloc.amount)
  const field =
    alloc.componentType === PaymentComponentType.PENALTY
      ? 'penaltyPaid'
      : alloc.componentType === PaymentComponentType.INTEREST
        ? 'interestPaid'
        : alloc.componentType === PaymentComponentType.PRINCIPAL
          ? 'principalPaid'
          : null
  if (!field) return
  await tx.loanInstalment.update({ where: { id: alloc.periodId }, data: { [field]: { increment: amount } } })
}

/** Instalments currently shielded by a receipt awaiting review (§2.10). */
async function getShieldedInstalments(tx: Tx, loanId: string, memberId: string, today: string) {
  const pending = await tx.submissionTarget.findMany({
    where: {
      targetType: AllocationTargetType.LOAN,
      targetId: loanId,
      submission: { memberId, status: PaymentSubmissionStatus.SUBMITTED, paidOn: { lte: parseDateOnly(today) } },
    },
    select: { targetPeriodId: true },
  })
  const ids = new Set<string>()
  let wholeLoan = false
  for (const p of pending) {
    if (p.targetPeriodId) ids.add(p.targetPeriodId)
    else wholeLoan = true
  }
  return { ids, wholeLoan }
}

/**
 * Recomputes a disbursed loan from its instalments (statuses are derived, never
 * hand-edited): instalment statuses, ACTIVE ↔ OVERDUE, and COMPLETED with the
 * release of guarantees (the own-savings lock is derived from the status, so
 * it lifts with completion). Then re-allocates the applicant's remaining
 * guarantee reservations because principal exposure changed (§2.1).
 */
export async function refreshLoanAfterPayment(
  tx: Tx,
  loanId: string,
  params: { actorId?: string | null; valueDate?: Date | string; today?: string } = {},
) {
  const today = params.today ?? lagosToday()
  const loan = await tx.loan.findUnique({
    where: { id: loanId },
    include: { instalments: { orderBy: { instalmentNumber: 'asc' } } },
  })
  if (!loan || loan.instalments.length === 0) return loan

  const shield = await getShieldedInstalments(tx, loan.id, loan.userId, today)
  const shieldedSet = new Set<string | number>()
  for (const inst of loan.instalments) {
    const inReview = shield.wholeLoan || shield.ids.has(inst.id)
    if (inReview) shieldedSet.add(inst.id)
    const status = deriveInstalmentStatus(inst, { today, inReview })
    if (status !== inst.status) {
      await tx.loanInstalment.update({ where: { id: inst.id }, data: { status } })
    }
  }

  const quote = computeSettlementQuote(loan.instalments)
  let totalRepaid = ZERO
  for (const i of loan.instalments) totalRepaid = totalRepaid.plus(instalmentOutstanding(i).paid)

  const nextStatus = deriveLoanStatus({
    currentStatus: loan.status,
    instalments: loan.instalments,
    today,
    shieldedInstalments: shieldedSet,
  })

  const data: Prisma.LoanUpdateManyMutationInput = { outstandingBalance: quote.total, totalRepaid }
  if (nextStatus !== loan.status) {
    await transition(tx.loan, loan.id, [loan.status], {
      ...data,
      status: nextStatus,
      ...(nextStatus === LoanStatus.COMPLETED
        ? {
            completedAt: new Date(),
            actualRepaymentDate: params.valueDate ? parseDateOnly(params.valueDate) : parseDateOnly(today),
          }
        : {}),
    })
    if (nextStatus === LoanStatus.COMPLETED) {
      await releaseLoanGuarantees(tx, loan.id, 'Loan fully repaid')
    }
    await recordAuditEvent(
      {
        actorId: params.actorId ?? null,
        affectedUserId: loan.userId,
        action: nextStatus === LoanStatus.COMPLETED ? AuditAction.LOAN_COMPLETED : AuditAction.LOAN_STATUS_CHANGED,
        entityType: 'Loan',
        entityId: loan.id,
        outcome: AuditOutcome.SUCCESS,
        beforeState: { status: loan.status },
        afterState: { status: nextStatus },
        metadata: { loanId: loan.id },
      },
      tx,
    )
  } else {
    await tx.loan.update({ where: { id: loan.id }, data })
  }

  await recomputeApplicantLoanReservations(tx, loan.userId)
  return tx.loan.findUnique({ where: { id: loan.id } })
}

// ---------------------------------------------------------------------------
// Application fee (A-14)
// ---------------------------------------------------------------------------

/** Outstanding amount of a fee assessment = amount − active FEE allocations. */
export async function getFeeOutstanding(tx: Tx | typeof prisma, feeAssessmentId: string) {
  const fee = await tx.feeAssessment.findUnique({ where: { id: feeAssessmentId } })
  if (!fee) throw err('INVALID_TARGET', 'Fee not found.')
  const paid = await tx.paymentAllocation.aggregate({
    where: {
      targetType: AllocationTargetType.FEE,
      targetId: fee.id,
      status: AllocationStatus.ACTIVE,
    },
    _sum: { amount: true },
  })
  const outstanding =
    fee.status === FeeStatus.PENDING
      ? Prisma.Decimal.max(ZERO, fee.amount.minus(paid._sum.amount ?? ZERO))
      : ZERO
  return { fee, outstanding }
}

/** Marks a fee PAID once its active allocations cover it (status derived from allocations). */
export async function refreshFeeAssessment(tx: Tx, feeAssessmentId: string, actorId?: string | null) {
  const { fee, outstanding } = await getFeeOutstanding(tx, feeAssessmentId)
  if (fee.status !== FeeStatus.PENDING || outstanding.gt(0)) return fee
  const lastAlloc = await tx.paymentAllocation.findFirst({
    where: { targetType: AllocationTargetType.FEE, targetId: fee.id, status: AllocationStatus.ACTIVE },
    orderBy: { createdAt: 'desc' },
  })
  const res = await tx.feeAssessment.updateMany({
    where: { id: fee.id, status: FeeStatus.PENDING },
    data: { status: FeeStatus.PAID, paymentAllocationId: lastAlloc?.id ?? null },
  })
  if (res.count === 1) {
    await recordAuditEvent(
      {
        actorId: actorId ?? null,
        affectedUserId: fee.memberId,
        action: AuditAction.LOAN_FEE_PAID,
        entityType: 'FeeAssessment',
        entityId: fee.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: { loanId: fee.targetId, amount: fee.amount.toString() },
      },
      tx,
    )
  }
  return tx.feeAssessment.findUniqueOrThrow({ where: { id: fee.id } })
}

// ---------------------------------------------------------------------------
// Paying from the wallet (§2.11, D-11, D-12)
// ---------------------------------------------------------------------------

async function nextPaymentNumber(tx: Tx) {
  await lockSequence(tx, 'PAY')
  const last = await tx.payment.findFirst({ orderBy: { paymentNumber: 'desc' }, select: { paymentNumber: true } })
  return formatSequentialNumber('PAY', nextSequenceAfter(last?.paymentNumber))
}

async function createWalletPayment(
  tx: Tx,
  params: {
    memberId: string
    idempotencyKey: string
    allocations: CalculatedAllocation[]
    description: string
    sourceRef: { type: string; id: string }
  },
) {
  const total = params.allocations.reduce((s, a) => s.plus(roundMoney(a.amount)), ZERO)
  const valueDate = parseDateOnly(lagosToday())
  const payment = await tx.payment.create({
    data: {
      paymentNumber: await nextPaymentNumber(tx),
      source: PaymentSource.WALLET,
      memberId: params.memberId,
      totalConfirmedAmount: total,
      valueDate,
      status: PaymentStatus.CONFIRMED,
      confirmedById: params.memberId,
      idempotencyKey: params.idempotencyKey,
    },
  })
  const lines: JournalLineInput[] = [
    {
      accountType: LedgerAccountType.MEMBER_WALLET_LIABILITY,
      debit: total,
      credit: 0,
      memberId: params.memberId,
      accountRefType: 'WALLET',
      accountRefId: params.memberId,
    },
  ]
  for (const a of params.allocations) {
    const accountType =
      a.targetType === AllocationTargetType.FEE
        ? LedgerAccountType.FEE_INCOME
        : a.componentType === PaymentComponentType.PENALTY
          ? LedgerAccountType.LOAN_PENALTY_RECEIVABLE
          : a.componentType === PaymentComponentType.INTEREST
            ? LedgerAccountType.LOAN_INTEREST_RECEIVABLE
            : LedgerAccountType.LOAN_RECEIVABLE_PRINCIPAL
    lines.push({
      accountType,
      debit: 0,
      credit: roundMoney(a.amount),
      memberId: params.memberId,
      accountRefType: a.targetType,
      accountRefId: a.targetId,
    })
  }
  const journal = await postJournalEntry(tx, {
    sourceType: 'PAYMENT',
    sourceId: payment.id,
    idempotencyKey: `payment:${params.idempotencyKey}`,
    description: params.description,
    effectiveDate: valueDate,
    postedById: params.memberId,
    lines,
  })
  for (const a of params.allocations) {
    await tx.paymentAllocation.create({
      data: {
        paymentId: payment.id,
        targetType: a.targetType,
        targetId: a.targetId,
        periodId: a.periodId,
        componentType: a.componentType,
        amount: roundMoney(a.amount),
        status: AllocationStatus.ACTIVE,
        journalEntryId: journal.id,
      },
    })
  }
  return { payment, journalEntryId: journal.id, total, valueDate }
}

/**
 * Member pays a loan from their wallet: due/future instalments oldest first
 * (penalty → interest → principal), or the whole settlement quote when the
 * amount equals it (§2.11). Amount ≤ outstanding and ≤ available wallet.
 * Idempotent per idempotencyKey. P3-06's applyWallet may route through here.
 */
export async function payLoanFromWallet(params: {
  memberId: string
  loanId: string
  amount: DecimalValue
  idempotencyKey: string
}) {
  const amount = roundMoney(params.amount)
  if (amount.lte(0)) throw err('VALIDATION_ERROR', 'The amount must be greater than zero.', 400)
  const key = `wallet-loan:${params.loanId}:${params.idempotencyKey}`

  return loanTransaction(async (tx) => {
    await lockMembers(tx, [params.memberId])
    const existing = await tx.payment.findUnique({ where: { idempotencyKey: key } })
    if (existing) return { payment: existing, isReplay: true }

    const loan = await tx.loan.findUnique({ where: { id: params.loanId } })
    if (!loan || loan.userId !== params.memberId) throw err('NOT_FOUND', 'Loan not found.', 404)
    if (!LOAN_REPAYABLE_STATUSES.includes(loan.status)) {
      throw err('INVALID_STATE', 'Only a disbursed, unfinished loan can be repaid.')
    }
    const today = lagosToday()
    await recalculateLatenessInTx(tx, {
      obligationType: 'LOAN',
      obligationId: loan.id,
      asOf: today,
      actorId: params.memberId,
    })
    const periods = await getLoanAllocationPeriods(tx, { memberId: params.memberId, loanId: loan.id })
    const outstanding = periods.reduce(
      (s, p) => s.plus(p.penaltyDue).plus(p.interestDue).plus(p.principalDue),
      ZERO,
    )
    if (amount.gt(roundMoney(outstanding))) {
      throw err('AMOUNT_EXCEEDS_OUTSTANDING', `The loan has only ₦${roundMoney(outstanding).toFixed(2)} outstanding.`)
    }
    const wallet = await getWalletSummary(params.memberId, tx)
    if (amount.gt(wallet.availableBalance)) {
      throw err(
        'INSUFFICIENT_WALLET_BALANCE',
        `Your available wallet balance is ₦${wallet.availableBalance.toFixed(2)}.`,
      )
    }

    const allocation = calculatePaymentAllocation({
      amount: amount.toNumber(),
      memberId: params.memberId,
      periods,
    })
    const allocations = allocation.allocations.filter((a) => a.targetType === AllocationTargetType.LOAN)
    const { payment, journalEntryId, valueDate } = await createWalletPayment(tx, {
      memberId: params.memberId,
      idempotencyKey: key,
      allocations,
      description: `Loan repayment from wallet`,
      sourceRef: { type: 'LOAN', id: loan.id },
    })
    for (const a of allocations) await applyLoanAllocation(tx, a)
    await recalculateLatenessInTx(tx, {
      obligationType: 'LOAN',
      obligationId: loan.id,
      asOf: valueDate,
      actorId: params.memberId,
    })

    await recordAuditEvent(
      {
        actorId: params.memberId,
        actorRole: UserRole.USER,
        affectedUserId: params.memberId,
        action: AuditAction.LOAN_REPAID,
        entityType: 'Payment',
        entityId: payment.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: { loanId: loan.id, amount: amount.toString(), source: 'WALLET', journalEntryId },
      },
      tx,
    )
    const updatedLoan = await refreshLoanAfterPayment(tx, loan.id, {
      actorId: params.memberId,
      valueDate,
    })
    return { payment, loan: updatedLoan, isReplay: false }
  })
}

/** Member pays the loan application fee from their wallet (A-14). */
export async function payLoanFeeFromWallet(params: { memberId: string; loanId: string }) {
  return loanTransaction(async (tx) => {
    await lockMembers(tx, [params.memberId])
    const fee = await tx.feeAssessment.findFirst({
      where: { feeType: FeeType.LOAN_APPLICATION, targetId: params.loanId, memberId: params.memberId },
      orderBy: { assessedAt: 'desc' },
    })
    if (!fee) throw err('NOT_FOUND', 'There is no application fee for this loan.', 404)
    const { outstanding } = await getFeeOutstanding(tx, fee.id)
    if (outstanding.lte(0)) throw err('INVALID_STATE', 'The application fee is already settled.')
    const wallet = await getWalletSummary(params.memberId, tx)
    if (outstanding.gt(wallet.availableBalance)) {
      throw err('INSUFFICIENT_WALLET_BALANCE', `Your available wallet balance is ₦${wallet.availableBalance.toFixed(2)}.`)
    }
    const { payment } = await createWalletPayment(tx, {
      memberId: params.memberId,
      idempotencyKey: `wallet-fee:${fee.id}`,
      allocations: [
        {
          targetType: AllocationTargetType.FEE,
          targetId: fee.id,
          periodId: null,
          componentType: PaymentComponentType.FEE,
          amount: outstanding.toNumber(),
        },
      ],
      description: 'Loan application fee paid from wallet',
      sourceRef: { type: 'FEE', id: fee.id },
    })
    const updatedFee = await refreshFeeAssessment(tx, fee.id, params.memberId)
    return { payment, fee: updatedFee }
  })
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getLoanSettlementQuote(loanId: string): Promise<SettlementQuote> {
  const instalments = await prisma.loanInstalment.findMany({ where: { loanId } })
  return computeSettlementQuote(instalments)
}

/** Everything the reviewer needs on one screen (P3-04 "Admin review"). */
export async function getLoanReviewContext(loanId: string) {
  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: {
      guaranteeReservations: {
        where: { guaranteeType: GuaranteeType.LOAN },
        orderBy: { createdAt: 'desc' },
        include: { guarantor: { select: { id: true, name: true, email: true } } },
      },
      offerAcceptance: true,
    },
  })
  if (!loan) return null
  const guarantee = activeGuarantee(loan.guaranteeReservations)
  const eligibility = await getLoanEligibilitySummary(
    loan.userId,
    guarantee?.guarantorId ?? null,
  )
  const otherLoans = await prisma.loan.findMany({
    where: { userId: loan.userId, id: { not: loan.id } },
    select: {
      id: true,
      status: true,
      requestedAmount: true,
      approvedAmount: true,
      duration: true,
      createdAt: true,
      outstandingBalance: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  const lien = evaluateOwnSavingsLien(
    [...otherLoans, { status: loan.status }].map((l) => ({ status: l.status })),
  )
  const fee = await prisma.feeAssessment.findFirst({
    where: { feeType: FeeType.LOAN_APPLICATION, targetId: loan.id },
    orderBy: { assessedAt: 'desc' },
  })
  const feeOutstanding = fee ? (await getFeeOutstanding(prisma, fee.id)).outstanding : ZERO
  const support =
    loan.status === LoanStatus.PENDING
      ? await computeLoanSupportNeeded({ applicantId: loan.userId, loanId: loan.id, principal: loan.requestedAmount })
      : null
  const overdueInstalments = await prisma.loanInstalment.count({
    where: { loan: { userId: loan.userId }, status: 'OVERDUE' },
  })
  return {
    eligibility,
    support,
    guarantee,
    lien,
    otherLoans,
    fee,
    feeOutstanding,
    overdueInstalments,
    exposureStatuses: LOAN_EXPOSURE_STATUSES,
  }
}

export const LOAN_OFFER_STATUSES = [LoanStatus.APPROVED, LoanStatus.AWAITING_RECONSENT] as const
export { LOAN_PRE_DISBURSEMENT_STATUSES, dateOnlyString }
