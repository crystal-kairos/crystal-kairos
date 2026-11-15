import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@/generated/prisma/client'
import {
  AdminPermission,
  AllocationTargetType,
  BorrowerOfferDecision,
  FeeStatus,
  GuaranteeState,
  LedgerAccountType,
  LoanStatus,
  PaymentPeriodStatus,
  PenaltyCapType,
  SavingsFrequency,
  SavingsStatus,
  SavingsType,
  UserRole,
} from '@/generated/prisma/enums'

const mockSession = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; sessionVersion: number } },
}))
vi.mock('@/auth', () => ({ auth: vi.fn(async () => mockSession.session) }))

// The P3-01 profile gate is covered in registration-profile-gates.test.ts.
vi.mock('@/lib/services/profile.service', async (orig) => ({
  ...(await orig<typeof import('@/lib/services/profile.service')>()),
  assertProductEligibility: vi.fn(async () => {}),
}))

// Loan term rates and the fee are global settings; isolate them from other suites.
const settings = vi.hoisted(() => ({ loanApplicationFee: 0 as number }))
vi.mock('@/lib/services/society-settings.service', async (orig) => {
  const actual = await orig<typeof import('@/lib/services/society-settings.service')>()
  return {
    ...actual,
    getSocietySetting: vi.fn(async (key: string, fallback?: unknown) =>
      key === 'loanApplicationFee' ? settings.loanApplicationFee : actual.getSocietySetting(key as never, fallback as never),
    ),
  }
})
vi.mock('@/lib/services/rate-policy.service', async (orig) => {
  const actual = await orig<typeof import('@/lib/services/rate-policy.service')>()
  const { Prisma: P } = await import('@/generated/prisma/client')
  const rate = (m: number) => ({
    durationMonths: m,
    monthlyInterestPercent: new P.Decimal(m === 3 ? 4 : 5),
    latePenaltyDailyPercent: new P.Decimal('0.5'),
    penaltyCapType: 'PERCENT_OF_PRINCIPAL' as const,
    penaltyCapValue: new P.Decimal(10),
    version: 7,
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
  })
  return {
    ...actual,
    getActiveLoanRateForDuration: vi.fn(async (m: number) => ([3, 6].includes(m) ? rate(m) : null)),
    getActiveLoanTermRates: vi.fn(async () => [rate(3), rate(6)]),
  }
})

import { prisma } from '@/lib/prisma'
import { lagosToday, addMonthsClamped, formatDateOnly } from '@/lib/domain/dates'
import { postWalletCredit } from '@/lib/services/ledger.service'
import { assertSavingsWithdrawalAllowed } from '@/lib/services/guarantees.service'
import { getApplicantLoanExposure } from '@/lib/services/loan-capacity.service'
import {
  confirmPaymentSubmission,
  createPaymentSubmission,
  rejectPaymentSubmission,
} from '@/lib/services/payments.service'
import { refreshLoanAfterPayment } from '@/lib/services/loans.service'
import { getWalletBalance } from '@/lib/services/wallet.service'
import { runLoanOfferExpiryJob } from '@/lib/jobs/loan-offers.job'
import {
  acceptLoanOfferAction,
  applyForLoanAction,
  cancelLoanApplicationAction,
  declineLoanOfferAction,
  decideGuarantorRequestAction,
  payLoanFeeFromWalletAction,
  payLoanFromWalletAction,
} from '@/models/loans/actions'
import { approveLoanAction, disburseLoanAction, rejectLoanAction } from '@/models/admin/loanActions'

const prefix = `p304-${Date.now()}`
const createdUserIds: string[] = []

type TestUser = { id: string; email: string; name: string; role: UserRole }

async function createUser(suffix: string, role: UserRole = UserRole.USER, savings = 0): Promise<TestUser> {
  const user = await prisma.user.create({
    data: {
      email: `${prefix}-${suffix}@example.test`,
      name: `P304 ${suffix}`,
      role,
      sessionVersion: 1,
      mfaEnabled: role !== UserRole.USER,
    },
  })
  createdUserIds.push(user.id)
  if (savings > 0) {
    await prisma.savings.create({
      data: {
        userId: user.id,
        savingsType: SavingsType.REGULAR,
        frequency: SavingsFrequency.MONTHLY,
        durationMonths: 12,
        targetAmount: new Prisma.Decimal(savings),
        currentBalance: new Prisma.Decimal(savings),
        totalDeposited: new Prisma.Decimal(savings),
        status: SavingsStatus.ACTIVE,
        ratePercentSnapshot: new Prisma.Decimal(5),
        rateVersionSnapshot: 1,
      },
    })
  }
  if (role === UserRole.USER) {
    await prisma.bankAccount.create({
      data: {
        userId: user.id,
        bankName: 'Test Bank',
        bankCode: '999',
        accountNumber: String(Math.floor(1e9 + Math.random() * 8e9)),
        accountName: user.name,
        isPrimary: true,
        isVerified: true,
      },
    })
  }
  return { id: user.id, email: user.email, name: user.name, role: user.role }
}

async function createAdmin(suffix: string, permissions: AdminPermission[]) {
  const admin = await createUser(suffix, UserRole.ADMIN)
  for (const permission of permissions) {
    await prisma.adminPermissionGrant.create({
      data: { adminUserId: admin.id, permission, grantedById: admin.id },
    })
  }
  return admin
}

function signInAs(user: TestUser | null) {
  mockSession.session = user
    ? { user: { id: user.id, email: user.email, name: user.name, role: user.role, sessionVersion: 1 } }
    : null
}

async function creditWallet(memberId: string, amount: number) {
  await prisma.$transaction((tx) =>
    postWalletCredit(tx, {
      amount,
      memberId,
      effectiveDate: new Date(`${lagosToday()}T00:00:00Z`),
      idempotencyKey: `${prefix}-wallet-${memberId}-${Math.random()}`,
    }),
  )
}

async function evidenceFile(uploadedById: string) {
  const file = await prisma.storedFile.create({
    data: {
      publicId: `${prefix}-evidence-${Math.random()}`,
      secureUrl: 'https://example.test/evidence.pdf',
      purpose: 'receipts',
      format: 'pdf',
      contentType: 'application/pdf',
      sizeBytes: 100,
      uploadedById,
    },
  })
  return file.id
}

/** Apply as the borrower and have the guarantor consent. */
async function applyAndConsent(borrower: TestUser, guarantor: TestUser, amount: number, duration = 6) {
  signInAs(borrower)
  const applied = await applyForLoanAction(borrower.id, {
    requestedAmount: amount,
    duration,
    purpose: 'Stock for my shop',
    guarantorEmail: guarantor.email,
  })
  expect(applied.success, applied.error).toBe(true)
  const loanId = applied.data!.id as string
  const reservation = await prisma.guaranteeReservation.findFirstOrThrow({ where: { loanId } })
  signInAs(guarantor)
  const consent = await decideGuarantorRequestAction({ reservationId: reservation.id, decision: 'ACCEPT' })
  expect(consent.success, consent.error).toBe(true)
  return loanId
}

// Each case runs several locked transactions and generates PDF evidence; allow for a loaded CI box.
describe('P3-04 loan workflow (integration)', { timeout: 30000 }, () => {
  let reviewer: TestUser
  let disburser: TestUser

  beforeAll(async () => {
    reviewer = await createAdmin('reviewer', [AdminPermission.LOANS_REVIEW, AdminPermission.LOANS_DISBURSE])
    disburser = await createAdmin('disburser', [AdminPermission.LOANS_DISBURSE, AdminPermission.TRANSACTIONS_REVIEW])
  })

  beforeEach(() => {
    settings.loanApplicationFee = 0
    signInAs(null)
  })

  afterAll(async () => {
    const ids = createdUserIds
    const loans = await prisma.loan.findMany({ where: { userId: { in: ids } }, select: { id: true } })
    const loanIds = loans.map((l) => l.id)
    const entryIds = (
      await prisma.journalLine.findMany({
        where: { OR: [{ memberId: { in: ids } }, { journalEntry: { postedById: { in: ids } } }] },
        select: { journalEntryId: true },
      })
    ).map((l) => l.journalEntryId)
    await prisma.feeAssessment.deleteMany({ where: { memberId: { in: ids } } })
    await prisma.paymentAllocation.deleteMany({ where: { payment: { memberId: { in: ids } } } })
    await prisma.payment.deleteMany({ where: { memberId: { in: ids } } })
    await prisma.submissionTarget.deleteMany({ where: { submission: { memberId: { in: ids } } } })
    await prisma.paymentSubmission.deleteMany({ where: { memberId: { in: ids } } })
    await prisma.loanPenaltyAccrual.deleteMany({ where: { instalment: { loanId: { in: loanIds } } } })
    await prisma.loanInstalment.deleteMany({ where: { loanId: { in: loanIds } } })
    await prisma.borrowerOfferAcceptance.deleteMany({ where: { loanId: { in: loanIds } } })
    await prisma.guaranteeReservation.deleteMany({
      where: { OR: [{ applicantId: { in: ids } }, { guarantorId: { in: ids } }] },
    })
    await prisma.loan.deleteMany({ where: { id: { in: loanIds } } })
    await prisma.disbursement.deleteMany({ where: { recipientUserId: { in: ids } } })
    await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entryIds } } })
    await prisma.journalEntry.deleteMany({ where: { id: { in: entryIds } } })
    await prisma.storedFile.deleteMany({ where: { OR: [{ uploadedById: { in: ids } }, { ownerUserId: { in: ids } }] } })
    await prisma.savings.deleteMany({ where: { userId: { in: ids } } })
    await prisma.bankAccount.deleteMany({ where: { userId: { in: ids } } })
    await prisma.adminPermissionGrant.deleteMany({ where: { adminUserId: { in: ids } } })
    await prisma.auditEvent.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { affectedUserId: { in: ids } }] } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
  })

  it('C1 end to end: apply → consent → approve → accept → dual-controlled disbursement → wallet settlement', async () => {
    const borrower = await createUser('c1-b', UserRole.USER, 200000) // standalone limit ₦400k
    const guarantor = await createUser('c1-g', UserRole.USER, 50000)

    const loanId = await applyAndConsent(borrower, guarantor, 300000, 6)
    let loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
    expect(loan.status).toBe(LoanStatus.PENDING)
    expect(loan.monthlyInterestRatePercent?.toNumber()).toBe(5)
    expect(loan.latePenaltyDailyPercent?.toNumber()).toBe(0.5)
    expect(loan.penaltyCapType).toBe(PenaltyCapType.PERCENT_OF_PRINCIPAL)
    expect(loan.loanTermRateVersion).toBe(7)
    expect(await prisma.feeAssessment.count({ where: { targetId: loanId } })).toBe(0) // zero fee changes nothing

    // Admin approves the requested terms → APPROVED with an offer
    signInAs(reviewer)
    const approved = await approveLoanAction(loanId, 300000)
    expect(approved.success, approved.error).toBe(true)
    expect(approved.data!.termsChanged).toBe(false)
    expect(approved.data!.quote.totalScheduledRepayment).toBe(390000)
    loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
    expect(loan.status).toBe(LoanStatus.APPROVED)
    expect(loan.offerExpiresAt).not.toBeNull()

    // Own savings locked from approval (derived from the loan state)
    await expect(
      prisma.$transaction((tx) => assertSavingsWithdrawalAllowed(tx, { memberId: borrower.id, withdrawalAmount: 1 })),
    ).rejects.toThrow(/locked/i)

    // Disbursement before the borrower accepts is impossible
    signInAs(disburser)
    const early = await disburseLoanAction(loanId, {
      amount: 300000,
      valueDate: lagosToday(),
      bankReference: 'TRF-EARLY',
      evidenceFileId: await evidenceFile(disburser.id),
    })
    expect(early.success).toBe(false)

    // Borrower accepts → ACCEPTED with evidence
    signInAs(borrower)
    const accepted = await acceptLoanOfferAction(borrower.id, loanId)
    expect(accepted.success, accepted.error).toBe(true)
    const offer = await prisma.borrowerOfferAcceptance.findUniqueOrThrow({ where: { loanId } })
    expect(offer.decision).toBe(BorrowerOfferDecision.ACCEPTED)
    expect(offer.evidenceDocumentId).toMatch(/^CK-EVD-/)
    expect(offer.totalScheduledRepayment.toNumber()).toBe(390000)
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe(LoanStatus.ACCEPTED)

    // The approver cannot also disburse (dual control A-19)
    signInAs(reviewer)
    const sameStaff = await disburseLoanAction(loanId, {
      amount: 300000,
      valueDate: lagosToday(),
      bankReference: 'TRF-1',
      evidenceFileId: await evidenceFile(reviewer.id),
    })
    expect(sameStaff.success).toBe(false)
    expect(sameStaff.code).toBe('DUAL_CONTROL_REQUIRED')

    // Evidence, value date and the exact amount are required
    signInAs(disburser)
    const wrongAmount = await disburseLoanAction(loanId, {
      amount: 250000,
      valueDate: lagosToday(),
      bankReference: 'TRF-1',
      evidenceFileId: await evidenceFile(disburser.id),
    })
    expect(wrongAmount.code).toBe('AMOUNT_MISMATCH')
    const noEvidence = await disburseLoanAction(loanId, {
      amount: 300000,
      valueDate: lagosToday(),
      bankReference: 'TRF-1',
      evidenceFileId: '',
    })
    expect(noEvidence.code).toBe('EVIDENCE_REQUIRED')

    const evidenceId = await evidenceFile(disburser.id)
    const disbursed = await disburseLoanAction(loanId, {
      amount: 300000,
      valueDate: lagosToday(),
      bankReference: 'TRF-1',
      evidenceFileId: evidenceId,
    })
    expect(disbursed.success, disbursed.error).toBe(true)

    // Idempotent replay: no second disbursement, journal or schedule
    const replay = await disburseLoanAction(loanId, {
      amount: 300000,
      valueDate: lagosToday(),
      bankReference: 'TRF-1',
      evidenceFileId: evidenceId,
    })
    expect(replay.success).toBe(true)
    expect(replay.data!.isReplay).toBe(true)
    expect(await prisma.disbursement.count({ where: { recipientUserId: borrower.id } })).toBe(1)

    loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
    expect(loan.status).toBe(LoanStatus.ACTIVE)
    expect(formatDateOnly(loan.disbursementValueDate!)).toBe(lagosToday())
    const instalments = await prisma.loanInstalment.findMany({ where: { loanId }, orderBy: { instalmentNumber: 'asc' } })
    expect(instalments).toHaveLength(6)
    instalments.forEach((inst, idx) => {
      expect(inst.principalDue.toNumber()).toBe(50000)
      expect(inst.interestDue.toNumber()).toBe(15000)
      expect(formatDateOnly(inst.dueDate)).toBe(formatDateOnly(addMonthsClamped(lagosToday(), idx + 1)))
    })
    const journal = await prisma.journalEntry.findUniqueOrThrow({
      where: { idempotencyKey: `loan-disbursement:${loanId}` },
      include: { lines: true },
    })
    const debit = journal.lines.find((l) => l.accountType === LedgerAccountType.LOAN_RECEIVABLE_PRINCIPAL)
    const credit = journal.lines.find((l) => l.accountType === LedgerAccountType.COOPERATIVE_CASH)
    expect(debit?.debit.toNumber()).toBe(300000)
    expect(credit?.credit.toNumber()).toBe(300000)
    // Lock still in force while the loan is active
    await expect(
      prisma.$transaction((tx) => assertSavingsWithdrawalAllowed(tx, { memberId: borrower.id, withdrawalAmount: 1 })),
    ).rejects.toThrow(/locked/i)

    // Early settlement from the wallet: quote = 390,000 (A-23), no rebate
    await creditWallet(borrower.id, 400000)
    signInAs(borrower)
    const tooMuch = await payLoanFromWalletAction(borrower.id, { loanId, amount: 390000.01, idempotencyKey: 'settle-key-0' })
    expect(tooMuch.code).toBe('AMOUNT_EXCEEDS_OUTSTANDING')
    const settle = await payLoanFromWalletAction(borrower.id, { loanId, amount: 390000, idempotencyKey: 'settle-key-1' })
    expect(settle.success, settle.error).toBe(true)
    expect(settle.data!.loanStatus).toBe(LoanStatus.COMPLETED)

    // Exactly once: same key replays, wallet debited once
    const again = await payLoanFromWalletAction(borrower.id, { loanId, amount: 390000, idempotencyKey: 'settle-key-1' })
    expect(again.success).toBe(true)
    expect(again.data!.isReplay).toBe(true)
    expect((await getWalletBalance(borrower.id)).toNumber()).toBe(10000)

    loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
    expect(loan.status).toBe(LoanStatus.COMPLETED)
    expect(loan.outstandingBalance.toNumber()).toBe(0)
    const statuses = await prisma.loanInstalment.findMany({ where: { loanId }, select: { status: true } })
    expect(statuses.every((s) => s.status === PaymentPeriodStatus.COMPLETED)).toBe(true)
    const reservation = await prisma.guaranteeReservation.findFirstOrThrow({ where: { loanId } })
    expect(reservation.state).toBe(GuaranteeState.RELEASED)
    expect(reservation.reservedAmount.toNumber()).toBe(0)
    // Lock released with completion
    await expect(
      prisma.$transaction((tx) => assertSavingsWithdrawalAllowed(tx, { memberId: borrower.id, withdrawalAmount: 1000 })),
    ).resolves.toBeUndefined()
  })

  it('a different approved amount forces re-consent and borrower acceptance; never above the request', async () => {
    const borrower = await createUser('rc-b', UserRole.USER, 50000) // standalone ₦100k
    const guarantor = await createUser('rc-g', UserRole.USER, 200000)

    // Approval is impossible before the guarantor consents
    signInAs(borrower)
    const applied = await applyForLoanAction(borrower.id, {
      requestedAmount: 200000,
      duration: 6,
      purpose: 'Equipment',
      guarantorEmail: guarantor.email,
    })
    expect(applied.success, applied.error).toBe(true)
    const loanId = applied.data!.id as string
    signInAs(reviewer)
    const noConsent = await approveLoanAction(loanId, 200000)
    expect(noConsent.code).toBe('GUARANTOR_CONSENT_REQUIRED')

    const reservation = await prisma.guaranteeReservation.findFirstOrThrow({ where: { loanId } })
    signInAs(guarantor)
    expect((await decideGuarantorRequestAction({ reservationId: reservation.id, decision: 'ACCEPT' })).success).toBe(true)
    expect(
      (await prisma.guaranteeReservation.findUniqueOrThrow({ where: { id: reservation.id } })).reservedAmount.toNumber(),
    ).toBe(100000)

    signInAs(reviewer)
    expect((await approveLoanAction(loanId, 200000.01)).code).toBe('INVALID_APPROVAL')
    const changed = await approveLoanAction(loanId, 150000, { approvedTermMonths: 3 })
    expect(changed.success, changed.error).toBe(true)
    expect(changed.data!.termsChanged).toBe(true)
    let loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
    expect(loan.status).toBe(LoanStatus.AWAITING_RECONSENT)
    expect(loan.duration).toBe(3)
    expect(loan.monthlyInterestRatePercent?.toNumber()).toBe(4) // the 3-month rate applies
    expect(loan.termsVersion).toBe(2)
    let guarantee = await prisma.guaranteeReservation.findUniqueOrThrow({ where: { id: reservation.id } })
    expect(guarantee.state).toBe(GuaranteeState.AWAITING_RECONSENT)
    expect(guarantee.reservedAmount.toNumber()).toBe(50000) // re-created for the new amount

    // Borrower accepts first: still waiting for the guarantor
    signInAs(borrower)
    expect((await acceptLoanOfferAction(borrower.id, loanId)).success).toBe(true)
    loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
    expect(loan.status).toBe(LoanStatus.AWAITING_RECONSENT)

    // Guarantor re-consents to the final figures → ACCEPTED
    signInAs(guarantor)
    expect((await decideGuarantorRequestAction({ reservationId: reservation.id, decision: 'ACCEPT' })).success).toBe(true)
    loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
    expect(loan.status).toBe(LoanStatus.ACCEPTED)
    guarantee = await prisma.guaranteeReservation.findUniqueOrThrow({ where: { id: reservation.id } })
    expect(guarantee.state).toBe(GuaranteeState.CONSENTED)
    expect(guarantee.consentedAmount.toNumber()).toBe(150000)
    expect(guarantee.termsVersion).toBe(2)
  })

  it('a guarantor declining the revised terms ends the offer and releases the reservation', async () => {
    const borrower = await createUser('rd-b', UserRole.USER, 50000)
    const guarantor = await createUser('rd-g', UserRole.USER, 200000)
    const loanId = await applyAndConsent(borrower, guarantor, 180000)
    signInAs(reviewer)
    expect((await approveLoanAction(loanId, 160000)).success).toBe(true)
    const reservation = await prisma.guaranteeReservation.findFirstOrThrow({ where: { loanId } })
    signInAs(guarantor)
    expect(
      (await decideGuarantorRequestAction({ reservationId: reservation.id, decision: 'DECLINE', reason: 'Too much' }))
        .success,
    ).toBe(true)
    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
    expect(loan.status).toBe(LoanStatus.DECLINED)
    const released = await prisma.guaranteeReservation.findUniqueOrThrow({ where: { id: reservation.id } })
    expect(released.reservedAmount.toNumber()).toBe(0)
  })

  it('an application fee above zero blocks approval until paid, and is recorded as fee income', async () => {
    settings.loanApplicationFee = 2000
    const borrower = await createUser('fee-b', UserRole.USER, 100000)
    const guarantor = await createUser('fee-g', UserRole.USER, 50000)
    const loanId = await applyAndConsent(borrower, guarantor, 100000, 3)
    const fee = await prisma.feeAssessment.findFirstOrThrow({ where: { targetId: loanId } })
    expect(fee.amount.toNumber()).toBe(2000)
    expect(fee.status).toBe(FeeStatus.PENDING)

    signInAs(reviewer)
    expect((await approveLoanAction(loanId, 100000)).code).toBe('APPLICATION_FEE_UNPAID')

    await creditWallet(borrower.id, 5000)
    signInAs(borrower)
    const paid = await payLoanFeeFromWalletAction(borrower.id, loanId)
    expect(paid.success, paid.error).toBe(true)
    expect((await prisma.feeAssessment.findUniqueOrThrow({ where: { id: fee.id } })).status).toBe(FeeStatus.PAID)
    const feeLine = await prisma.journalLine.findFirst({
      where: { accountType: LedgerAccountType.FEE_INCOME, accountRefId: fee.id },
    })
    expect(feeLine?.credit.toNumber()).toBe(2000)
    expect((await getWalletBalance(borrower.id)).toNumber()).toBe(3000)

    signInAs(reviewer)
    const approved = await approveLoanAction(loanId, 100000)
    expect(approved.success, approved.error).toBe(true)
  })

  it('confirmed receipts repay oldest instalment first and return principal capacity', async () => {
    const borrower = await createUser('rcpt-b', UserRole.USER, 200000)
    const guarantor = await createUser('rcpt-g', UserRole.USER, 50000)
    const loanId = await applyAndConsent(borrower, guarantor, 300000, 6)
    signInAs(reviewer)
    await approveLoanAction(loanId, 300000)
    signInAs(borrower)
    await acceptLoanOfferAction(borrower.id, loanId)
    signInAs(disburser)
    const d = await disburseLoanAction(loanId, {
      amount: 300000,
      valueDate: lagosToday(),
      bankReference: 'TRF-R',
      evidenceFileId: await evidenceFile(disburser.id),
    })
    expect(d.success, d.error).toBe(true)
    expect((await getApplicantLoanExposure(borrower.id)).toNumber()).toBe(300000)

    // ₦80,000 on the whole loan: instalment 1 (interest 15k → principal 50k), then 15k interest on #2
    const { submission } = await createPaymentSubmission({
      memberId: borrower.id,
      claimedAmount: 80000,
      paidOn: lagosToday(),
      targets: [{ targetType: AllocationTargetType.LOAN, targetId: loanId, requestedAmount: 80000 }],
    })
    // The instalments are shielded while the receipt is under review
    const confirmed = await confirmPaymentSubmission({ submissionId: submission.id, confirmedById: disburser.id })
    expect(confirmed.allocations?.length).toBe(3)

    const insts = await prisma.loanInstalment.findMany({ where: { loanId }, orderBy: { instalmentNumber: 'asc' } })
    expect(insts[0].status).toBe(PaymentPeriodStatus.COMPLETED)
    expect(insts[1].interestPaid.toNumber()).toBe(15000)
    expect(insts[1].principalPaid.toNumber()).toBe(0)
    expect(insts[1].status).toBe(PaymentPeriodStatus.ONGOING)
    // Interest does not restore capacity; principal does
    expect((await getApplicantLoanExposure(borrower.id)).toNumber()).toBe(250000)
    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })
    expect(loan.outstandingBalance.toNumber()).toBe(310000)
    expect(loan.status).toBe(LoanStatus.ACTIVE)

    // A receipt under review shields the targeted instalment; rejection lifts the shield
    const { submission: second } = await createPaymentSubmission({
      memberId: borrower.id,
      claimedAmount: 50000,
      paidOn: lagosToday(),
      targets: [
        { targetType: AllocationTargetType.LOAN, targetId: loanId, targetPeriodId: insts[1].id, requestedAmount: 50000 },
      ],
    })
    await prisma.$transaction((tx) => refreshLoanAfterPayment(tx, loanId))
    expect((await prisma.loanInstalment.findUniqueOrThrow({ where: { id: insts[1].id } })).status).toBe(
      PaymentPeriodStatus.IN_REVIEW,
    )
    await rejectPaymentSubmission({ submissionId: second.id, reviewerId: disburser.id, rejectionReason: 'No match' })
    expect((await prisma.loanInstalment.findUniqueOrThrow({ where: { id: insts[1].id } })).status).toBe(
      PaymentPeriodStatus.ONGOING,
    )
  })

  it('capacity is portfolio-wide (C3): a second loan beyond the guarantor’s free capacity is refused', async () => {
    const borrower = await createUser('c3-b', UserRole.USER, 100000)
    const guarantor = await createUser('c3-g', UserRole.USER, 80000)
    const loanId = await applyAndConsent(borrower, guarantor, 250000)
    expect(
      (await prisma.guaranteeReservation.findFirstOrThrow({ where: { loanId } })).reservedAmount.toNumber(),
    ).toBe(50000)
    signInAs(reviewer)
    expect((await approveLoanAction(loanId, 250000)).success).toBe(true)

    signInAs(borrower)
    const second = await applyForLoanAction(borrower.id, {
      requestedAmount: 40000,
      duration: 3,
      purpose: 'More stock',
      guarantorEmail: guarantor.email,
    })
    expect(second.success).toBe(false)
    expect(second.code).toBe('CAPACITY_EXCEEDED')
    const ok = await applyForLoanAction(borrower.id, {
      requestedAmount: 30000,
      duration: 3,
      purpose: 'More stock',
      guarantorEmail: guarantor.email,
    })
    expect(ok.success, ok.error).toBe(true)
  })

  it('staff cannot apply; rejection needs a reason; withdrawal, decline and expiry release reservations', async () => {
    signInAs(reviewer)
    const staffApply = await applyForLoanAction(reviewer.id, {
      requestedAmount: 1000,
      duration: 3,
      purpose: 'Staff loan',
      guarantorEmail: 'nobody@example.test',
    })
    expect(staffApply.success).toBe(false)

    const borrower = await createUser('end-b', UserRole.USER, 100000)
    const guarantor = await createUser('end-g', UserRole.USER, 100000)

    // Reject
    const rejectedId = await applyAndConsent(borrower, guarantor, 50000, 3)
    signInAs(reviewer)
    expect((await rejectLoanAction(rejectedId, '  ')).code).toBe('REASON_REQUIRED')
    expect((await rejectLoanAction(rejectedId, 'Insufficient history')).success).toBe(true)
    expect((await prisma.guaranteeReservation.findFirstOrThrow({ where: { loanId: rejectedId } })).state).toBe(
      GuaranteeState.RELEASED,
    )

    // Member withdraws
    const withdrawnId = await applyAndConsent(borrower, guarantor, 50000, 3)
    signInAs(borrower)
    expect((await cancelLoanApplicationAction(borrower.id, withdrawnId)).success).toBe(true)
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: withdrawnId } })).status).toBe(LoanStatus.CANCELLED)

    // Borrower declines the offer
    const declinedId = await applyAndConsent(borrower, guarantor, 50000, 3)
    signInAs(reviewer)
    await approveLoanAction(declinedId, 50000)
    signInAs(borrower)
    expect((await declineLoanOfferAction(borrower.id, declinedId, '')).success).toBe(false)
    expect((await declineLoanOfferAction(borrower.id, declinedId, 'Found cheaper funds')).success).toBe(true)
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: declinedId } })).status).toBe(LoanStatus.DECLINED)

    // Offer expires (job is idempotent)
    const expiringId = await applyAndConsent(borrower, guarantor, 50000, 3)
    signInAs(reviewer)
    await approveLoanAction(expiringId, 50000)
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const first = await runLoanOfferExpiryJob({ now: future })
    expect(first.expired).toBeGreaterThanOrEqual(1)
    expect((await prisma.loan.findUniqueOrThrow({ where: { id: expiringId } })).status).toBe(LoanStatus.EXPIRED)
    expect((await prisma.guaranteeReservation.findFirstOrThrow({ where: { loanId: expiringId } })).state).toBe(
      GuaranteeState.RELEASED,
    )
    const second = await runLoanOfferExpiryJob({ now: future })
    expect(second.expired).toBe(0)

    // No open loans → savings are no longer locked
    await expect(
      prisma.$transaction((tx) => assertSavingsWithdrawalAllowed(tx, { memberId: borrower.id, withdrawalAmount: 1000 })),
    ).resolves.toBeUndefined()
  })
})
