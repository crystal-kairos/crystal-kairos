import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { Prisma } from '@/generated/prisma/client'
import {
  PaymentPeriodStatus,
  SavingsFrequency,
  SavingsMaturity,
  SavingsType,
  UserRole,
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
  generateAndPersistLoanSchedule,
  generateAndPersistSavingsSchedule,
  generateAndPersistEAjoSchedule,
  getLoanInstalmentOutstanding,
  getSavingsPeriodOutstanding,
  getEAjoPeriodOutstanding,
  computePeriodStatus,
  recordLoanPenaltyAccrual,
  reverseLoanPenaltyAccrual,
  recordEAjoPenaltyAccrual,
  reverseEAjoPenaltyAccrual,
  getLoanSchedule,
  getSavingsSchedule,
  getEAjoSchedule,
} from '@/lib/services/schedules.service'
import { formatDateOnly, addMonthsClamped } from '@/lib/domain/dates'

describe('Payment Schedules & Period Persistence Integration (PR P2-03, §2.6, §2.9)', () => {
  const timestamp = Date.now()
  const testEmailPrefix = `test-p203-${timestamp}`

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
      // Clean up loan penalty accruals and instalments
      const loans = await prisma.loan.findMany({
        where: { userId: { in: userIds } },
        select: { id: true },
      })
      const loanIds = loans.map((l) => l.id)
      if (loanIds.length > 0) {
        const instalments = await prisma.loanInstalment.findMany({
          where: { loanId: { in: loanIds } },
          select: { id: true },
        })
        const instIds = instalments.map((i) => i.id)
        if (instIds.length > 0) {
          await prisma.loanPenaltyAccrual.deleteMany({
            where: { loanInstalmentId: { in: instIds } },
          })
          await prisma.loanInstalment.deleteMany({
            where: { id: { in: instIds } },
          })
        }
        await prisma.transaction.deleteMany({
          where: { loanId: { in: loanIds } },
        })
        await prisma.loan.deleteMany({
          where: { id: { in: loanIds } },
        })
      }

      // Clean up savings periods
      const savings = await prisma.savings.findMany({
        where: { userId: { in: userIds } },
        select: { id: true },
      })
      const savingsIds = savings.map((s) => s.id)
      if (savingsIds.length > 0) {
        await prisma.savingsPeriod.deleteMany({
          where: { savingsId: { in: savingsIds } },
        })
        await prisma.transaction.deleteMany({
          where: { savingsId: { in: savingsIds } },
        })
        await prisma.savings.deleteMany({
          where: { id: { in: savingsIds } },
        })
      }

      // Clean up E-Ajo contribution periods
      const eajoMembers = await prisma.eAjoMember.findMany({
        where: { userId: { in: userIds } },
        select: { id: true },
      })
      const eajoMemberIds = eajoMembers.map((m) => m.id)
      if (eajoMemberIds.length > 0) {
        const contributionPeriods =
          await prisma.eAjoContributionPeriod.findMany({
            where: { eajoMemberId: { in: eajoMemberIds } },
            select: { id: true },
          })
        const periodIds = contributionPeriods.map((p) => p.id)
        if (periodIds.length > 0) {
          await prisma.eAjoPenaltyAccrual.deleteMany({
            where: { eajoContributionPeriodId: { in: periodIds } },
          })
          await prisma.eAjoContributionPeriod.deleteMany({
            where: { id: { in: periodIds } },
          })
        }
        await prisma.transaction.deleteMany({
          where: { eAjoMemberId: { in: eajoMemberIds } },
        })
        await prisma.eAjoMember.deleteMany({
          where: { id: { in: eajoMemberIds } },
        })
      }

      await prisma.eAjoGroup.deleteMany({
        where: { createdBy: { in: userIds } },
      })

      // Delete test users
      await prisma.user.deleteMany({
        where: { id: { in: userIds } },
      })
    }
  })

  it('enforces PostgreSQL CHECK constraints on schedule tables', async () => {
    const member = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-check-member@example.com`,
        name: 'Check Member',
        role: UserRole.USER,
        hasSetPassword: true,
      },
    })

    const loan = await prisma.loan.create({
      data: {
        userId: member.id,
        requestedAmount: new Prisma.Decimal('100000.00'),
        approvedAmount: new Prisma.Decimal('100000.00'),
        interestRate: new Prisma.Decimal('5.0000'),
        duration: 3,
        purpose: 'Check constraint test',
      },
    })

    // 1. Attempt to insert negative principalDue into loan_instalments
    await expect(
      prisma.$executeRaw`
        INSERT INTO "loan_instalments" (
          "id", "loanId", "instalmentNumber", "dueDate", "principalDue", "interestDue", "status", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${loan.id}, 99, '2027-01-01'::date, -500.00, 100.00, 'PENDING', NOW(), NOW()
        )
      `,
    ).rejects.toThrow(/chk_loan_instalments_amounts_non_negative/i)

    // 2. Attempt to insert negative amountDue into savings_periods
    const savings = await prisma.savings.create({
      data: {
        userId: member.id,
        savingsType: SavingsType.REGULAR,
        frequency: SavingsFrequency.MONTHLY,
        maturity: SavingsMaturity.THREE_MONTHS,
        interestRate: new Prisma.Decimal('2.2500'),
        targetAmount: new Prisma.Decimal('20000.00'),
        bankName: 'GTB',
        accountNumber: '0123456789',
        accountName: 'Check Member',
      },
    })

    await expect(
      prisma.$executeRaw`
        INSERT INTO "savings_periods" (
          "id", "savingsId", "periodNumber", "dueDate", "amountDue", "status", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${savings.id}, 99, '2027-01-01'::date, -100.00, 'PENDING', NOW(), NOW()
        )
      `,
    ).rejects.toThrow(/chk_savings_periods_amounts_non_negative/i)

    // 3. Attempt to insert zero or negative penalty into loan_penalty_accruals
    const instalment = await prisma.loanInstalment.create({
      data: {
        loanId: loan.id,
        instalmentNumber: 1,
        dueDate: new Date('2027-02-10'),
        principalDue: new Prisma.Decimal('33333.33'),
        interestDue: new Prisma.Decimal('5000.00'),
      },
    })

    await expect(
      prisma.$executeRaw`
        INSERT INTO "loan_penalty_accruals" (
          "id", "loanInstalmentId", "penaltyDate", "amount", "createdAt"
        ) VALUES (
          gen_random_uuid()::text, ${instalment.id}, '2027-02-18'::date, 0.00, NOW()
        )
      `,
    ).rejects.toThrow(/chk_loan_penalty_accruals_amount_positive/i)
  })

  it('persists loan instalment schedule with rounding remainder and idempotency (§2.9, §2.6)', async () => {
    const member = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-loan-member@example.com`,
        name: 'Loan Test Member',
        role: UserRole.USER,
        hasSetPassword: true,
      },
    })

    const loan = await prisma.loan.create({
      data: {
        userId: member.id,
        requestedAmount: new Prisma.Decimal('300000.00'),
        approvedAmount: new Prisma.Decimal('300000.00'),
        interestRate: new Prisma.Decimal('5.0000'),
        duration: 6,
        purpose: 'Working capital',
      },
    })

    // 1. Generate and persist schedule inside transaction
    const instalments = await prisma.$transaction(async (tx) => {
      return generateAndPersistLoanSchedule(tx, {
        loanId: loan.id,
        principal: loan.approvedAmount!,
        termMonths: loan.duration,
        monthlyInterestRatePercent: loan.interestRate,
        disbursementValueDate: '2027-01-10',
      })
    })

    expect(instalments).toHaveLength(6)
    expect(instalments[0].instalmentNumber).toBe(1)
    expect(formatDateOnly(instalments[0].dueDate)).toBe('2027-02-10')
    expect(instalments[0].principalDue.toFixed(2)).toBe('50000.00')
    expect(instalments[0].interestDue.toFixed(2)).toBe('15000.00')
    expect(instalments[0].status).toBe(PaymentPeriodStatus.PENDING)

    // 2. Idempotency test: re-calling generateAndPersistLoanSchedule returns existing without error or duplication
    const secondCall = await prisma.$transaction(async (tx) => {
      return generateAndPersistLoanSchedule(tx, {
        loanId: loan.id,
        principal: loan.approvedAmount!,
        termMonths: loan.duration,
        monthlyInterestRatePercent: loan.interestRate,
        disbursementValueDate: '2027-01-10',
      })
    })
    expect(secondCall).toHaveLength(6)

    const allInDb = await prisma.loanInstalment.findMany({
      where: { loanId: loan.id },
    })
    expect(allInDb).toHaveLength(6) // No duplicate rows created

    // 3. Database unique constraint test: cannot insert duplicate instalmentNumber
    await expect(
      prisma.loanInstalment.create({
        data: {
          loanId: loan.id,
          instalmentNumber: 1, // Already exists!
          dueDate: new Date('2027-02-10'),
          principalDue: new Prisma.Decimal('50000.00'),
          interestDue: new Prisma.Decimal('15000.00'),
        },
      }),
    ).rejects.toThrow()
  })

  it('persists savings periods for monthly, weekly, and daily frequencies (§2.6)', async () => {
    const member = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-sav-member@example.com`,
        name: 'Savings Member',
        role: UserRole.USER,
        hasSetPassword: true,
      },
    })

    // 1. Monthly savings (3 months)
    const monthlySav = await prisma.savings.create({
      data: {
        userId: member.id,
        savingsType: SavingsType.REGULAR,
        frequency: SavingsFrequency.MONTHLY,
        maturity: SavingsMaturity.THREE_MONTHS,
        targetAmount: new Prisma.Decimal('25000.00'),
        interestRate: new Prisma.Decimal('2.2500'),
        bankName: 'Access Bank',
        accountNumber: '1122334455',
        accountName: 'Savings Member',
      },
    })

    const monthlyPeriods = await prisma.$transaction(async (tx) => {
      return generateAndPersistSavingsSchedule(tx, {
        savingsId: monthlySav.id,
        savingsType: monthlySav.savingsType,
        frequency: monthlySav.frequency,
        maturity: monthlySav.maturity,
        targetAmount: monthlySav.targetAmount!,
        firstDepositValueDate: '2027-01-15',
      })
    })
    expect(monthlyPeriods).toHaveLength(3)
    expect(formatDateOnly(monthlyPeriods[0].dueDate)).toBe('2027-01-15') // Period 1 on start date
    expect(formatDateOnly(monthlyPeriods[1].dueDate)).toBe('2027-02-15')
    expect(formatDateOnly(monthlyPeriods[2].dueDate)).toBe('2027-03-15')

    // 2. Weekly savings (1 month starting 2027-02-01) -> strictly before maturity date 2027-03-01
    const weeklySav = await prisma.savings.create({
      data: {
        userId: member.id,
        savingsType: SavingsType.REGULAR,
        frequency: SavingsFrequency.WEEKLY,
        maturity: SavingsMaturity.ONE_MONTH,
        targetAmount: new Prisma.Decimal('5000.00'),
        interestRate: new Prisma.Decimal('0.7500'),
        bankName: 'Access Bank',
        accountNumber: '1122334455',
        accountName: 'Savings Member',
      },
    })

    const weeklyPeriods = await prisma.$transaction(async (tx) => {
      return generateAndPersistSavingsSchedule(tx, {
        savingsId: weeklySav.id,
        savingsType: weeklySav.savingsType,
        frequency: weeklySav.frequency,
        maturity: weeklySav.maturity,
        targetAmount: weeklySav.targetAmount!,
        firstDepositValueDate: '2027-02-01',
      })
    })
    // 2027-02-01, 2027-02-08, 2027-02-15, 2027-02-22 (strictly 4 periods before 2027-03-01)
    expect(weeklyPeriods).toHaveLength(4)
    expect(weeklyPeriods.map((p) => formatDateOnly(p.dueDate))).toEqual([
      '2027-02-01',
      '2027-02-08',
      '2027-02-15',
      '2027-02-22',
    ])

    // 3. FIXED upfront savings: exactly 1 period
    const fixedSav = await prisma.savings.create({
      data: {
        userId: member.id,
        savingsType: SavingsType.FIXED,
        frequency: SavingsFrequency.ONCE,
        maturity: SavingsMaturity.SIX_MONTHS,
        targetAmount: new Prisma.Decimal('500000.00'),
        interestRate: new Prisma.Decimal('12.0000'),
        bankName: 'Access Bank',
        accountNumber: '1122334455',
        accountName: 'Savings Member',
      },
    })

    const fixedPeriods = await prisma.$transaction(async (tx) => {
      return generateAndPersistSavingsSchedule(tx, {
        savingsId: fixedSav.id,
        savingsType: fixedSav.savingsType,
        frequency: fixedSav.frequency,
        maturity: fixedSav.maturity,
        targetAmount: fixedSav.targetAmount!,
        firstDepositValueDate: '2027-01-10',
      })
    })
    expect(fixedPeriods).toHaveLength(1)
    expect(formatDateOnly(fixedPeriods[0].dueDate)).toBe('2027-01-10')
    expect(fixedPeriods[0].amountDue.toFixed(2)).toBe('500000.00')
  })

  it('persists E-Ajo contribution periods and enforces period uniqueness', async () => {
    const creator = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-eajo-creator@example.com`,
        name: 'EAjo Creator',
        role: UserRole.USER,
        hasSetPassword: true,
      },
    })

    const group = await prisma.eAjoGroup.create({
      data: {
        title: 'Q1 Rotating Savings',
        contributionAmount: new Prisma.Decimal('20000.00'),
        totalSlots: 4,
        frequency: 'MONTHLY',
        duration: 'FOUR_MONTHS',
        startDate: new Date('2027-01-15'),
        createdBy: creator.id,
      },
    })

    const member = await prisma.eAjoMember.create({
      data: {
        groupId: group.id,
        userId: creator.id,
        payoutPosition: 2,
        guarantorName: 'Guarantor Name',
        guarantorPhoneNumber: '+2348011112222',
        bankName: 'First Bank',
        accountNumber: '0011223344',
        accountName: 'EAjo Creator',
      },
    })

    const periods = await prisma.$transaction(async (tx) => {
      return generateAndPersistEAjoSchedule(tx, {
        eAjoMemberId: member.id,
        contributionAmount: group.contributionAmount,
        totalSlots: group.totalSlots,
        groupStartDate: group.startDate!,
      })
    })

    expect(periods).toHaveLength(4)
    expect(periods.map((p) => formatDateOnly(p.dueDate))).toEqual([
      '2027-01-15',
      '2027-02-15',
      '2027-03-15',
      '2027-04-15',
    ])

    // Duplicate period insertion throws
    await expect(
      prisma.eAjoContributionPeriod.create({
        data: {
          eajoMemberId: member.id,
          periodNumber: 1, // Duplicate
          dueDate: new Date('2027-01-15'),
          contributionDue: new Prisma.Decimal('20000.00'),
        },
      }),
    ).rejects.toThrow()
  })

  it('records, enforces uniqueness, and reverses penalty accruals atomically (§2.6, §2.10)', async () => {
    const member = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-penalty-member@example.com`,
        name: 'Penalty Member',
        role: UserRole.USER,
        hasSetPassword: true,
      },
    })

    const loan = await prisma.loan.create({
      data: {
        userId: member.id,
        requestedAmount: new Prisma.Decimal('200000.00'),
        approvedAmount: new Prisma.Decimal('200000.00'),
        interestRate: new Prisma.Decimal('5.0000'),
        duration: 4,
        purpose: 'Inventory',
      },
    })

    const [instalment] = await prisma.$transaction(async (tx) => {
      return generateAndPersistLoanSchedule(tx, {
        loanId: loan.id,
        principal: loan.approvedAmount!,
        termMonths: loan.duration,
        monthlyInterestRatePercent: loan.interestRate,
        disbursementValueDate: '2027-01-10',
      })
    })

    expect(instalment.penaltyAssessed.toFixed(2)).toBe('0.00')

    // 1. Record Day 1 penalty accrual
    const penaltyDate = '2027-02-18' // Day +8 boundary
    const penaltyAmount = '1000.00'

    const recordResult = await prisma.$transaction(async (tx) => {
      return recordLoanPenaltyAccrual(tx, {
        loanInstalmentId: instalment.id,
        penaltyDate,
        amount: penaltyAmount,
      })
    })

    expect(recordResult.accrual.amount.toFixed(2)).toBe('1000.00')
    expect(recordResult.instalment.penaltyAssessed.toFixed(2)).toBe('1000.00')

    // 2. Uniqueness test: attempting to record another penalty for the exact same instalment and date throws
    await expect(
      prisma.$transaction(async (tx) => {
        return recordLoanPenaltyAccrual(tx, {
          loanInstalmentId: instalment.id,
          penaltyDate,
          amount: '1000.00',
        })
      }),
    ).rejects.toThrow()

    // 3. Reverse penalty accrual (e.g. retroactive value-date confirmation)
    const reverseResult = await prisma.$transaction(async (tx) => {
      return reverseLoanPenaltyAccrual(tx, {
        loanInstalmentId: instalment.id,
        penaltyDate,
        reason: 'VALUE_DATE_RECALC: receipt confirmed with prior paidOn',
      })
    })

    expect(reverseResult).not.toBeNull()
    expect(reverseResult!.accrual.reversedAt).not.toBeNull()
    expect(reverseResult!.accrual.reversalReason).toContain('VALUE_DATE_RECALC')
    expect(reverseResult!.instalment.penaltyAssessed.toFixed(2)).toBe('0.00') // Decremented back to 0
  })

  it('correctly calculates outstanding amounts and dynamic period statuses', () => {
    // 1. Outstanding calculation for Loan instalment
    const loanOutstanding = getLoanInstalmentOutstanding({
      principalDue: '50000.00',
      principalPaid: '20000.00',
      interestDue: '15000.00',
      interestPaid: '5000.00',
      penaltyAssessed: '3000.00',
      penaltyPaid: '1000.00',
      penaltyWaived: '500.00',
    })

    expect(loanOutstanding.principalOutstanding.toFixed(2)).toBe('30000.00')
    expect(loanOutstanding.interestOutstanding.toFixed(2)).toBe('10000.00')
    expect(loanOutstanding.penaltyOutstanding.toFixed(2)).toBe('1500.00')
    expect(loanOutstanding.totalOutstanding.toFixed(2)).toBe('41500.00')

    // 2. Status determination
    // A. Fully paid -> COMPLETED
    const completedStatus = computePeriodStatus({
      dueDate: '2026-01-10',
      totalOutstanding: new Prisma.Decimal(0),
      totalPaid: new Prisma.Decimal('65000.00'),
    })
    expect(completedStatus).toBe(PaymentPeriodStatus.COMPLETED)

    // B. Partially paid before due date -> ONGOING
    const ongoingStatus = computePeriodStatus({
      dueDate: '2030-01-10',
      totalOutstanding: new Prisma.Decimal('25000.00'),
      totalPaid: new Prisma.Decimal('40000.00'),
      today: '2027-01-01',
    })
    expect(ongoingStatus).toBe(PaymentPeriodStatus.ONGOING)

    // C. Nothing paid before due date -> PENDING
    const pendingStatus = computePeriodStatus({
      dueDate: '2030-01-10',
      totalOutstanding: new Prisma.Decimal('65000.00'),
      totalPaid: new Prisma.Decimal(0),
      today: '2027-01-01',
    })
    expect(pendingStatus).toBe(PaymentPeriodStatus.PENDING)

    // D. Due date past with outstanding amount -> OVERDUE
    const overdueStatus = computePeriodStatus({
      dueDate: '2026-01-10',
      totalOutstanding: new Prisma.Decimal('10000.00'),
      totalPaid: new Prisma.Decimal('55000.00'),
      today: '2026-02-01',
    })
    expect(overdueStatus).toBe(PaymentPeriodStatus.OVERDUE)

    // E. Due date past with outstanding amount BUT under review shield (D-01) -> IN_REVIEW
    const shieldedStatus = computePeriodStatus({
      dueDate: '2026-01-10',
      totalOutstanding: new Prisma.Decimal('10000.00'),
      totalPaid: new Prisma.Decimal('55000.00'),
      isShielded: true,
      today: '2026-02-01',
    })
    expect(shieldedStatus).toBe(PaymentPeriodStatus.IN_REVIEW)
  })
})
