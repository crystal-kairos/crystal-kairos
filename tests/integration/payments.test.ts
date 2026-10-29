import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const mockSessionHolder = {
  session: null as any,
}

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => mockSessionHolder.session),
}))

vi.mock('@/models/members/actions', () => ({
  getSessionHelper: vi.fn(async () => mockSessionHolder.session),
}))

import { prisma } from '@/lib/prisma'
import {
  AdminPermission,
  AllocationStatus,
  AllocationTargetType,
  DisbursementPurpose,
  DisbursementStatus,
  LedgerAccountType,
  PaymentComponentType,
  PaymentPeriodStatus,
  PaymentStatus,
  PaymentSubmissionStatus,
  UserRole,
} from '@/generated/prisma/client'
import {
  createPaymentSubmission,
  confirmPaymentSubmission,
  rejectPaymentSubmission,
  resubmitPaymentSubmission,
  reversePayment,
} from '@/lib/services/payments.service'
import {
  requestDisbursement,
  approveDisbursement,
  disbursePayment,
} from '@/lib/services/disbursement.service'

describe('Payment Submissions, Allocations, and Disbursements Integration (PR P2-07, §2.10, §2.12)', () => {
  let memberUser: any
  let reviewerUser: any
  let secondStaffUser: any
  let societyAccount: any
  let memberBankAccount: any
  let testLoan: any
  let instalment1: any
  let instalment2: any

  const prefix = `p207_${Date.now()}`

  beforeAll(async () => {
    // 1. Setup Test Users
    memberUser = await prisma.user.create({
      data: {
        email: `${prefix}_member@kairos.coop`,
        name: 'P207 Member',
        role: UserRole.USER,
        isActive: true,
      },
    })

    reviewerUser = await prisma.user.create({
      data: {
        email: `${prefix}_reviewer@kairos.coop`,
        name: 'P207 Reviewer',
        role: UserRole.ADMIN,
        isActive: true,
      },
    })

    secondStaffUser = await prisma.user.create({
      data: {
        email: `${prefix}_staff2@kairos.coop`,
        name: 'P207 Staff Two',
        role: UserRole.ADMIN,
        isActive: true,
      },
    })

    // Grant Admin permissions
    await prisma.adminPermissionGrant.createMany({
      data: [
        {
          adminUserId: reviewerUser.id,
          permission: AdminPermission.TRANSACTIONS_REVIEW,
          grantedById: reviewerUser.id,
        },
        {
          adminUserId: reviewerUser.id,
          permission: AdminPermission.PAYMENTS_REVERSE,
          grantedById: reviewerUser.id,
        },
        {
          adminUserId: reviewerUser.id,
          permission: AdminPermission.LOANS_DISBURSE,
          grantedById: reviewerUser.id,
        },
        {
          adminUserId: secondStaffUser.id,
          permission: AdminPermission.LOANS_DISBURSE,
          grantedById: reviewerUser.id,
        },
      ],
    })

    // 2. Bank Accounts
    societyAccount = await prisma.societyBankAccount.create({
      data: {
        bankName: 'Access Bank',
        accountNumber: `012${Math.floor(1000000 + Math.random() * 9000000)}`,
        accountName: 'Crystal Kairos Cooperative',
        isActive: true,
        createdById: reviewerUser.id,
      },
    })

    memberBankAccount = await prisma.bankAccount.create({
      data: {
        userId: memberUser.id,
        bankName: 'GTBank',
        accountNumber: `023${Math.floor(1000000 + Math.random() * 9000000)}`,
        accountName: 'P207 Member Account',
        isPrimary: true,
      },
    })

    // 3. Test Loan and Instalments
    testLoan = await prisma.loan.create({
      data: {
        userId: memberUser.id,
        requestedAmount: 100000,
        approvedAmount: 100000,
        interestRate: 5,
        duration: 2,
        purpose: 'Business Inventory',
        status: 'DISBURSED',
      },
    })

    instalment1 = await prisma.loanInstalment.create({
      data: {
        loanId: testLoan.id,
        instalmentNumber: 1,
        dueDate: new Date('2026-02-01'),
        principalDue: 50000,
        interestDue: 5000,
        penaltyAssessed: 1000,
        status: PaymentPeriodStatus.PENDING,
      },
    })

    instalment2 = await prisma.loanInstalment.create({
      data: {
        loanId: testLoan.id,
        instalmentNumber: 2,
        dueDate: new Date('2026-03-01'),
        principalDue: 50000,
        interestDue: 5000,
        penaltyAssessed: 0,
        status: PaymentPeriodStatus.PENDING,
      },
    })
  })

  afterAll(async () => {
    // Cleanup
    const userIds = [memberUser?.id, reviewerUser?.id, secondStaffUser?.id].filter(Boolean)

    await prisma.paymentAllocation.deleteMany({
      where: { payment: { memberId: memberUser.id } },
    })
    await prisma.payment.deleteMany({
      where: { memberId: memberUser.id },
    })
    await prisma.submissionTarget.deleteMany({
      where: { submission: { memberId: memberUser.id } },
    })
    await prisma.paymentSubmission.deleteMany({
      where: { memberId: memberUser.id },
    })
    await prisma.disbursement.deleteMany({
      where: { recipientUserId: memberUser.id },
    })

    const staffIds = [reviewerUser?.id, secondStaffUser?.id].filter(Boolean)
    const journalEntries = await prisma.journalEntry.findMany({
      where: { postedById: { in: staffIds } },
      select: { id: true },
    })
    const jeIds = journalEntries.map((j) => j.id)

    if (jeIds.length > 0) {
      await prisma.journalEntry.updateMany({
        where: { id: { in: jeIds } },
        data: { reversalOfId: null },
      })
      await prisma.journalLine.deleteMany({
        where: { journalEntryId: { in: jeIds } },
      })
      await prisma.journalEntry.deleteMany({
        where: { id: { in: jeIds } },
      })
    }

    if (testLoan?.id) {
      await prisma.loanInstalment.deleteMany({
        where: { loanId: testLoan.id },
      })
      await prisma.loan.deleteMany({
        where: { id: testLoan.id },
      })
    }
    await prisma.bankAccount.deleteMany({
      where: { userId: memberUser.id },
    })
    await prisma.societyBankAccount.deleteMany({
      where: { id: societyAccount.id },
    })
    await prisma.adminPermissionGrant.deleteMany({
      where: { adminUserId: { in: staffIds } },
    })
    await prisma.auditEvent.deleteMany({
      where: {
        OR: [
          { actorId: { in: userIds } },
          { affectedUserId: { in: userIds } },
        ],
      },
    })
    await prisma.user.deleteMany({
      where: { id: { in: userIds } },
    })
  })

  it('enforces date validations on payment submission creation (§2.10)', async () => {
    // Future date rejected
    const tomorrow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
    await expect(
      createPaymentSubmission({
        memberId: memberUser.id,
        claimedAmount: 56000,
        paidOn: tomorrow,
        targets: [
          {
            targetType: AllocationTargetType.LOAN,
            targetId: testLoan.id,
            targetPeriodId: instalment1.id,
            requestedAmount: 56000,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'FUTURE_DATE_NOT_ALLOWED',
    })

    // Date older than 30 days rejected
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    await expect(
      createPaymentSubmission({
        memberId: memberUser.id,
        claimedAmount: 56000,
        paidOn: fortyDaysAgo,
        targets: [
          {
            targetType: AllocationTargetType.LOAN,
            targetId: testLoan.id,
            targetPeriodId: instalment1.id,
            requestedAmount: 56000,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'PAYMENT_DATE_TOO_OLD',
    })
  })

  it('creates payment submission with targets and sequential number', async () => {
    const today = new Date()
    const { submission, warnings } = await createPaymentSubmission({
      memberId: memberUser.id,
      claimedAmount: 60000,
      paidOn: today,
      bankReference: 'NIP-12345678',
      fileHash: 'sha256-hash-receipt-001',
      receivingBankAccountId: societyAccount.id,
      targets: [
        {
          targetType: AllocationTargetType.LOAN,
          targetId: testLoan.id,
          targetPeriodId: instalment1.id,
          requestedAmount: 56000,
        },
      ],
    })

    expect(submission.id).toBeDefined()
    expect(submission.submissionNumber).toMatch(/^SUB-\d{6}$/)
    expect(submission.status).toBe(PaymentSubmissionStatus.SUBMITTED)
    expect(submission.targets).toHaveLength(1)
    expect(warnings.hasDuplicateHashWarning).toBe(false)
  })

  it('confirms payment, applies waterfall, routes excess to wallet, and balances ledger (§2.10, §2.12)', async () => {
    // Fetch the submission created in previous test
    const submission = await prisma.paymentSubmission.findFirstOrThrow({
      where: {
        memberId: memberUser.id,
        status: PaymentSubmissionStatus.SUBMITTED,
      },
    })

    const confirmRes = await confirmPaymentSubmission({
      submissionId: submission.id,
      confirmedById: reviewerUser.id,
      confirmedAmount: 60000, // ₦56,000 due on instalment 1 + ₦4,000 excess
    })

    expect(confirmRes.payment).toBeDefined()
    expect(confirmRes.payment.paymentNumber).toMatch(/^PAY-\d{6}$/)
    expect(confirmRes.payment.status).toBe(PaymentStatus.CONFIRMED)
    expect(confirmRes.allocations).toBeDefined()

    // Verify waterfall allocations:
    // 1. PENALTY: 1,000
    // 2. INTEREST: 5,000
    // 3. PRINCIPAL: 50,000
    // 4. WALLET_TOPUP: 4,000
    const allocations = confirmRes.allocations!
    const penaltyAlloc = allocations.find(
      (a) => a.componentType === PaymentComponentType.PENALTY,
    )
    const interestAlloc = allocations.find(
      (a) => a.componentType === PaymentComponentType.INTEREST,
    )
    const principalAlloc = allocations.find(
      (a) => a.componentType === PaymentComponentType.PRINCIPAL,
    )
    const walletAlloc = allocations.find(
      (a) => a.componentType === PaymentComponentType.WALLET_TOPUP,
    )

    expect(penaltyAlloc).toBeDefined()
    expect(Number(penaltyAlloc?.amount)).toBe(1000)
    expect(interestAlloc).toBeDefined()
    expect(Number(interestAlloc?.amount)).toBe(5000)
    expect(principalAlloc).toBeDefined()
    expect(Number(principalAlloc?.amount)).toBe(50000)
    expect(walletAlloc).toBeDefined()
    expect(Number(walletAlloc?.amount)).toBe(4000)

    // Verify period status updated to COMPLETED
    const updatedInstalment = await prisma.loanInstalment.findUniqueOrThrow({
      where: { id: instalment1.id },
    })
    expect(updatedInstalment.status).toBe(PaymentPeriodStatus.COMPLETED)
    expect(Number(updatedInstalment.principalPaid)).toBe(50000)
    expect(Number(updatedInstalment.interestPaid)).toBe(5000)
    expect(Number(updatedInstalment.penaltyPaid)).toBe(1000)

    // Verify Double-Entry Journal Entry (§2.12)
    expect(confirmRes.journalEntry).toBeDefined()
    const lines = confirmRes.journalEntry!.lines
    expect(lines.length).toBeGreaterThanOrEqual(2)

    const totalDebits = lines.reduce(
      (sum, l) => sum + Number(l.debit),
      0,
    )
    const totalCredits = lines.reduce(
      (sum, l) => sum + Number(l.credit),
      0,
    )
    expect(totalDebits).toBe(60000)
    expect(totalCredits).toBe(60000) // Double-entry strictly balanced!

    const cashDebit = lines.find(
      (l) => l.accountType === LedgerAccountType.COOPERATIVE_CASH,
    )
    expect(Number(cashDebit?.debit)).toBe(60000)

    // Duplicate detection on confirmed receipt file hash blocks new submission
    await expect(
      createPaymentSubmission({
        memberId: memberUser.id,
        claimedAmount: 50000,
        paidOn: new Date(),
        fileHash: 'sha256-hash-receipt-001',
        targets: [
          {
            targetType: AllocationTargetType.LOAN,
            targetId: testLoan.id,
            targetPeriodId: instalment2.id,
            requestedAmount: 50000,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'DUPLICATE_PAYMENT',
    })
  })

  it('rejects a submission with reason, and enables resubmission chaining (§2.10 rule 2)', async () => {
    // 1. Create a submission to reject
    const { submission: subToReject } = await createPaymentSubmission({
      memberId: memberUser.id,
      claimedAmount: 55000,
      paidOn: new Date(),
      bankReference: 'NIP-REJECT-001',
      targets: [
        {
          targetType: AllocationTargetType.LOAN,
          targetId: testLoan.id,
          targetPeriodId: instalment2.id,
          requestedAmount: 55000,
        },
      ],
    })

    // 2. Reject without reason fails
    await expect(
      rejectPaymentSubmission({
        submissionId: subToReject.id,
        reviewerId: reviewerUser.id,
        rejectionReason: '',
      }),
    ).rejects.toMatchObject({
      code: 'REJECTION_REASON_REQUIRED',
    })

    // 3. Reject with valid reason
    const rejected = await rejectPaymentSubmission({
      submissionId: subToReject.id,
      reviewerId: reviewerUser.id,
      rejectionReason: 'Receipt image blurry, amount unreadable.',
    })
    expect(rejected.status).toBe(PaymentSubmissionStatus.REJECTED)
    expect(rejected.rejectionReason).toBe('Receipt image blurry, amount unreadable.')

    // 4. Resubmit creates new submission chained to original
    const { submission: resubmitted } = await resubmitPaymentSubmission(
      rejected.id,
      {
        claimedAmount: 55000,
        paidOn: new Date(),
        bankReference: 'NIP-REJECT-001-FIXED',
        targets: [
          {
            targetType: AllocationTargetType.LOAN,
            targetId: testLoan.id,
            targetPeriodId: instalment2.id,
            requestedAmount: 55000,
          },
        ],
      },
    )

    expect(resubmitted.id).not.toBe(rejected.id)
    expect(resubmitted.resubmissionOfId).toBe(rejected.id)
    expect(resubmitted.status).toBe(PaymentSubmissionStatus.SUBMITTED)

    // Original remains preserved in DB
    const origCheck = await prisma.paymentSubmission.findUniqueOrThrow({
      where: { id: rejected.id },
    })
    expect(origCheck.status).toBe(PaymentSubmissionStatus.REJECTED)
  })

  it('reverses a confirmed payment with full reversal cascade (§2.10)', async () => {
    const payment = await prisma.payment.findFirstOrThrow({
      where: {
        memberId: memberUser.id,
        status: PaymentStatus.CONFIRMED,
      },
    })

    const reverseRes = await reversePayment({
      paymentId: payment.id,
      reversedById: reviewerUser.id,
      reversalReason: 'Duplicate wire credit reversed by bank.',
      isOwner: true,
    })

    expect(reverseRes.payment.status).toBe(PaymentStatus.REVERSED)

    // Verify allocations marked REVERSED
    const allocations = await prisma.paymentAllocation.findMany({
      where: { paymentId: payment.id },
    })
    expect(allocations.every((a) => a.status === AllocationStatus.REVERSED)).toBe(true)

    // Verify period status reverted back to ONGOING
    const revertedInstalment = await prisma.loanInstalment.findUniqueOrThrow({
      where: { id: instalment1.id },
    })
    expect(revertedInstalment.status).toBe(PaymentPeriodStatus.ONGOING)
    expect(Number(revertedInstalment.principalPaid)).toBe(0)
    expect(Number(revertedInstalment.interestPaid)).toBe(0)
    expect(Number(revertedInstalment.penaltyPaid)).toBe(0)
  })

  it('executes disbursement flow with dual control and balanced journal entry (§1.4, §2.12)', async () => {
    // 1. Request disbursement
    const req = await requestDisbursement({
      recipientUserId: memberUser.id,
      purpose: DisbursementPurpose.LOAN_DISBURSEMENT,
      amount: 100000,
      bankAccountId: memberBankAccount.id,
      requestedById: reviewerUser.id,
    })

    expect(req.id).toBeDefined()
    expect(req.disbursementNumber).toMatch(/^DSB-\d{6}$/)
    expect(req.status).toBe(DisbursementStatus.REQUESTED)

    // 2. Approve disbursement
    const approved = await approveDisbursement({
      disbursementId: req.id,
      approvedById: reviewerUser.id,
    })
    expect(approved.status).toBe(DisbursementStatus.APPROVED)

    // 3. Disburse payment
    const disburseRes = await disbursePayment({
      disbursementId: req.id,
      disbursedById: secondStaffUser.id,
      bankReference: 'CBN-WIRE-998877',
      valueDate: new Date(),
    })

    expect(disburseRes.disbursement.status).toBe(DisbursementStatus.PAID)
    expect(disburseRes.disbursement.bankReference).toBe('CBN-WIRE-998877')

    // Double-Entry Journal for disbursement (§2.12):
    // Debit LOAN_RECEIVABLE_PRINCIPAL 100,000 / Credit COOPERATIVE_CASH 100,000
    const lines = disburseRes.journalEntry!.lines
    const loanDebit = lines.find(
      (l) => l.accountType === LedgerAccountType.LOAN_RECEIVABLE_PRINCIPAL,
    )
    const cashCredit = lines.find(
      (l) => l.accountType === LedgerAccountType.COOPERATIVE_CASH,
    )

    expect(Number(loanDebit?.debit)).toBe(100000)
    expect(Number(cashCredit?.credit)).toBe(100000)
  })
})
