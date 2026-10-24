import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { Prisma } from '@/generated/prisma/client'
import {
  LedgerAccountType,
  UserRole,
  WalletWithdrawalStatus,
} from '@/generated/prisma/enums'

const mockSessionState = vi.hoisted(() => ({
  session: null as {
    user?: {
      id: string
      email: string
      name: string
      role: UserRole
      sessionVersion?: number
    }
  } | null,
}))

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => mockSessionState.session),
}))

import { prisma } from '@/lib/prisma'
import {
  assertBalanced,
  postJournalEntry,
  reverseJournalEntry,
  postSavingsDeposit,
  postWalletCredit,
  postLoanDisbursement,
  postLoanRepayment,
  postEajoPayout,
  postReversalWithShortfall,
} from '@/lib/services/ledger.service'
import {
  getWalletBalance,
  getWalletHolds,
  getWalletSummary,
  assertSufficientWallet,
  requestWalletWithdrawal,
} from '@/lib/services/wallet.service'
import { lockMembers, transition } from '@/lib/db/concurrency'
import { roundMoney } from '@/lib/domain/money'

describe('Operational Double-Entry Ledger, Wallet & Concurrency (PR P2-02, §2.12)', () => {
  const timestamp = Date.now()
  const testEmailPrefix = `test-p202-${timestamp}`

  beforeEach(() => {
    delete process.env.MOCK_SESSION_USER
  })

  afterAll(async () => {
    const testUsers = await prisma.user.findMany({
      where: { email: { startsWith: testEmailPrefix } },
      select: { id: true },
    })
    const userIds = testUsers.map((u) => u.id)

    if (userIds.length > 0) {
      // 1. Delete withdrawals
      await prisma.walletWithdrawal.deleteMany({
        where: { memberId: { in: userIds } },
      })

      // 2. Delete journal lines and journal entries
      const entries = await prisma.journalEntry.findMany({
        where: {
          OR: [
            { lines: { some: { memberId: { in: userIds } } } },
            { postedById: { in: userIds } },
            { idempotencyKey: { startsWith: `p202-${timestamp}` } },
          ],
        },
        select: { id: true },
      })
      const entryIds = entries.map((e) => e.id)

      if (entryIds.length > 0) {
        await prisma.journalLine.deleteMany({
          where: { journalEntryId: { in: entryIds } },
        })
        // Break reversalOf self-relation before deleting entries
        await prisma.journalEntry.updateMany({
          where: { id: { in: entryIds } },
          data: { reversalOfId: null },
        })
        await prisma.journalEntry.deleteMany({
          where: { id: { in: entryIds } },
        })
      }

      // 3. Delete bank accounts and users
      await prisma.bankAccount.deleteMany({
        where: { userId: { in: userIds } },
      })
      await prisma.user.deleteMany({
        where: { id: { in: userIds } },
      })
    }
  })

  it('rejects unbalanced journal entries and multi-currency entries (§2.12)', () => {
    // 1. Fewer than 2 lines
    expect(() =>
      assertBalanced([
        {
          accountType: LedgerAccountType.COOPERATIVE_CASH,
          debit: 1000,
          credit: 0,
        },
      ]),
    ).toThrowError(/at least two lines/i)

    // 2. Unbalanced amounts
    expect(() =>
      assertBalanced([
        {
          accountType: LedgerAccountType.COOPERATIVE_CASH,
          debit: 1000,
          credit: 0,
        },
        {
          accountType: LedgerAccountType.MEMBER_WALLET_LIABILITY,
          debit: 0,
          credit: 950,
        },
      ]),
    ).toThrowError(/debits must equal credits/i)

    // 3. Multi-currency entry
    expect(() =>
      assertBalanced([
        {
          accountType: LedgerAccountType.COOPERATIVE_CASH,
          debit: 100,
          credit: 0,
          currency: 'NGN',
        },
        {
          accountType: LedgerAccountType.MEMBER_WALLET_LIABILITY,
          debit: 0,
          credit: 100,
          currency: 'USD',
        },
      ]),
    ).toThrowError(/multi-currency/i)

    // 4. Line with both debit and credit
    expect(() =>
      assertBalanced([
        {
          accountType: LedgerAccountType.COOPERATIVE_CASH,
          debit: 100,
          credit: 50,
        },
        {
          accountType: LedgerAccountType.MEMBER_WALLET_LIABILITY,
          debit: 0,
          credit: 50,
        },
      ]),
    ).toThrowError(/either debit or credit, not both/i)
  })

  it('enforces PostgreSQL CHECK constraints on journal_lines table', async () => {
    const entryId = `test-chk-entry-${timestamp}`

    // Create entry header
    await prisma.journalEntry.create({
      data: {
        id: entryId,
        sourceType: 'TEST',
        sourceId: 'test-source',
        idempotencyKey: `p202-${timestamp}-chk-hdr`,
        description: 'Test CHECK constraint',
        effectiveDate: new Date(),
      },
    })

    // 1. Attempt inserting negative debit -> rejected by raw DB check constraint
    await expect(
      prisma.$executeRaw`
        INSERT INTO "journal_lines" ("id", "journalEntryId", "accountType", "debit", "credit", "currency", "createdAt")
        VALUES (gen_random_uuid()::text, ${entryId}, 'COOPERATIVE_CASH'::"LedgerAccountType", -50.00, 0.00, 'NGN', NOW())
      `,
    ).rejects.toThrowError(/chk_journal_lines_debit_credit_valid/i)

    // 2. Attempt inserting line with both debit > 0 and credit > 0 -> rejected by raw DB check constraint
    await expect(
      prisma.$executeRaw`
        INSERT INTO "journal_lines" ("id", "journalEntryId", "accountType", "debit", "credit", "currency", "createdAt")
        VALUES (gen_random_uuid()::text, ${entryId}, 'COOPERATIVE_CASH'::"LedgerAccountType", 50.00, 50.00, 'NGN', NOW())
      `,
    ).rejects.toThrowError(/chk_journal_lines_debit_credit_valid/i)

    // Clean up test entry
    await prisma.journalEntry.delete({ where: { id: entryId } })
  })

  it('atomically posts balanced journal entries and enforces idempotency replay', async () => {
    const key = `p202-${timestamp}-idempotency-test`

    const postAction = async () => {
      return prisma.$transaction(async (tx) => {
        return postJournalEntry(tx, {
          sourceType: 'TEST_DEPOSIT',
          sourceId: 'dep-123',
          idempotencyKey: key,
          description: 'Idempotency test entry',
          effectiveDate: new Date(),
          lines: [
            {
              accountType: LedgerAccountType.COOPERATIVE_CASH,
              debit: '5000.00',
              credit: 0,
            },
            {
              accountType: LedgerAccountType.MEMBER_WALLET_LIABILITY,
              debit: 0,
              credit: '5000.00',
            },
          ],
        })
      })
    }

    const firstResult = await postAction()
    expect(firstResult.id).toBeDefined()
    expect(firstResult.lines).toHaveLength(2)

    // Second call with same idempotency key must return the exact same entry without duplicate rows
    const secondResult = await postAction()
    expect(secondResult.id).toBe(firstResult.id)

    const countInDb = await prisma.journalEntry.count({
      where: { idempotencyKey: key },
    })
    expect(countInDb).toBe(1)
  })

  it('posts typed entries for savings, loan repayment, and e-ajo payout', async () => {
    const member = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-ledger-member@example.com`,
        name: 'Ledger Member',
        role: UserRole.USER,
        hasSetPassword: true,
      },
    })

    // 1. Post savings deposit
    const savingsPost = await prisma.$transaction(async (tx) => {
      return postSavingsDeposit(tx, {
        amount: '25000.00',
        memberId: member.id,
        savingsId: 'savings-plan-1',
        effectiveDate: new Date(),
        idempotencyKey: `p202-${timestamp}-sav-dep`,
      })
    })
    expect(savingsPost.lines).toHaveLength(2)
    const cashLine = savingsPost.lines.find(
      (l: { accountType: LedgerAccountType }) => l.accountType === LedgerAccountType.COOPERATIVE_CASH,
    )
    const savLine = savingsPost.lines.find(
      (l: { accountType: LedgerAccountType }) => l.accountType === LedgerAccountType.SAVINGS_PRINCIPAL_LIABILITY,
    )
    expect(cashLine?.debit.toFixed(2)).toBe('25000.00')
    expect(savLine?.credit.toFixed(2)).toBe('25000.00')

    // 2. Post loan repayment (Allocated components)
    const loanPost = await prisma.$transaction(async (tx) => {
      return postLoanRepayment(tx, {
        memberId: member.id,
        loanId: 'loan-plan-1',
        penaltyPortion: '3000.00',
        interestPortion: '7000.00',
        principalPortion: '15000.00',
        effectiveDate: new Date(),
        idempotencyKey: `p202-${timestamp}-loan-rep`,
      })
    })
    expect(loanPost.lines).toHaveLength(4) // 1 debit (Cash: 25k) + 3 credits (penalty: 3k, interest: 7k, principal: 15k)
    const penLine = loanPost.lines.find(
      (l: { accountType: LedgerAccountType }) => l.accountType === LedgerAccountType.LOAN_PENALTY_RECEIVABLE,
    )
    expect(penLine?.credit.toFixed(2)).toBe('3000.00')

    // 3. Post E-Ajo payout matching C4 (Slot 2)
    const eajoPost = await prisma.$transaction(async (tx) => {
      return postEajoPayout(tx, {
        memberId: member.id,
        eAjoMemberId: 'eajo-mem-1',
        contributionsHeld: '20000.00',
        advanceAmount: '100000.00',
        netPayout: '110000.00',
        earlySlotPenalty: '10000.00',
        effectiveDate: new Date(),
        idempotencyKey: `p202-${timestamp}-eajo-pay`,
      })
    })
    expect(eajoPost.lines).toHaveLength(4)
    const advanceLine = eajoPost.lines.find(
      (l: { accountType: LedgerAccountType }) => l.accountType === LedgerAccountType.EAJO_ADVANCE_RECEIVABLE,
    )
    expect(advanceLine?.debit.toFixed(2)).toBe('100000.00')
    const penaltyIncomeLine = eajoPost.lines.find(
      (l: { accountType: LedgerAccountType }) => l.accountType === LedgerAccountType.EAJO_EARLY_SLOT_INCOME,
    )
    expect(penaltyIncomeLine?.credit.toFixed(2)).toBe('10000.00')
  })

  it('reverses an existing journal entry and rejects double-reversal', async () => {
    const key = `p202-${timestamp}-reversal-orig`
    const originalEntry = await prisma.$transaction(async (tx) => {
      return postJournalEntry(tx, {
        sourceType: 'TEST_PAYMENT',
        sourceId: 'pay-orig-1',
        idempotencyKey: key,
        description: 'Original payment to be reversed',
        effectiveDate: new Date(),
        lines: [
          {
            accountType: LedgerAccountType.COOPERATIVE_CASH,
            debit: '15000.00',
            credit: 0,
          },
          {
            accountType: LedgerAccountType.MEMBER_WALLET_LIABILITY,
            debit: 0,
            credit: '15000.00',
          },
        ],
      })
    })

    // Execute reversal
    const revKey = `p202-${timestamp}-reversal-rev`
    const reversal = await prisma.$transaction(async (tx) => {
      return reverseJournalEntry(tx, {
        originalJournalEntryId: originalEntry.id,
        idempotencyKey: revKey,
        reason: 'Customer initiated chargeback reversal',
      })
    })

    expect(reversal.reversalOfId).toBe(originalEntry.id)
    const revCash = reversal.lines.find(
      (l) => l.accountType === LedgerAccountType.COOPERATIVE_CASH,
    )
    const revWallet = reversal.lines.find(
      (l) => l.accountType === LedgerAccountType.MEMBER_WALLET_LIABILITY,
    )
    expect(revCash?.credit.toFixed(2)).toBe('15000.00')
    expect(revWallet?.debit.toFixed(2)).toBe('15000.00')

    // Attempting to reverse a second time must throw ALREADY_REVERSED
    await expect(
      prisma.$transaction(async (tx) => {
        return reverseJournalEntry(tx, {
          originalJournalEntryId: originalEntry.id,
          idempotencyKey: `p202-${timestamp}-reversal-second`,
          reason: 'Duplicate reversal attempt',
        })
      }),
    ).rejects.toThrowError(/already been reversed/i)
  })

  it('calculates member wallet balance from journal lines and enforces withdrawal holds', async () => {
    const member = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-wallet-holder@example.com`,
        name: 'Wallet Holder',
        role: UserRole.USER,
        hasSetPassword: true,
      },
    })

    const bankAcc = await prisma.bankAccount.create({
      data: {
        userId: member.id,
        bankName: 'GTBank',
        accountNumber: `058${String(timestamp).slice(-7)}`,
        accountName: 'Wallet Holder Payout',
        isPrimary: true,
      },
    })

    // 1. Initial wallet topup: Credit 50,000.00
    await prisma.$transaction(async (tx) => {
      return postWalletCredit(tx, {
        amount: '50000.00',
        memberId: member.id,
        effectiveDate: new Date(),
        idempotencyKey: `p202-${timestamp}-w-topup-1`,
      })
    })

    let summary = await getWalletSummary(member.id)
    expect(summary.totalBalance.toFixed(2)).toBe('50000.00')
    expect(summary.heldBalance.toFixed(2)).toBe('0.00')
    expect(summary.availableBalance.toFixed(2)).toBe('50000.00')

    // 2. Member requests withdrawal of 20,000.00 -> places a hold
    const withdrawal = await prisma.$transaction(async (tx) => {
      return requestWalletWithdrawal(tx, {
        memberId: member.id,
        amount: '20000.00',
        bankAccountId: bankAcc.id,
        idempotencyKey: `p202-${timestamp}-wth-1`,
      })
    })
    expect(withdrawal.status).toBe(WalletWithdrawalStatus.REQUESTED)

    summary = await getWalletSummary(member.id)
    expect(summary.totalBalance.toFixed(2)).toBe('50000.00')
    expect(summary.heldBalance.toFixed(2)).toBe('20000.00')
    expect(summary.availableBalance.toFixed(2)).toBe('30000.00')

    // 3. Attempting to withdraw 35,000.00 when available is 30,000.00 -> rejected
    await expect(
      prisma.$transaction(async (tx) => {
        return requestWalletWithdrawal(tx, {
          memberId: member.id,
          amount: '35000.00',
          bankAccountId: bankAcc.id,
          idempotencyKey: `p202-${timestamp}-wth-overdraft`,
        })
      }),
    ).rejects.toThrowError(/Insufficient available wallet balance/i)
  })

  it('demonstrates advisory lock coordination and atomic transition helper', async () => {
    const memberA = `mem-a-${timestamp}`
    const memberB = `mem-b-${timestamp}`

    // 1. Advisory locks take without error in sorted order
    await prisma.$transaction(async (tx) => {
      await lockMembers(tx, [memberB, memberA]) // Passed unsorted, locked sorted
    })

    // 2. Atomic transition helper on status-governed models
    const member = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-trans-user@example.com`,
        name: 'Transition Member',
        role: UserRole.USER,
        hasSetPassword: true,
      },
    })
    const bankAcc = await prisma.bankAccount.create({
      data: {
        userId: member.id,
        bankName: 'First Bank',
        accountNumber: `011${String(timestamp).slice(-7)}`,
        accountName: 'Transition Member Account',
      },
    })
    const withdrawal = await prisma.walletWithdrawal.create({
      data: {
        withdrawalNumber: `WTH-TST-${timestamp}`,
        memberId: member.id,
        amount: new Prisma.Decimal('100.00'),
        bankAccountId: bankAcc.id,
        status: WalletWithdrawalStatus.REQUESTED,
        idempotencyKey: `p202-${timestamp}-wth-trans-dummy`,
      },
    })

    // Transition from REQUESTED to APPROVED
    await transition(
      prisma.walletWithdrawal,
      withdrawal.id,
      WalletWithdrawalStatus.REQUESTED,
      { status: WalletWithdrawalStatus.APPROVED },
    )

    const updated = await prisma.walletWithdrawal.findUniqueOrThrow({
      where: { id: withdrawal.id },
    })
    expect(updated.status).toBe(WalletWithdrawalStatus.APPROVED)

    // Transitioning again from REQUESTED must fail with STALE_STATE
    await expect(
      transition(
        prisma.walletWithdrawal,
        withdrawal.id,
        WalletWithdrawalStatus.REQUESTED,
        { status: WalletWithdrawalStatus.REJECTED },
      ),
    ).rejects.toThrowError(/already changed/i)
  })
})
