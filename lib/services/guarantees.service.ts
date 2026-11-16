import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import {
  EAjoMemberStatus,
  GuaranteeState,
  GuaranteeType,
  LoanStatus,
  SavingsStatus,
  UserRole,
} from '@/generated/prisma/enums'
import { AppError } from '@/lib/errors/app-error'
import { toDecimal } from '@/lib/domain/money'
import { lockMembers } from '@/lib/db/concurrency'
import {
  calculateEAjoAdvanceExposure,
  checkGuarantorEligibility,
  evaluateOwnSavingsLien,
} from '@/lib/domain/capacity'
import { createAndStoreConsentEvidence } from './guarantor-evidence.service'
import { computeLoanSupportNeeded } from './loan-capacity.service'
import { LOAN_PRE_DISBURSEMENT_STATUSES } from '@/lib/domain/loan-workflow'

/**
 * Returns total confirmed active savings principal eligible to support lending (§2.1).
 * Excludes wallet balances, accrued interest, unconfirmed receipts, and inactive plans.
 */
export async function getMemberEligibleSavingsPrincipal(
  memberId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Prisma.Decimal> {
  const activeSavings = await tx.savings.findMany({
    where: {
      userId: memberId,
      // P3-03: matured-but-unwithdrawn principal is still held as savings (and locked, A-04);
      // WITHDRAWAL_PENDING principal is frozen and excluded.
      status: { in: [SavingsStatus.ACTIVE, SavingsStatus.MATURED] },
    },
    select: { currentBalance: true },
  })

  let total = new Prisma.Decimal(0)
  for (const s of activeSavings) {
    total = total.plus(s.currentBalance)
  }
  return total
}

/**
 * Returns sum of active and consented guarantee reservations held against a guarantor (§2.1).
 */
export async function getGuarantorActiveReservations(
  guarantorId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
  excludeReservationId?: string,
): Promise<Prisma.Decimal> {
  const reservations = await tx.guaranteeReservation.findMany({
    where: {
      guarantorId,
      id: excludeReservationId ? { not: excludeReservationId } : undefined,
      state: {
        in: [
          GuaranteeState.PENDING,
          GuaranteeState.CONSENTED,
          // P3-04: a guarantee awaiting re-consent keeps holding its reservation
          GuaranteeState.AWAITING_RECONSENT,
        ],
      },
    },
    select: { reservedAmount: true, requestedAmount: true, state: true },
  })

  let total = new Prisma.Decimal(0)
  for (const r of reservations) {
    // For CONSENTED / AWAITING_RECONSENT use reservedAmount; for PENDING, conservative reservation equals requested
    const amount =
      r.state === GuaranteeState.PENDING ? r.requestedAmount : r.reservedAmount
    total = total.plus(amount)
  }
  return total
}

/**
 * Returns unencumbered savings principal available for new guarantees or borrowing (§2.1).
 */
export async function getMemberUnencumberedSavings(
  memberId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
  excludeReservationId?: string,
): Promise<Prisma.Decimal> {
  const eligible = await getMemberEligibleSavingsPrincipal(memberId, tx)
  const reserved = await getGuarantorActiveReservations(
    memberId,
    tx,
    excludeReservationId,
  )
  return Prisma.Decimal.max(0, eligible.minus(reserved))
}

export interface RequestLoanGuarantorParams {
  loanId: string
  applicantId: string
  guarantorId: string
  requestedAmount: Prisma.Decimal | string | number
  termMonths: number
  monthlyInterestRate: Prisma.Decimal | string | number
  penaltyTerms?: string
  termsVersion?: number
}

/**
 * Creates a loan guarantor request under PostgreSQL advisory locks (§2.1, §2.7).
 */
export async function requestLoanGuarantor(
  tx: Prisma.TransactionClient,
  params: RequestLoanGuarantorParams,
) {
  // 1. Transaction-scoped advisory locks on applicant and guarantor in lexicographical order
  await lockMembers(tx, [params.applicantId, params.guarantorId])

  // 2. Fetch guarantor user details
  const guarantor = await tx.user.findUnique({
    where: { id: params.guarantorId },
    select: { id: true, name: true, email: true, role: true, isActive: true },
  })

  if (!guarantor) {
    throw new AppError('NOT_FOUND', 'Guarantor account not found.', {
      statusCode: 404,
    })
  }

  const guarantorUnencumbered = await getMemberUnencumberedSavings(
    params.guarantorId,
    tx,
  )

  // 3. Verify eligibility
  const eligibility = checkGuarantorEligibility({
    guarantorId: params.guarantorId,
    applicantId: params.applicantId,
    role: guarantor.role,
    isActive: guarantor.isActive,
    eligibleUnencumberedSavings: guarantorUnencumbered,
  })

  if (!eligibility.eligible) {
    throw new AppError(
      'GUARANTOR_INELIGIBLE',
      eligibility.reason || 'Guarantor is not eligible.',
      { statusCode: 422 },
    )
  }

  // 4. Calculate required guarantee support (portfolio-wide, principal only; §2.1, P3-04)
  const { needed: additionalSupportNeeded } = await computeLoanSupportNeeded(
    {
      applicantId: params.applicantId,
      loanId: params.loanId,
      principal: params.requestedAmount,
    },
    tx,
  )

  if (additionalSupportNeeded.gt(guarantorUnencumbered)) {
    const deficit = additionalSupportNeeded.minus(guarantorUnencumbered)
    throw new AppError(
      'CAPACITY_EXCEEDED',
      `Guarantor has insufficient free capacity. Available: ₦${guarantorUnencumbered.toFixed(2)}, Needed: ₦${additionalSupportNeeded.toFixed(2)} (Deficit: ₦${deficit.toFixed(2)}).`,
      { statusCode: 422 },
    )
  }

  // 5. Create or update GuaranteeReservation
  const reservation = await tx.guaranteeReservation.upsert({
    where: {
      loanId_guarantorId: {
        loanId: params.loanId,
        guarantorId: params.guarantorId,
      },
    },
    create: {
      guaranteeType: GuaranteeType.LOAN,
      guarantorId: params.guarantorId,
      applicantId: params.applicantId,
      loanId: params.loanId,
      requestedAmount: additionalSupportNeeded,
      consentedAmount: new Prisma.Decimal(0),
      reservedAmount: new Prisma.Decimal(0),
      state: GuaranteeState.PENDING,
      termMonths: params.termMonths,
      monthlyInterestRate: toDecimal(params.monthlyInterestRate),
      penaltyTerms: params.penaltyTerms,
      termsVersion: params.termsVersion || 1,
    },
    update: {
      requestedAmount: additionalSupportNeeded,
      consentedAmount: new Prisma.Decimal(0),
      reservedAmount: new Prisma.Decimal(0),
      state: GuaranteeState.PENDING,
      termMonths: params.termMonths,
      monthlyInterestRate: toDecimal(params.monthlyInterestRate),
      penaltyTerms: params.penaltyTerms,
      termsVersion: (params.termsVersion || 1) + 1,
    },
  })

  return reservation
}

export interface RequestEAjoGuarantorParams {
  eajoMemberId: string
  applicantId: string
  guarantorId: string
  slotNumber: number
  totalSlots: number
  monthlyContribution: Prisma.Decimal | string | number
  termsVersion?: number
}

/**
 * Creates an E-Ajo advance guarantor request under PostgreSQL advisory locks (§2.1).
 */
export async function requestEAjoGuarantor(
  tx: Prisma.TransactionClient,
  params: RequestEAjoGuarantorParams,
) {
  if (params.applicantId === params.guarantorId) {
    throw new AppError(
      'INVALID_GUARANTOR',
      'You cannot act as your own guarantor (§2.1).',
      { statusCode: 422 },
    )
  }

  await lockMembers(tx, [params.applicantId, params.guarantorId])

  const guarantor = await tx.user.findUnique({
    where: { id: params.guarantorId },
    select: { id: true, role: true, isActive: true },
  })

  const guarantorUnencumbered = await getMemberUnencumberedSavings(
    params.guarantorId,
    tx,
  )

  const eligibility = checkGuarantorEligibility({
    applicantId: params.applicantId,
    guarantorId: params.guarantorId,
    role: guarantor?.role || UserRole.USER,
    isActive: guarantor?.isActive ?? false,
    eligibleUnencumberedSavings: guarantorUnencumbered,
  })

  if (!eligibility.eligible) {
    throw new AppError(
      'INELIGIBLE_GUARANTOR',
      eligibility.reason || 'Guarantor is not eligible.',
      { statusCode: 422 },
    )
  }

  const advanceExposure = calculateEAjoAdvanceExposure({
    payoutPosition: params.slotNumber,
    totalSlots: params.totalSlots,
    contributionAmount: params.monthlyContribution,
  })

  if (guarantorUnencumbered.lt(advanceExposure)) {
    const deficit = advanceExposure.minus(guarantorUnencumbered)
    throw new AppError(
      'CAPACITY_EXCEEDED',
      `Guarantor has insufficient free capacity. Available: ₦${guarantorUnencumbered.toFixed(2)}, Needed: ₦${advanceExposure.toFixed(2)} (Deficit: ₦${deficit.toFixed(2)}).`,
      { statusCode: 422 },
    )
  }

  const reservation = await tx.guaranteeReservation.upsert({
    where: {
      eajoMemberId_guarantorId: {
        eajoMemberId: params.eajoMemberId,
        guarantorId: params.guarantorId,
      },
    },
    create: {
      guaranteeType: GuaranteeType.EAJO,
      guarantorId: params.guarantorId,
      applicantId: params.applicantId,
      eajoMemberId: params.eajoMemberId,
      requestedAmount: advanceExposure,
      consentedAmount: new Prisma.Decimal(0),
      reservedAmount: new Prisma.Decimal(0),
      state: GuaranteeState.PENDING,
      termsVersion: params.termsVersion || 1,
    },
    update: {
      requestedAmount: advanceExposure,
      consentedAmount: new Prisma.Decimal(0),
      reservedAmount: new Prisma.Decimal(0),
      state: GuaranteeState.PENDING,
      termsVersion: (params.termsVersion || 1) + 1,
    },
  })

  return reservation
}

export interface DecideGuarantorRequestParams {
  reservationId: string
  guarantorId: string
  decision: 'ACCEPT' | 'DECLINE'
  reason?: string
}

/**
 * Processes a guarantor's explicit Accept or Decline decision with PDF evidence generation (§2.7).
 */
export async function decideGuarantorRequest(
  tx: Prisma.TransactionClient,
  params: DecideGuarantorRequestParams,
) {
  const reservation = await tx.guaranteeReservation.findUnique({
    where: { id: params.reservationId },
    include: {
      applicant: { select: { id: true, name: true, email: true } },
      guarantor: { select: { id: true, name: true, email: true } },
      loan: true,
      eajoMember: true,
    },
  })

  if (!reservation) {
    throw new AppError('NOT_FOUND', 'Guarantee request not found.', {
      statusCode: 404,
    })
  }

  if (reservation.guarantorId !== params.guarantorId) {
    throw new AppError(
      'FORBIDDEN',
      'You are not authorised to decide this guarantee request.',
      { statusCode: 403 },
    )
  }

  if (
    reservation.state !== GuaranteeState.PENDING &&
    reservation.state !== GuaranteeState.AWAITING_RECONSENT
  ) {
    throw new AppError(
      'INVALID_STATE',
      `Guarantee request cannot be decided in state ${reservation.state}.`,
      { statusCode: 422 },
    )
  }

  // Lock both applicant and guarantor atomically
  await lockMembers(tx, [reservation.applicantId, reservation.guarantorId])

  if (params.decision === 'DECLINE') {
    // Generate decline evidence PDF
    const evidence = await createAndStoreConsentEvidence({
      evidenceType:
        reservation.guaranteeType === GuaranteeType.LOAN
          ? 'LOAN_GUARANTEE'
          : 'EAJO_GUARANTEE',
      applicationId: reservation.loanId || reservation.eajoMemberId || reservation.id,
      borrower: reservation.applicant,
      guarantor: reservation.guarantor,
      consentedTerms: {
        amount: reservation.requestedAmount.toNumber(),
        termMonths: reservation.termMonths || undefined,
        monthlyInterestRate: reservation.monthlyInterestRate?.toNumber(),
        termsVersion: reservation.termsVersion,
        penaltyTerms: reservation.penaltyTerms || undefined,
      },
      decision: 'DECLINED',
      decisionReason: params.reason,
      uploadedById: params.guarantorId,
    })

    const updated = await tx.guaranteeReservation.update({
      where: { id: reservation.id },
      data: {
        state: GuaranteeState.DECLINED,
        reservedAmount: new Prisma.Decimal(0),
        decisionReason: params.reason || null,
        evidenceCloudinaryPublicId: evidence.publicId,
        evidenceDocumentId: evidence.documentId,
        evidenceSha256: evidence.sha256,
      },
    })

    return { reservation: updated, evidence }
  }

  // ACCEPT FLOW: Re-evaluate capacity atomically inside lock (§2.1)
  const guarantorUnencumbered = await getMemberUnencumberedSavings(
    params.guarantorId,
    tx,
    reservation.id,
  )

  let neededSupport = reservation.requestedAmount
  let loanPrincipal = reservation.requestedAmount

  if (reservation.guaranteeType === GuaranteeType.LOAN) {
    // P3-04: consent is only possible while the application or re-consent offer is open
    if (
      !reservation.loan ||
      (reservation.loan.status !== LoanStatus.PENDING &&
        reservation.loan.status !== LoanStatus.AWAITING_RECONSENT)
    ) {
      throw new AppError(
        'INVALID_STATE',
        'This loan application is no longer awaiting your consent.',
        { statusCode: 422 },
      )
    }
    loanPrincipal = reservation.loan.approvedAmount || reservation.loan.requestedAmount
    const support = await computeLoanSupportNeeded(
      {
        applicantId: reservation.applicantId,
        loanId: reservation.loan.id,
        principal: loanPrincipal,
      },
      tx,
    )
    neededSupport = support.needed
  } else {
    // E-Ajo guarantee: requestedAmount already holds the advance exposure c × (N − s)
    // computed by requestEAjoGuarantor (§2.1, §2.8), so it is the support needed.
    neededSupport = reservation.requestedAmount
  }

  if (neededSupport.gt(guarantorUnencumbered)) {
    const deficit = neededSupport.minus(guarantorUnencumbered)
    throw new AppError(
      'CAPACITY_EXCEEDED',
      `Cannot accept guarantee: insufficient free capacity. Available: ₦${guarantorUnencumbered.toFixed(2)}, Needed: ₦${neededSupport.toFixed(2)} (Deficit: ₦${deficit.toFixed(2)}).`,
      { statusCode: 422 },
    )
  }

  // Generate accept evidence PDF
  const evidence = await createAndStoreConsentEvidence({
    evidenceType:
      reservation.guaranteeType === GuaranteeType.LOAN
        ? 'LOAN_GUARANTEE'
        : 'EAJO_GUARANTEE',
    applicationId: reservation.loanId || reservation.eajoMemberId || reservation.id,
    borrower: reservation.applicant,
    guarantor: reservation.guarantor,
    consentedTerms: {
      amount: loanPrincipal.toNumber(),
      termMonths: reservation.termMonths || undefined,
      monthlyInterestRate: reservation.monthlyInterestRate?.toNumber(),
      termsVersion: reservation.termsVersion,
      penaltyTerms: reservation.penaltyTerms || undefined,
    },
    decision: 'ACCEPTED',
    decisionReason: params.reason,
    uploadedById: params.guarantorId,
  })

  const updated = await tx.guaranteeReservation.update({
    where: { id: reservation.id },
    data: {
      state: GuaranteeState.CONSENTED,
      consentedAmount: loanPrincipal,
      reservedAmount: neededSupport,
      consentedAt: new Date(),
      decisionReason: params.reason || null,
      evidenceCloudinaryPublicId: evidence.publicId,
      evidenceDocumentId: evidence.documentId,
      evidenceSha256: evidence.sha256,
    },
  })

  return { reservation: updated, evidence }
}

export interface WithdrawGuarantorConsentParams {
  reservationId: string
  guarantorId: string
  reason?: string
}

/**
 * Guarantor unilaterally withdraws consent before loan disbursement or e-ajo activation (§2.7).
 */
export async function withdrawGuarantorConsent(
  tx: Prisma.TransactionClient,
  params: WithdrawGuarantorConsentParams,
) {
  const reservation = await tx.guaranteeReservation.findUnique({
    where: { id: params.reservationId },
    include: { loan: true, eajoMember: true },
  })

  if (!reservation) {
    throw new AppError('NOT_FOUND', 'Guarantee record not found.', {
      statusCode: 404,
    })
  }

  if (reservation.guarantorId !== params.guarantorId) {
    throw new AppError('FORBIDDEN', 'Not authorised.', { statusCode: 403 })
  }

  if (
    reservation.state !== GuaranteeState.PENDING &&
    reservation.state !== GuaranteeState.CONSENTED &&
    reservation.state !== GuaranteeState.AWAITING_RECONSENT
  ) {
    throw new AppError(
      'INVALID_STATE',
      `Guarantee in state ${reservation.state} cannot be withdrawn.`,
      { statusCode: 422 },
    )
  }

  // Check that application is NOT yet disbursed or activated (P3-04: only before disbursement)
  if (reservation.loan) {
    if (!LOAN_PRE_DISBURSEMENT_STATUSES.includes(reservation.loan.status)) {
      throw new AppError(
        'FORBIDDEN',
        'Cannot revoke guarantee after the loan has been disbursed. A replacement guarantor must be approved.',
        { statusCode: 403 },
      )
    }
  }

  // E-ajo: once the group has activated the guarantee cannot be revoked unilaterally (§2.7)
  if (
    reservation.eajoMember &&
    reservation.eajoMember.status !== EAjoMemberStatus.PENDING &&
    reservation.eajoMember.status !== EAjoMemberStatus.APPROVED
  ) {
    throw new AppError(
      'FORBIDDEN',
      'Cannot revoke an e-ajo guarantee after the group has been activated. A replacement guarantor must be approved.',
      { statusCode: 403 },
    )
  }

  if (
    reservation.eajoMember &&
    reservation.state !== GuaranteeState.PENDING &&
    reservation.state !== GuaranteeState.CONSENTED
  ) {
    throw new AppError(
      'INVALID_STATE',
      `Guarantee cannot be withdrawn in state ${reservation.state}.`,
      { statusCode: 422 },
    )
  }

  await lockMembers(tx, [reservation.applicantId, params.guarantorId])

  const updated = await tx.guaranteeReservation.update({
    where: { id: reservation.id },
    data: {
      state: GuaranteeState.WITHDRAWN_BEFORE_ACTIVATION,
      reservedAmount: new Prisma.Decimal(0),
      withdrawnAt: new Date(),
      decisionReason: params.reason || 'Withdrawn by guarantor before activation',
    },
  })

  return updated
}

/**
 * Asserts that a savings withdrawal request does not violate the own-savings lock
 * or dip into guarantor-reserved savings (§2.1, D-02).
 */
export async function assertSavingsWithdrawalAllowed(
  tx: Prisma.TransactionClient,
  params: {
    memberId: string
    withdrawalAmount: Prisma.Decimal | string | number
  },
): Promise<void> {
  await lockMembers(tx, [params.memberId])

  // 1. Check own-savings lock (FULL lien mode)
  const activeLoans = await tx.loan.findMany({
    where: { userId: params.memberId },
    select: { status: true, approvedAmount: true, requestedAmount: true },
  })

  const lienResult = evaluateOwnSavingsLien(activeLoans)
  if (lienResult.isLocked) {
    throw new AppError(
      'OWN_SAVINGS_LOCKED',
      lienResult.reason ||
        'Savings withdrawal refused: all confirmed savings principal is locked while you have an active or approved loan (D-02).',
      { statusCode: 422 },
    )
  }

  // 2. Check guarantor reservation encumbrances
  const eligibleSavings = await getMemberEligibleSavingsPrincipal(
    params.memberId,
    tx,
  )
  const activeReservations = await getGuarantorActiveReservations(
    params.memberId,
    tx,
  )
  const unencumberedSavings = Prisma.Decimal.max(
    0,
    eligibleSavings.minus(activeReservations),
  )

  const requested = toDecimal(params.withdrawalAmount)
  if (requested.gt(unencumberedSavings)) {
    throw new AppError(
      'SAVINGS_ENCUMBERED',
      `Withdrawal amount of ₦${requested.toFixed(2)} exceeds your unencumbered savings principal of ₦${unencumberedSavings.toFixed(2)}. ₦${activeReservations.toFixed(2)} is currently reserved to secure active guarantees.`,
      { statusCode: 422 },
    )
  }
}
