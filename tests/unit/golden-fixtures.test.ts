import { describe, it, expect } from 'vitest'
import { Prisma } from '@/generated/prisma/client'
import { c1LoanScheduleFixture } from '../golden/c1-loan-schedule.fixture'
import { c2PenaltiesAndGraceFixture } from '../golden/c2-penalties-and-grace.fixture'
import { c3CapacityAndLienFixture } from '../golden/c3-capacity-and-lien.fixture'
import { c4EajoPayoutFixture } from '../golden/c4-eajo-payout.fixture'
import { c5SavingsInterestFixture } from '../golden/c5-savings-interest.fixture'
import { c6WalletPriorityFixture } from '../golden/c6-wallet-priority.fixture'
import { c7RecoveryWaterfallFixture } from '../golden/c7-recovery-waterfall.fixture'
import { c8ReviewShieldFixture } from '../golden/c8-review-shield.fixture'
import { c9ReversalCascadeFixture } from '../golden/c9-reversal-cascade.fixture'
import { assertBalanced } from '@/lib/services/ledger.service'
import { roundMoney, splitWithRemainder } from '@/lib/domain/money'

describe('Golden Test Fixtures Verification (Appendix C, PR P2-02, D-23)', () => {
  it('C1: verifies flat-monthly loan schedule and instalment calculations', () => {
    const { input, expected } = c1LoanScheduleFixture

    const monthlyInterest = input.principal
      .times(input.monthlyInterestRatePercent)
      .dividedBy(100)
    expect(roundMoney(monthlyInterest)).toEqual(expected.monthlyInterest)

    const totalInterest = monthlyInterest.times(input.termMonths)
    expect(roundMoney(totalInterest)).toEqual(expected.totalInterest)

    const totalScheduled = input.principal.plus(totalInterest)
    expect(roundMoney(totalScheduled)).toEqual(expected.totalScheduledRepayment)

    const principalSplits = splitWithRemainder(input.principal, input.termMonths)
    expect(principalSplits[0]).toEqual(new Prisma.Decimal('50000.00'))

    for (let i = 0; i < expected.instalments.length; i++) {
      const inst = expected.instalments[i]
      expect(inst.principalPortion.plus(inst.interestPortion)).toEqual(inst.totalDue)
    }
  })

  it('C2: verifies daily penalties, grace period, and cap clamping', () => {
    const { input, expected } = c2PenaltiesAndGraceFixture

    const calculatedDailyPenalty = input.principal
      .times(input.dailyPenaltyPercent)
      .dividedBy(100)
    expect(roundMoney(calculatedDailyPenalty)).toEqual(input.dailyPenaltyAmount)

    // Cap at 10%
    const cap10 = input.principal.times(expected.capPercentOfPrincipal.capPercent).dividedBy(100)
    expect(roundMoney(cap10)).toEqual(expected.capPercentOfPrincipal.capAmount)

    // Clamped accrual on day 14 for 20k cap: 20000 - (13 * 1500) = 500
    const clampedAccrual = expected.capFixedAmount.capAmount.minus(
      expected.capFixedAmount.days1To13Total,
    )
    expect(clampedAccrual).toEqual(expected.capFixedAmount.day14ClampedAccrual)

    // Feb 20 payment allocation: penalty -> interest -> principal
    const alloc = expected.paymentAllocationOnFeb20
    const totalAllocated = alloc.allocatedPenalty
      .plus(alloc.allocatedInterest)
      .plus(alloc.allocatedPrincipal)
    expect(totalAllocated).toEqual(alloc.paymentAmount)
  })

  it('C3: verifies borrowing capacity, guarantee reservation, and FULL lien mode', () => {
    const { input, expected } = c3CapacityAndLienFixture

    const standaloneLimit = input.borrowerSavings.times(input.standaloneMultiplier)
    expect(standaloneLimit).toEqual(expected.borrowerStandaloneLimit)

    const maxCapacity = standaloneLimit.plus(input.guarantorSavings)
    expect(maxCapacity).toEqual(expected.maxTotalBorrowingCapacity)

    // Loan 1 guarantee requirement
    const reqSupport1 = Prisma.Decimal.max(0, input.loan1Amount.minus(standaloneLimit))
    expect(reqSupport1).toEqual(expected.loan1.requiredGuaranteeSupport)
    expect(expected.loan1.isApproved).toBe(true)

    // Loan 2 cumulative requirement: 290k - 200k - 50k = 40k needed, but only 30k free
    const cumulativePrincipal = input.loan1Amount.plus(input.loan2Amount)
    const needed = cumulativePrincipal
      .minus(standaloneLimit)
      .minus(expected.loan1.guarantorReservation)
    expect(needed).toEqual(expected.loan2.additionalSupportNeeded)
    expect(needed.gt(expected.loan1.guarantorFreeCapacityRemaining)).toBe(true)
    expect(expected.loan2.isApproved).toBe(false)
  })

  it('C4: verifies E-Ajo advance exposure and balanced journal lines', () => {
    const { input, expected } = c4EajoPayoutFixture

    // Contributions held: c * s = 10,000 * 2 = 20,000
    const held = input.monthlyContribution.times(input.payoutSlot)
    expect(held).toEqual(expected.contributionsHeld)

    // Advance amount: c * (N - s) = 10,000 * (12 - 2) = 100,000
    const advance = input.monthlyContribution.times(input.totalSlots - input.payoutSlot)
    expect(advance).toEqual(expected.advanceAmount)

    // Penalty: 10% on advance = 10,000
    const penalty = advance.times(input.earlySlotPenaltyPercent).dividedBy(100)
    expect(roundMoney(penalty)).toEqual(expected.earlySlotPenaltyAmount)

    // Net payout: total expected (120,000) - penalty (10,000) = 110,000
    const net = expected.expectedPayout.minus(penalty)
    expect(net).toEqual(expected.netPayout)

    // Balanced debits = credits check
    expect(() => assertBalanced(expected.journalLines as any)).not.toThrow()
    expect(expected.totalDebits).toEqual(expected.totalCredits)
  })

  it('C5: verifies savings linear monthly accrual and lot calculations', () => {
    const { input, expected } = c5SavingsInterestFixture

    // Lot A interest: 100,000 * 12% * (181/181) = 12,000
    const lotAInterest = input.lotA.depositAmount
      .times(input.termRatePercent)
      .dividedBy(100)
    expect(roundMoney(lotAInterest)).toEqual(expected.lotAInterest)

    // Lot B interest: 50,000 * 12% * (91/181) = 3,016.57
    const lotBInterest = input.lotB.depositAmount
      .times(input.termRatePercent)
      .dividedBy(100)
      .times(input.lotB.eligibleDays)
      .dividedBy(input.totalEligibleDays)
    expect(roundMoney(lotBInterest)).toEqual(expected.lotBInterest)

    // Linear monthly accrual
    const jan31 = lotAInterest.times(30).dividedBy(input.totalEligibleDays)
    expect(roundMoney(jan31)).toEqual(expected.lotALinearMonthlyPostings.jan31Posting)

    const feb28Accrued = lotAInterest.times(58).dividedBy(input.totalEligibleDays)
    expect(roundMoney(feb28Accrued)).toEqual(
      expected.lotALinearMonthlyPostings.feb28AccruedToDate,
    )
    const feb28Posting = roundMoney(feb28Accrued).minus(roundMoney(jan31))
    expect(feb28Posting).toEqual(expected.lotALinearMonthlyPostings.feb28Posting)
  })

  it('C6: verifies wallet allocation priority across loans, e-ajo and savings', () => {
    const { input, expected } = c6WalletPriorityFixture

    expect(expected.allocationOrder).toEqual(['LOANS', 'EAJO', 'SAVINGS'])

    let wallet = input.availableWallet
    // Step 1: Loans
    wallet = wallet.minus(expected.step1LoanAllocation.totalApplied)
    expect(wallet).toEqual(expected.step1LoanAllocation.walletRemaining)

    // Step 2: E-Ajo
    wallet = wallet.minus(expected.step2EAjoAllocation.totalApplied)
    expect(wallet).toEqual(expected.step2EAjoAllocation.walletRemaining)
    expect(wallet.equals(0)).toBe(true)

    // Step 3: Savings untouched
    expect(expected.step3SavingsAllocation.totalApplied.equals(0)).toBe(true)
  })

  it('C7: verifies recovery waterfall execution and balanced ledger posting', () => {
    const { expected } = c7RecoveryWaterfallFixture

    // Balanced lines
    expect(() => assertBalanced(expected.scenarioA.journalLines as any)).not.toThrow()
    expect(expected.scenarioA.totalDebits).toEqual(expected.scenarioA.totalCredits)

    // Scenario B: Guarantor absorption
    const recovered = expected.scenarioB.walletDeduction
      .plus(expected.scenarioB.debtorSavingsDeduction)
      .plus(expected.scenarioB.guarantorSavingsDeduction)
    expect(recovered).toEqual(expected.scenarioB.totalRecovered)
  })

  it('C8: verifies review delay value date shield and catch-up penalty', () => {
    const { input, expected } = c8ReviewShieldFixture

    const unshieldedPenalty = input.dailyPenaltyAmount.times(
      expected.rejectedScenario.unshieldedDaysCount,
    )
    expect(unshieldedPenalty).toEqual(expected.rejectedScenario.catchUpPenaltyAmount)
  })

  it('C9: verifies reversal cascade, shortfall receivable, and balanced lines', () => {
    const { expected } = c9ReversalCascadeFixture

    const absorbed = expected.step2InboundPaymentReversal.walletAbsorbedAmount
    const shortfall = expected.step2InboundPaymentReversal.shortfallReceivableAmount
    expect(absorbed.plus(shortfall)).toEqual(expected.totalDebits)

    expect(() => assertBalanced(expected.journalLines as any)).not.toThrow()
    expect(expected.totalDebits).toEqual(expected.totalCredits)
  })
})
