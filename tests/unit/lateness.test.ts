import { describe, expect, it } from 'vitest'
import { Prisma } from '@/generated/prisma/client'
import {
  AllocationTargetType,
  PaymentComponentType,
  PenaltyCapType,
} from '@/generated/prisma/enums'
import {
  evaluateRecoveryEligibility,
  getBasePaidByValueDate,
  isShieldedOnDate,
  planEAjoParticipantPenaltyLateness,
  planLoanPenaltyLateness,
} from '@/lib/domain/lateness'
import {
  calculatePaymentAllocation,
  sortObligationsByPriority,
  summarizePaymentBreakdown,
  type AllocationPeriodItem,
} from '@/lib/services/allocation.service'

describe('P3-06 — Domain Lateness & Allocation Priority (Unit)', () => {
  describe('sortObligationsByPriority & Appendix C6 Wallet Priority', () => {
    const samplePeriods: AllocationPeriodItem[] = [
      {
        targetType: AllocationTargetType.SAVINGS,
        targetId: 'sav-1',
        periodId: 'sav-p3',
        periodNumber: 3,
        dueDate: new Date('2026-03-01T00:00:00.000Z'),
        principalDue: 10000,
        interestDue: 0,
        penaltyDue: 0,
      },
      {
        targetType: AllocationTargetType.EAJO,
        targetId: 'eajo-1',
        periodId: 'eajo-p2',
        periodNumber: 2,
        dueDate: new Date('2026-03-01T00:00:00.000Z'),
        principalDue: 20000,
        interestDue: 0,
        penaltyDue: 0,
      },
      {
        targetType: AllocationTargetType.LOAN,
        targetId: 'loan-1',
        periodId: 'loan-p2',
        periodNumber: 2,
        dueDate: new Date('2026-03-01T00:00:00.000Z'),
        principalDue: 30000,
        interestDue: 8700,
        penaltyDue: 0,
      },
    ]

    it('orders LOAN → EAJO → SAVINGS in MEMBER mode and oldest dueDate first within each product', () => {
      const sorted = sortObligationsByPriority(samplePeriods, 'MEMBER')
      expect(sorted.map((p) => p.targetType)).toEqual([
        AllocationTargetType.LOAN,
        AllocationTargetType.EAJO,
        AllocationTargetType.SAVINGS,
      ])
    })

    it('orders LOAN → EAJO and excludes SAVINGS in AUTO mode (D-12, §2.11)', () => {
      const sorted = sortObligationsByPriority(samplePeriods, 'AUTO')
      expect(sorted.map((p) => p.targetType)).toEqual([
        AllocationTargetType.LOAN,
        AllocationTargetType.EAJO,
      ])
    })

    it('reproduces Appendix C6 automatic due-date wallet application trace (₦50,000 wallet)', () => {
      // Appendix C6:
      // Due on 2026-03-01:
      // 1. Loan instalment 2 = ₦38,700 (₦30,000 principal + ₦8,700 interest)
      // 2. E-Ajo period 2 = ₦20,000 contribution
      // 3. Regular savings period 3 = ₦10,000 contribution
      // Automatic wallet apply with ₦50,000 available:
      // - Pays ₦38,700 to Loan (₦8,700 interest + ₦30,000 principal)
      // - Pays ₦11,300 to E-Ajo period 2 (leaving ₦8,700 unpaid)
      // - Pays ₦0 to Regular savings (never touched in AUTO mode)
      const res = calculatePaymentAllocation({
        amount: 50000,
        memberId: 'member-1',
        periods: samplePeriods,
        preserveCrossProductPriority: true,
        mode: 'AUTO',
        creditExcessToWallet: false,
      })

      expect(res.totalAllocated).toBe(50000)
      expect(res.excessToWallet).toBe(0)

      const loanAllocs = res.allocations.filter((a) => a.targetType === AllocationTargetType.LOAN)
      const eajoAllocs = res.allocations.filter((a) => a.targetType === AllocationTargetType.EAJO)
      const savAllocs = res.allocations.filter((a) => a.targetType === AllocationTargetType.SAVINGS)

      expect(loanAllocs.reduce((s, a) => s + a.amount, 0)).toBe(38700)
      expect(eajoAllocs.reduce((s, a) => s + a.amount, 0)).toBe(11300)
      expect(savAllocs).toHaveLength(0)

      const breakdown = summarizePaymentBreakdown(res.allocations)
      expect(breakdown).toEqual({
        penalty: 0,
        interest: 8700,
        principal: 30000,
        contribution: 11300,
        fee: 0,
        walletTopup: 0,
        total: 50000,
      })
    })

    it('does not create a WALLET_TOPUP allocation when creditExcessToWallet is false', () => {
      const res = calculatePaymentAllocation({
        amount: 100000,
        memberId: 'member-1',
        periods: samplePeriods,
        preserveCrossProductPriority: true,
        mode: 'AUTO',
        creditExcessToWallet: false,
      })
      // Only Loan (38,700) + E-Ajo (20,000) = 58,700 allocated; excess 41,300 stays in wallet
      expect(res.totalAllocated).toBe(58700)
      expect(res.excessToWallet).toBe(0)
      expect(
        res.allocations.some((a) => a.componentType === PaymentComponentType.WALLET_TOPUP),
      ).toBe(false)
    })
  })

  describe('planLoanPenaltyLateness (Appendix C2 & C8)', () => {
    const loanInstalments = [
      {
        id: 'inst-1',
        instalmentNumber: 1,
        dueDate: '2026-02-01',
        principalDue: 30000,
        interestDue: 8700,
      },
      {
        id: 'inst-2',
        instalmentNumber: 2,
        dueDate: '2026-03-01',
        principalDue: 30000,
        interestDue: 8700,
      },
    ]

    it('accrues ₦1,500/day starting on dueDate + 8 (0.5% of ₦300,000 disbursedPrincipal) and enforces the 10% loan-wide cap (₦30,000)', () => {
      // dueDate = 2026-02-01 -> grace ends 2026-02-08 -> first penalty date = 2026-02-09
      // After 20 days (2026-02-09 .. 2026-02-28 inclusive = 20 days), 20 * 1,500 = 30,000 (hits 10% cap on 300,000)
      const plan = planLoanPenaltyLateness({
        disbursedPrincipal: 300000,
        dailyRatePercent: 0.5,
        capType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
        capValue: 10,
        asOf: '2026-03-15',
        instalments: loanInstalments,
        activeAllocations: [],
        existingAccruals: [],
      })

      expect(plan.toReverse).toHaveLength(0)
      expect(plan.toAccrue).toHaveLength(20)
      expect(plan.toAccrue[0].penaltyDate).toBe('2026-02-09')
      expect(plan.toAccrue[0].amount.toNumber()).toBe(1500)
      expect(plan.toAccrue[19].penaltyDate).toBe('2026-02-28')
      expect(plan.finalPenaltiesAssessedNet.toNumber()).toBe(30000)
      // Even though inst-2 also becomes overdue on 2026-03-09, the loan-wide cap of ₦30,000 is already exhausted
      expect(plan.instalmentAssessedMap.get('inst-1')?.toNumber()).toBe(30000)
      expect(plan.instalmentAssessedMap.get('inst-2')?.toNumber()).toBe(0)
    })

    it('reverses accrued penalties with VALUE_DATE_RECALC when a backdated payment settles the instalment inside grace (Appendix C8)', () => {
      const existingAccruals = [
        {
          id: 'acc-1',
          loanInstalmentId: 'inst-1',
          penaltyDate: '2026-02-09',
          amount: 1500,
          reversedAt: null,
          journalEntryId: 'je-1',
        },
        {
          id: 'acc-2',
          loanInstalmentId: 'inst-1',
          penaltyDate: '2026-02-10',
          amount: 1500,
          reversedAt: null,
          journalEntryId: 'je-2',
        },
      ]

      // Payment confirmed with valueDate = 2026-02-06 (inside 7-day grace period)
      const activeAllocations = [
        {
          periodId: 'inst-1',
          componentType: PaymentComponentType.INTEREST,
          amount: 8700,
          valueDate: '2026-02-06',
        },
        {
          periodId: 'inst-1',
          componentType: PaymentComponentType.PRINCIPAL,
          amount: 30000,
          valueDate: '2026-02-06',
        },
      ]

      const plan = planLoanPenaltyLateness({
        disbursedPrincipal: 300000,
        dailyRatePercent: 0.5,
        capType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
        capValue: 10,
        asOf: '2026-02-10',
        instalments: [loanInstalments[0]],
        activeAllocations,
        existingAccruals,
      })

      expect(plan.toReverse).toHaveLength(2)
      expect(plan.toReverse.map((r) => r.accrualId)).toEqual(['acc-1', 'acc-2'])
      expect(plan.toReverse.every((r) => r.reason === 'VALUE_DATE_RECALC')).toBe(true)
      expect(plan.toAccrue).toHaveLength(0)
      expect(plan.finalPenaltiesAssessedNet.toNumber()).toBe(0)
    })

    it('suppresses penalty accruals while a SUBMITTED payment submission shield is active (Appendix C8)', () => {
      const plan = planLoanPenaltyLateness({
        disbursedPrincipal: 300000,
        dailyRatePercent: 0.5,
        capType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
        capValue: 10,
        asOf: '2026-02-11',
        instalments: [loanInstalments[0]],
        activeAllocations: [],
        existingAccruals: [],
        shieldSubmissions: [{ periodId: 'inst-1', paidOn: '2026-02-06' }],
      })

      expect(plan.toAccrue).toHaveLength(0)
      expect(plan.shieldedDates).toHaveLength(3) // Feb 9, 10, 11 shielded
      expect(plan.finalPenaltiesAssessedNet.toNumber()).toBe(0)
    })
  })

  describe('planEAjoParticipantPenaltyLateness (§2.3, OQ-16)', () => {
    const eajoPeriods = [
      {
        id: 'ep-1',
        periodNumber: 1,
        dueDate: '2026-02-01',
        contributionDue: 20000,
      },
    ]

    it('accrues daily penalty on unpaid contribution at start of day and reverses if settled by backdated valueDate', () => {
      // Unpaid 20,000 at 0.5%/day = 100/day starting 2026-02-09
      const planUnpaid = planEAjoParticipantPenaltyLateness({
        capBase: 200000,
        dailyRatePercent: 0.5,
        capType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
        capValue: 10,
        asOf: '2026-02-10',
        periods: eajoPeriods,
        activeAllocations: [],
        existingAccruals: [],
      })

      expect(planUnpaid.toAccrue).toHaveLength(2)
      expect(planUnpaid.toAccrue[0].amount.toNumber()).toBe(100)
      expect(planUnpaid.finalPenaltiesAssessedNet.toNumber()).toBe(200)

      // Now confirm a payment with valueDate = 2026-02-05 (inside grace)
      const planSettled = planEAjoParticipantPenaltyLateness({
        capBase: 200000,
        dailyRatePercent: 0.5,
        capType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
        capValue: 10,
        asOf: '2026-02-10',
        periods: eajoPeriods,
        activeAllocations: [
          {
            periodId: 'ep-1',
            componentType: PaymentComponentType.CONTRIBUTION,
            amount: 20000,
            valueDate: '2026-02-05',
          },
        ],
        existingAccruals: planUnpaid.toAccrue.map((a, idx) => ({
          id: `eacc-${idx + 1}`,
          eajoContributionPeriodId: a.eajoContributionPeriodId,
          penaltyDate: a.penaltyDate,
          amount: a.amount,
          reversedAt: null,
          journalEntryId: `eje-${idx + 1}`,
        })),
      })

      expect(planSettled.toReverse).toHaveLength(2)
      expect(planSettled.toReverse[0].reason).toBe('VALUE_DATE_RECALC')
      expect(planSettled.finalPenaltiesAssessedNet.toNumber()).toBe(0)
    })
  })

  describe('evaluateRecoveryEligibility (§2.5)', () => {
    it('flags obligation as recovery-eligible on dueDate + 15 when unpaid and unshielded, and suppresses when shielded', () => {
      // dueDate = 2026-02-01 -> dueDate + 15 = 2026-02-16
      const beforeDay15 = evaluateRecoveryEligibility({
        dueDate: '2026-02-01',
        outstandingAmount: new Prisma.Decimal(38700),
        asOf: '2026-02-15',
      })
      expect(beforeDay15.isEligible).toBe(false)

      const onDay15Unshielded = evaluateRecoveryEligibility({
        dueDate: '2026-02-01',
        outstandingAmount: new Prisma.Decimal(38700),
        asOf: '2026-02-16',
      })
      expect(onDay15Unshielded.isEligible).toBe(true)
      expect(onDay15Unshielded.recoveryEligibilityDate).toBe('2026-02-16')
      expect(onDay15Unshielded.daysPastDue).toBe(15)

      const onDay15Shielded = evaluateRecoveryEligibility({
        dueDate: '2026-02-01',
        outstandingAmount: new Prisma.Decimal(38700),
        asOf: '2026-02-16',
        shieldPaidOnDates: ['2026-02-14'],
      })
      expect(onDay15Shielded.isEligible).toBe(false)
      expect(onDay15Shielded.isShielded).toBe(true)
    })
  })

  describe('Helper functions isShieldedOnDate & getBasePaidByValueDate', () => {
    it('correctly checks shield dates and base paid by valueDate', () => {
      expect(isShieldedOnDate(['2026-02-09'], '2026-02-08')).toBe(false)
      expect(isShieldedOnDate(['2026-02-09'], '2026-02-09')).toBe(true)
      expect(isShieldedOnDate(['2026-02-09'], '2026-02-10')).toBe(true)

      const paid = getBasePaidByValueDate(
        'p-1',
        [
          {
            periodId: 'p-1',
            componentType: PaymentComponentType.PRINCIPAL,
            amount: 10000,
            valueDate: '2026-02-05',
          },
          {
            periodId: 'p-1',
            componentType: PaymentComponentType.PENALTY,
            amount: 1500,
            valueDate: '2026-02-05',
          },
        ],
        '2026-02-05',
      )
      expect(paid.toNumber()).toBe(10000)
    })
  })
})
