import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const mockSessionHolder: { session: unknown } = {
  session: null,
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
  AllocationTargetType,
  EAjoDuration,
  EAjoFrequency,
  EAjoMemberStatus,
  EAjoStatus,
  LedgerAccountType,
  LoanStatus,
  PaymentPeriodStatus,
  PaymentSubmissionStatus,
  PenaltyCapType,
  SavingsFrequency,
  SavingsStatus,
  SavingsType,
  UserRole,
} from '@/generated/prisma/client'
import { parseDateOnly } from '@/lib/domain/dates'
import { postJournalEntry } from '@/lib/services/ledger.service'
import { applyWallet, getWalletSummary } from '@/lib/services/wallet.service'
import { recalculateLateness } from '@/lib/services/lateness.service'
import {
  confirmPaymentSubmission,
  rejectPaymentSubmission,
  reversePayment,
} from '@/lib/services/payments.service'
import { runPenaltiesJob } from '@/lib/jobs/penalties.job'
import { runWalletAutoApplyJob } from '@/lib/jobs/wallet-auto-apply.job'
import { runInterestRecognitionJob } from '@/lib/jobs/interest-recognition.job'

describe('P3-06 — Wallet Application, Value-Date Lateness Engine & Background Jobs (Integration)', () => {
  const prefix = `p306_${Date.now()}`
  let reviewerUser: { id: string }
  let societyAccount: { id: string }

  async function createTestMember(tag: string) {
    return prisma.user.create({
      data: {
        email: `${prefix}_${tag}@kairos.coop`,
        username: `${prefix}_${tag}`,
        name: `P306 ${tag}`,
        role: UserRole.USER,
        isActive: true,
      },
    })
  }

  async function creditMemberWallet(memberId: string, amount: number, tag: string) {
    await postJournalEntry(prisma, {
      sourceType: 'TEST_WALLET_TOPUP',
      sourceId: memberId,
      idempotencyKey: `topup:${prefix}:${tag}:${Math.random()}`,
      description: `Seed wallet balance for ${tag}`,
      effectiveDate: parseDateOnly('2026-01-15'),
      postedById: reviewerUser.id,
      lines: [
        {
          accountType: LedgerAccountType.COOPERATIVE_CASH,
          debit: amount,
          credit: 0,
        },
        {
          accountType: LedgerAccountType.MEMBER_WALLET_LIABILITY,
          memberId,
          accountRefType: 'WALLET',
          accountRefId: memberId,
          debit: 0,
          credit: amount,
        },
      ],
    })
  }

  async function createHistoricalSubmission(params: {
    memberId: string
    claimedAmount: number
    paidOn: Date
    targetType: AllocationTargetType
    targetId: string
    targetPeriodId: string
    tag: string
  }) {
    const { lockSequence } = await import('@/lib/db/sequence')
    const { formatSequentialNumber, nextSequenceAfter } = await import(
      '@/lib/domain/payment-reference'
    )
    return prisma.$transaction(async (tx) => {
      await lockSequence(tx, 'SUB')
      const latestSub = await tx.paymentSubmission.findFirst({
        orderBy: { submissionNumber: 'desc' },
        select: { submissionNumber: true },
      })
      const nextSubSeq = nextSequenceAfter(latestSub?.submissionNumber ?? null)
      const submissionNumber = formatSequentialNumber('SUB', nextSubSeq)

      return tx.paymentSubmission.create({
        data: {
          submissionNumber,
          memberId: params.memberId,
          receivingBankAccountId: societyAccount.id,
          claimedAmount: params.claimedAmount,
          paidOn: params.paidOn,
          status: PaymentSubmissionStatus.SUBMITTED,
          targets: {
            create: [
              {
                targetType: params.targetType,
                targetId: params.targetId,
                targetPeriodId: params.targetPeriodId,
                requestedAmount: params.claimedAmount,
              },
            ],
          },
        },
        include: { targets: true },
      })
    })
  }

  beforeAll(async () => {
    reviewerUser = await prisma.user.create({
      data: {
        email: `${prefix}_reviewer@kairos.coop`,
        username: `${prefix}_reviewer`,
        name: 'P306 Reviewer',
        role: UserRole.ADMIN,
        isActive: true,
      },
    })

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
      ],
    })

    societyAccount = await prisma.societyBankAccount.create({
      data: {
        bankName: 'Zenith Bank',
        accountNumber: `20${Math.floor(10000000 + Math.random() * 89999999)}`,
        accountName: 'Crystal Kairos Society',
        isActive: true,
        createdById: reviewerUser.id,
      },
    })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('reproduces Appendix C6 automatic due-date wallet application (LOAN → EAJO, never SAVINGS) and allows MEMBER mode for SAVINGS', async () => {
    const member = await createTestMember('c6_member')
    await creditMemberWallet(member.id, 50000, 'c6_init')

    // 1. Create an ACTIVE Loan with Instalment 1 due on 2026-03-01 (₦30,000 principal + ₦8,700 interest = ₦38,700)
    const loan = await prisma.loan.create({
      data: {
        userId: member.id,
        requestedAmount: 300000,
        approvedAmount: 300000,
        duration: 10,
        interestRate: 2.9,
        purpose: 'Business expansion',
        status: LoanStatus.ACTIVE,
        disbursedAt: parseDateOnly('2026-02-01'),
        latePenaltyDailyPercent: 0.5,
        penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
        penaltyCapValue: 10,
      },
    })

    const loanInst = await prisma.loanInstalment.create({
      data: {
        loanId: loan.id,
        instalmentNumber: 1,
        dueDate: parseDateOnly('2026-03-01'),
        principalDue: 30000,
        interestDue: 8700,
        status: PaymentPeriodStatus.PENDING,
      },
    })

    // 2. Create an ACTIVE E-Ajo Group & Member with Period 1 due on 2026-03-01 (₦20,000 contribution)
    const eajoGroup = await prisma.eAjoGroup.create({
      data: {
        title: `${prefix} E-Ajo C6`,
        contributionAmount: 20000,
        frequency: EAjoFrequency.MONTHLY,
        duration: EAjoDuration.FOUR_MONTHS,
        totalSlots: 4,
        startDate: parseDateOnly('2026-03-01'),
        status: EAjoStatus.ACTIVE,
        createdBy: reviewerUser.id,
        latePenaltyDailyPercent: 0.5,
        penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
        penaltyCapValue: 10,
      },
    })

    const eajoMember = await prisma.eAjoMember.create({
      data: {
        groupId: eajoGroup.id,
        userId: member.id,
        payoutPosition: 2,
        status: EAjoMemberStatus.ACTIVE,
      },
    })

    const eajoPeriod = await prisma.eAjoContributionPeriod.create({
      data: {
        eajoMemberId: eajoMember.id,
        periodNumber: 1,
        dueDate: parseDateOnly('2026-03-01'),
        contributionDue: 20000,
        status: PaymentPeriodStatus.PENDING,
      },
    })

    // 3. Create an ACTIVE Regular Savings plan with Period 1 due on 2026-03-01 (₦10,000 contribution)
    const savings = await prisma.savings.create({
      data: {
        userId: member.id,
        savingsType: SavingsType.REGULAR,
        targetAmount: 10000,
        frequency: SavingsFrequency.MONTHLY,
        durationMonths: 10,
        ratePercentSnapshot: 6.0,
        rateVersionSnapshot: 1,
        startDate: parseDateOnly('2026-03-01'),
        maturityDate: parseDateOnly('2026-12-31'),
        status: SavingsStatus.ACTIVE,
      },
    })

    const savingsPeriod = await prisma.savingsPeriod.create({
      data: {
        savingsId: savings.id,
        periodNumber: 1,
        dueDate: parseDateOnly('2026-03-01'),
        amountDue: 10000,
        status: PaymentPeriodStatus.PENDING,
      },
    })

    // Run automatic due-date wallet application job as of 2026-03-01
    const jobRes = await runWalletAutoApplyJob({
      asOf: parseDateOnly('2026-03-01'),
      actorId: reviewerUser.id,
    })
    expect(jobRes.appliedMembers).toBeGreaterThanOrEqual(1)

    // Verify Appendix C6 outcomes:
    // - Loan instalment 1 received ₦38,700 (₦8,700 interest + ₦30,000 principal) -> COMPLETED
    // - E-Ajo period 1 received ₦11,300 -> PARTIALLY_PAID (₦8,700 remaining)
    // - Regular savings period 1 received ₦0 -> PENDING
    // - Member wallet available balance is now ₦0
    const updatedLoanInst = await prisma.loanInstalment.findUniqueOrThrow({
      where: { id: loanInst.id },
    })
    expect(updatedLoanInst.interestPaid.toNumber()).toBe(8700)
    expect(updatedLoanInst.principalPaid.toNumber()).toBe(30000)
    expect(updatedLoanInst.status).toBe(PaymentPeriodStatus.COMPLETED)

    const updatedEAjoPeriod = await prisma.eAjoContributionPeriod.findUniqueOrThrow({
      where: { id: eajoPeriod.id },
    })
    expect(updatedEAjoPeriod.contributionPaid.toNumber()).toBe(11300)
    expect(updatedEAjoPeriod.status).toBe(PaymentPeriodStatus.PENDING)

    const updatedSavingsPeriod = await prisma.savingsPeriod.findUniqueOrThrow({
      where: { id: savingsPeriod.id },
    })
    expect(updatedSavingsPeriod.amountPaid.toNumber()).toBe(0)

    const walletAfterAuto = await getWalletSummary(member.id)
    expect(walletAfterAuto.availableBalance.toNumber()).toBe(0)

    // Now top up ₦10,000 and let member explicitly pay Regular Savings Period 1 in MEMBER mode
    await creditMemberWallet(member.id, 10000, 'c6_sav_topup')
    const memberSavApply = await applyWallet({
      memberId: member.id,
      mode: 'MEMBER',
      targetType: AllocationTargetType.SAVINGS,
      targetId: savings.id,
      periodId: savingsPeriod.id,
      amount: 10000,
      idempotencyKey: `c6-member-sav-${Date.now()}`,
      actorId: member.id,
    })

    expect(memberSavApply.appliedAmount.toNumber()).toBe(10000)
    const savPeriodAfterMember = await prisma.savingsPeriod.findUniqueOrThrow({
      where: { id: savingsPeriod.id },
    })
    expect(savPeriodAfterMember.amountPaid.toNumber()).toBe(10000)
    expect(savPeriodAfterMember.status).toBe(PaymentPeriodStatus.COMPLETED)

    const lots = await prisma.savingsLot.findMany({
      where: { savingsId: savings.id, savingsPeriodId: savingsPeriod.id },
    })
    expect(lots).toHaveLength(1)
    expect(lots[0].principal.toNumber()).toBe(10000)
  })

  it('serializes concurrent applyWallet calls under lockMembers so wallet balance never goes negative', async () => {
    const member = await createTestMember('race_member')
    await creditMemberWallet(member.id, 15000, 'race_init')

    const savings = await prisma.savings.create({
      data: {
        userId: member.id,
        savingsType: SavingsType.REGULAR,
        targetAmount: 12000,
        frequency: SavingsFrequency.MONTHLY,
        durationMonths: 10,
        ratePercentSnapshot: 6.0,
        rateVersionSnapshot: 1,
        startDate: parseDateOnly('2026-02-01'),
        maturityDate: parseDateOnly('2026-11-30'),
        status: SavingsStatus.ACTIVE,
      },
    })

    const p1 = await prisma.savingsPeriod.create({
      data: {
        savingsId: savings.id,
        periodNumber: 1,
        dueDate: parseDateOnly('2026-02-01'),
        amountDue: 12000,
        status: PaymentPeriodStatus.PENDING,
      },
    })
    const p2 = await prisma.savingsPeriod.create({
      data: {
        savingsId: savings.id,
        periodNumber: 2,
        dueDate: parseDateOnly('2026-03-01'),
        amountDue: 12000,
        status: PaymentPeriodStatus.PENDING,
      },
    })

    // Fire two concurrent applyWallet requests of ₦12,000 each against a ₦15,000 wallet
    const results = await Promise.allSettled([
      applyWallet({
        memberId: member.id,
        mode: 'MEMBER',
        targetType: AllocationTargetType.SAVINGS,
        targetId: savings.id,
        periodId: p1.id,
        amount: 12000,
        idempotencyKey: `race-1-${Date.now()}`,
        actorId: member.id,
      }),
      applyWallet({
        memberId: member.id,
        mode: 'MEMBER',
        targetType: AllocationTargetType.SAVINGS,
        targetId: savings.id,
        periodId: p2.id,
        amount: 12000,
        idempotencyKey: `race-2-${Date.now()}`,
        actorId: member.id,
      }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason?.code).toBe('INSUFFICIENT_WALLET_BALANCE')

    const walletSummary = await getWalletSummary(member.id)
    expect(walletSummary.availableBalance.toNumber()).toBe(3000)
  })

  it('enforces Appendix C8 review shield, back-fills penalties on rejection, reverses penalties with VALUE_DATE_RECALC on backdated confirmation, and re-accrues on payment reversal', async () => {
    const member = await createTestMember('c8_member')

    // Disbursed loan of ₦300,000 (0.5%/day = ₦1,500/day, 10% cap = ₦30,000)
    // Instalment 1 due 2026-02-01 (graceWindowEnd = 2026-02-08, firstPenaltyDate = 2026-02-09)
    const loan = await prisma.loan.create({
      data: {
        userId: member.id,
        requestedAmount: 300000,
        approvedAmount: 300000,
        duration: 10,
        interestRate: 2.9,
        purpose: 'Working capital',
        status: LoanStatus.ACTIVE,
        disbursedAt: parseDateOnly('2026-01-01'),
        latePenaltyDailyPercent: 0.5,
        penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
        penaltyCapValue: 10,
      },
    })

    const inst1 = await prisma.loanInstalment.create({
      data: {
        loanId: loan.id,
        instalmentNumber: 1,
        dueDate: parseDateOnly('2026-02-01'),
        principalDue: 30000,
        interestDue: 8700,
        status: PaymentPeriodStatus.PENDING,
      },
    })

    // Recognize instalment 1 interest
    await runInterestRecognitionJob({
      asOf: parseDateOnly('2026-02-01'),
      actorId: reviewerUser.id,
    })

    // Step 1: Member has a SUBMITTED receipt with paidOn = 2026-02-06 (inside grace)
    const submission1 = await createHistoricalSubmission({
      memberId: member.id,
      claimedAmount: 38700,
      paidOn: parseDateOnly('2026-02-06'),
      targetType: AllocationTargetType.LOAN,
      targetId: loan.id,
      targetPeriodId: inst1.id,
      tag: 'c8_sub1',
    })

    // Step 2: Run penalties job on 2026-02-11 (3 days after grace ended: Feb 9, 10, 11)
    await runPenaltiesJob({
      asOf: parseDateOnly('2026-02-11'),
      actorId: reviewerUser.id,
    })

    const accrualsWhileShielded = await prisma.loanPenaltyAccrual.findMany({
      where: { loanInstalmentId: inst1.id, reversedAt: null },
    })
    expect(accrualsWhileShielded).toHaveLength(0)

    const instWhileShielded = await prisma.loanInstalment.findUniqueOrThrow({
      where: { id: inst1.id },
    })
    expect(instWhileShielded.status).toBe(PaymentPeriodStatus.IN_REVIEW)

    // Step 3: Reviewer rejects submission1; recalculateLateness as of 2026-02-11 back-fills Feb 9, 10, 11 (3 × ₦1,500 = ₦4,500)
    await rejectPaymentSubmission({
      submissionId: submission1.id,
      reviewerId: reviewerUser.id,
      rejectionReason: 'Unreadable bank transfer receipt',
    })

    const latenessAfterReject = await recalculateLateness({
      obligationType: 'LOAN',
      obligationId: loan.id,
      asOf: parseDateOnly('2026-02-11'),
      actorId: reviewerUser.id,
      reverseAccrualsAfterAsOf: true,
    })
    expect(latenessAfterReject.penaltiesAssessedNet.toNumber()).toBe(4500)

    const accrualsAfterReject = await prisma.loanPenaltyAccrual.findMany({
      where: { loanInstalmentId: inst1.id, reversedAt: null },
      orderBy: { penaltyDate: 'asc' },
    })
    expect(accrualsAfterReject).toHaveLength(3)

    // Step 4: Member submits valid receipt with paidOn = 2026-02-05 (inside grace) and reviewer confirms with valueDate = 2026-02-05
    const submission2 = await createHistoricalSubmission({
      memberId: member.id,
      claimedAmount: 38700,
      paidOn: parseDateOnly('2026-02-05'),
      targetType: AllocationTargetType.LOAN,
      targetId: loan.id,
      targetPeriodId: inst1.id,
      tag: 'c8_sub2',
    })

    const confirmRes = await confirmPaymentSubmission({
      submissionId: submission2.id,
      confirmedById: reviewerUser.id,
      confirmedAmount: 38700,
      valueDate: parseDateOnly('2026-02-05'),
    })

    // All penalty accruals must now be reversed with VALUE_DATE_RECALC, and full ₦38,700 allocated to interest + principal
    const activeAccrualsAfterConfirm = await prisma.loanPenaltyAccrual.findMany({
      where: { loanInstalmentId: inst1.id, reversedAt: null },
    })
    expect(activeAccrualsAfterConfirm).toHaveLength(0)

    const reversedAccruals = await prisma.loanPenaltyAccrual.findMany({
      where: { loanInstalmentId: inst1.id, reversedAt: { not: null } },
    })
    expect(reversedAccruals.length).toBeGreaterThanOrEqual(3)
    expect(reversedAccruals.every((a) => a.reversalReason === 'VALUE_DATE_RECALC')).toBe(true)

    const instAfterConfirm = await prisma.loanInstalment.findUniqueOrThrow({
      where: { id: inst1.id },
    })
    expect(instAfterConfirm.penaltyPaid.toNumber()).toBe(0)
    expect(instAfterConfirm.interestPaid.toNumber()).toBe(8700)
    expect(instAfterConfirm.principalPaid.toNumber()).toBe(30000)
    expect(instAfterConfirm.penaltyAssessed.toNumber()).toBe(0)
    expect(instAfterConfirm.status).toBe(PaymentPeriodStatus.COMPLETED)

    // Step 5: Reverse the confirmed payment -> recalculateLateness re-accrues the penalties!
    await reversePayment({
      paymentId: confirmRes.payment.id,
      reversedById: reviewerUser.id,
      reversalReason: 'Returned bank transfer',
    })

    const latenessAfterReversal = await recalculateLateness({
      obligationType: 'LOAN',
      obligationId: loan.id,
      asOf: parseDateOnly('2026-02-11'),
      actorId: reviewerUser.id,
      reverseAccrualsAfterAsOf: true,
    })
    expect(latenessAfterReversal.penaltiesAssessedNet.toNumber()).toBe(4500)

    const activeAccrualsAfterReversal = await prisma.loanPenaltyAccrual.findMany({
      where: { loanInstalmentId: inst1.id, reversedAt: null },
    })
    expect(activeAccrualsAfterReversal).toHaveLength(3)
  })

  it('marks regular savings period interestForfeited after grace and restores deposit lot interest when a backdated payment inside grace is confirmed', async () => {
    const member = await createTestMember('sav_forfeit_member')
    await creditMemberWallet(member.id, 15000, 'sav_forfeit_p1')

    const savings = await prisma.savings.create({
      data: {
        userId: member.id,
        savingsType: SavingsType.REGULAR,
        targetAmount: 10000,
        frequency: SavingsFrequency.MONTHLY,
        durationMonths: 6,
        ratePercentSnapshot: 6.0,
        rateVersionSnapshot: 1,
        startDate: parseDateOnly('2026-01-01'),
        maturityDate: parseDateOnly('2026-06-30'),
        status: SavingsStatus.ACTIVE,
      },
    })

    const p1 = await prisma.savingsPeriod.create({
      data: {
        savingsId: savings.id,
        periodNumber: 1,
        dueDate: parseDateOnly('2026-01-01'),
        amountDue: 10000,
        status: PaymentPeriodStatus.PENDING,
      },
    })

    const p2 = await prisma.savingsPeriod.create({
      data: {
        savingsId: savings.id,
        periodNumber: 2,
        dueDate: parseDateOnly('2026-02-01'),
        amountDue: 10000,
        status: PaymentPeriodStatus.PENDING,
      },
    })

    // Pay Period 1 in full (₦10,000) and Period 2 partially (₦5,000) on time
    await applyWallet({
      memberId: member.id,
      mode: 'MEMBER',
      targetType: AllocationTargetType.SAVINGS,
      targetId: savings.id,
      periodId: p1.id,
      amount: 10000,
      asOf: parseDateOnly('2026-01-01'),
      idempotencyKey: `sav-p1-${Date.now()}`,
      actorId: member.id,
    })

    await applyWallet({
      memberId: member.id,
      mode: 'MEMBER',
      targetType: AllocationTargetType.SAVINGS,
      targetId: savings.id,
      periodId: p2.id,
      amount: 5000,
      asOf: parseDateOnly('2026-02-01'),
      idempotencyKey: `sav-p2-part-${Date.now()}`,
      actorId: member.id,
    })

    const lot1Initial = await prisma.savingsLot.findFirstOrThrow({
      where: { savingsId: savings.id, savingsPeriodId: p1.id },
    })
    const lot2Initial = await prisma.savingsLot.findFirstOrThrow({
      where: { savingsId: savings.id, savingsPeriodId: p2.id },
    })
    expect(lot1Initial.interestBearing).toBe(true)
    expect(lot2Initial.interestBearing).toBe(true)

    // Evaluate lateness on 2026-02-10 (past period 2's grace window end 2026-02-08)
    const resLate = await recalculateLateness({
      obligationType: 'SAVINGS',
      obligationId: savings.id,
      asOf: parseDateOnly('2026-02-10'),
      actorId: reviewerUser.id,
    })
    expect(resLate.savingsForfeitedCount).toBe(1)

    const p2Late = await prisma.savingsPeriod.findUniqueOrThrow({ where: { id: p2.id } })
    expect(p2Late.interestForfeited).toBe(true)

    // Per A-07, Period 1's lot remains interest-bearing while Period 2's lot is forfeited
    const lot1Late = await prisma.savingsLot.findUniqueOrThrow({ where: { id: lot1Initial.id } })
    expect(lot1Late.interestBearing).toBe(true)

    const lot2Late = await prisma.savingsLot.findUniqueOrThrow({ where: { id: lot2Initial.id } })
    expect(lot2Late.interestBearing).toBe(false)
    expect(lot2Late.forfeitReason).toBe('PERIOD_LATE')

    // Now submit & confirm the remaining ₦5,000 for Period 2 with valueDate = 2026-02-05 (inside grace!)
    const sub = await createHistoricalSubmission({
      memberId: member.id,
      claimedAmount: 5000,
      paidOn: parseDateOnly('2026-02-05'),
      targetType: AllocationTargetType.SAVINGS,
      targetId: savings.id,
      targetPeriodId: p2.id,
      tag: 'sav_p2_sub',
    })

    await confirmPaymentSubmission({
      submissionId: sub.id,
      confirmedById: reviewerUser.id,
      confirmedAmount: 5000,
      valueDate: parseDateOnly('2026-02-05'),
    })

    // Period 2 forfeiture must be cleared and Period 2's lot restored to interestBearing = true!
    const p2Restored = await prisma.savingsPeriod.findUniqueOrThrow({ where: { id: p2.id } })
    expect(p2Restored.interestForfeited).toBe(false)
    expect(p2Restored.status).toBe(PaymentPeriodStatus.COMPLETED)

    const lot2Restored = await prisma.savingsLot.findUniqueOrThrow({
      where: { id: lot2Initial.id },
    })
    expect(lot2Restored.interestBearing).toBe(true)
    expect(lot2Restored.forfeitReason).toBeNull()
  })

  it('recognizes scheduled loan interest idempotently via runInterestRecognitionJob including on early-settled COMPLETED loans (OQ-14)', async () => {
    const member = await createTestMember('oq14_member')

    const loan = await prisma.loan.create({
      data: {
        userId: member.id,
        requestedAmount: 100000,
        approvedAmount: 100000,
        duration: 2,
        interestRate: 2.5,
        purpose: 'Equipment',
        status: LoanStatus.COMPLETED, // Early-settled before instalment 2 due date
        disbursedAt: parseDateOnly('2026-01-01'),
        latePenaltyDailyPercent: 0.5,
        penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
        penaltyCapValue: 10,
      },
    })

    const inst1 = await prisma.loanInstalment.create({
      data: {
        loanId: loan.id,
        instalmentNumber: 1,
        dueDate: parseDateOnly('2026-02-01'),
        principalDue: 50000,
        interestDue: 2500,
        principalPaid: 50000,
        interestPaid: 2500,
        status: PaymentPeriodStatus.COMPLETED,
      },
    })

    const inst2 = await prisma.loanInstalment.create({
      data: {
        loanId: loan.id,
        instalmentNumber: 2,
        dueDate: parseDateOnly('2026-03-01'),
        principalDue: 50000,
        interestDue: 2500,
        principalPaid: 50000,
        interestPaid: 2500,
        status: PaymentPeriodStatus.COMPLETED,
      },
    })

    // Run as of 2026-02-01 -> recognizes inst1 only
    await runInterestRecognitionJob({
      asOf: parseDateOnly('2026-02-01'),
      actorId: reviewerUser.id,
    })

    const inst1AfterFeb = await prisma.loanInstalment.findUniqueOrThrow({ where: { id: inst1.id } })
    const inst2AfterFeb = await prisma.loanInstalment.findUniqueOrThrow({ where: { id: inst2.id } })
    expect(inst1AfterFeb.interestRecognisedAt).not.toBeNull()
    expect(inst2AfterFeb.interestRecognisedAt).toBeNull()

    // Re-run as of 2026-02-01 -> idempotent
    const replayFeb = await runInterestRecognitionJob({
      asOf: parseDateOnly('2026-02-01'),
      actorId: reviewerUser.id,
    })
    expect(replayFeb.recognisedInstalments).toBe(0)

    // Run as of 2026-03-01 -> recognizes inst2 even though loan is COMPLETED (OQ-14)
    await runInterestRecognitionJob({
      asOf: parseDateOnly('2026-03-01'),
      actorId: reviewerUser.id,
    })
    const inst2AfterMar = await prisma.loanInstalment.findUniqueOrThrow({ where: { id: inst2.id } })
    expect(inst2AfterMar.interestRecognisedAt).not.toBeNull()
  })
})
