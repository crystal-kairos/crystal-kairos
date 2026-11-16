import { describe, it, expect } from 'vitest'
import {
  getBorrowerStandaloneLimit,
  calculateRequiredGuaranteeSupport,
  calculateAdditionalSupportNeeded,
  getGuarantorAvailableCapacity,
  checkGuarantorEligibility,
  evaluateOwnSavingsLien,
  calculateEAjoAdvanceExposure,
} from '@/lib/domain/capacity'
import { c3CapacityAndLienFixture } from '../golden/c3-capacity-and-lien.fixture'
import { LoanStatus, UserRole } from '@/generated/prisma/enums'
import { Prisma } from '@/generated/prisma/client'

describe('Capacity, Guarantee Reservation & Savings Lock Primitives (§2.1, Appendix C3)', () => {
  it('reproduces Appendix C3 golden fixture calculations exactly', () => {
    const input = c3CapacityAndLienFixture.input
    const expected = c3CapacityAndLienFixture.expected

    // 1. Borrower standalone limit (2x savings)
    const standaloneLimit = getBorrowerStandaloneLimit(
      input.borrowerSavings,
      input.standaloneMultiplier,
    )
    expect(standaloneLimit.toFixed(2)).toBe(
      expected.borrowerStandaloneLimit.toFixed(2),
    )

    // Max total borrowing capacity
    const maxCapacity = standaloneLimit.plus(input.guarantorSavings)
    expect(maxCapacity.toFixed(2)).toBe(
      expected.maxTotalBorrowingCapacity.toFixed(2),
    )

    // 2. Loan 1 (250,000 NGN)
    const loan1Support = calculateRequiredGuaranteeSupport(
      input.loan1Amount,
      standaloneLimit,
    )
    expect(loan1Support.toFixed(2)).toBe(
      expected.loan1.requiredGuaranteeSupport.toFixed(2),
    )

    const loan1AdditionalSupport = calculateAdditionalSupportNeeded(
      loan1Support,
      0, // No existing reservations
    )
    expect(loan1AdditionalSupport.toFixed(2)).toBe(
      expected.loan1.guarantorReservation.toFixed(2),
    )

    const guarantorCapacityRemaining = getGuarantorAvailableCapacity(
      input.guarantorSavings,
      loan1AdditionalSupport,
    )
    expect(guarantorCapacityRemaining.toFixed(2)).toBe(
      expected.loan1.guarantorFreeCapacityRemaining.toFixed(2),
    )

    // 3. Own savings lock under Loan 1
    const lienResult = evaluateOwnSavingsLien([
      { status: LoanStatus.ACTIVE, approvedAmount: input.loan1Amount },
    ])
    expect(lienResult.isLocked).toBe(true)

    // 4. Loan 2 (40,000 NGN additional)
    const cumulativeExposure = input.loan1Amount.plus(input.loan2Amount) // 290,000 NGN
    const totalRequiredSupport = calculateRequiredGuaranteeSupport(
      cumulativeExposure,
      standaloneLimit,
    ) // 90,000 NGN

    const loan2AdditionalSupport = calculateAdditionalSupportNeeded(
      totalRequiredSupport,
      loan1AdditionalSupport, // 50,000 NGN existing
    )
    expect(loan2AdditionalSupport.toFixed(2)).toBe(
      expected.loan2.additionalSupportNeeded.toFixed(2),
    ) // 40,000 NGN

    const loan2GuarantorAvailable = getGuarantorAvailableCapacity(
      input.guarantorSavings,
      loan1AdditionalSupport, // 80k - 50k = 30k
    )
    expect(loan2GuarantorAvailable.toFixed(2)).toBe(
      expected.loan2.guarantorAvailableCapacity.toFixed(2),
    )

    // Deficit check: 40k needed vs 30k available -> deficit of 10k
    const hasDeficit = loan2AdditionalSupport.gt(loan2GuarantorAvailable)
    expect(hasDeficit).toBe(true)
    const deficit = loan2AdditionalSupport.minus(loan2GuarantorAvailable)
    expect(deficit.toFixed(2)).toBe(expected.loan2.deficit.toFixed(2))
  })

  it('enforces that staff users, self, and deactivated users cannot be guarantors (D-15, §2.1)', () => {
    // 1. Self guarantor rejected
    const selfCheck = checkGuarantorEligibility({
      guarantorId: 'user-1',
      applicantId: 'user-1',
      role: UserRole.USER,
      isActive: true,
      eligibleUnencumberedSavings: '50000.00',
    })
    expect(selfCheck.eligible).toBe(false)
    expect(selfCheck.reason).toContain('own guarantor')

    // 2. Staff user (OWNER / ADMIN) rejected
    const ownerCheck = checkGuarantorEligibility({
      guarantorId: 'staff-1',
      applicantId: 'user-1',
      role: UserRole.OWNER,
      isActive: true,
      eligibleUnencumberedSavings: '100000.00',
    })
    expect(ownerCheck.eligible).toBe(false)
    expect(ownerCheck.reason).toContain('Staff users')

    const adminCheck = checkGuarantorEligibility({
      guarantorId: 'staff-2',
      applicantId: 'user-1',
      role: UserRole.ADMIN,
      isActive: true,
      eligibleUnencumberedSavings: '100000.00',
    })
    expect(adminCheck.eligible).toBe(false)

    // 3. Deactivated user rejected
    const deactCheck = checkGuarantorEligibility({
      guarantorId: 'user-2',
      applicantId: 'user-1',
      role: UserRole.USER,
      isActive: false,
      eligibleUnencumberedSavings: '50000.00',
    })
    expect(deactCheck.eligible).toBe(false)
    expect(deactCheck.reason).toContain('Deactivated')

    // 4. Zero savings rejected
    const zeroCheck = checkGuarantorEligibility({
      guarantorId: 'user-3',
      applicantId: 'user-1',
      role: UserRole.USER,
      isActive: true,
      eligibleUnencumberedSavings: '0.00',
    })
    expect(zeroCheck.eligible).toBe(false)
    expect(zeroCheck.reason).toContain('positive eligible unencumbered savings')

    // 5. Valid member accepted
    const validCheck = checkGuarantorEligibility({
      guarantorId: 'user-4',
      applicantId: 'user-1',
      role: UserRole.USER,
      isActive: true,
      eligibleUnencumberedSavings: '50000.00',
    })
    expect(validCheck.eligible).toBe(true)
  })

  it('correctly locks own savings under FULL lien mode for active loan statuses (§2.1, D-02)', () => {
    // Active statuses lock savings
    expect(
      evaluateOwnSavingsLien([{ status: LoanStatus.APPROVED }]).isLocked,
    ).toBe(true)
    expect(
      evaluateOwnSavingsLien([{ status: LoanStatus.ACCEPTED }]).isLocked,
    ).toBe(true)
    expect(
      evaluateOwnSavingsLien([{ status: LoanStatus.DISBURSED }]).isLocked,
    ).toBe(true)
    expect(
      evaluateOwnSavingsLien([{ status: LoanStatus.ACTIVE }]).isLocked,
    ).toBe(true)
    expect(
      evaluateOwnSavingsLien([{ status: LoanStatus.OVERDUE }]).isLocked,
    ).toBe(true)
    expect(
      evaluateOwnSavingsLien([{ status: LoanStatus.DEFAULTED }]).isLocked,
    ).toBe(true)

    // Non-active statuses do NOT lock savings
    expect(
      evaluateOwnSavingsLien([{ status: LoanStatus.PENDING }]).isLocked,
    ).toBe(false)
    expect(
      evaluateOwnSavingsLien([{ status: LoanStatus.REJECTED }]).isLocked,
    ).toBe(false)
    expect(
      evaluateOwnSavingsLien([{ status: LoanStatus.COMPLETED }]).isLocked,
    ).toBe(false)
    expect(
      evaluateOwnSavingsLien([{ status: LoanStatus.DECLINED }]).isLocked,
    ).toBe(false)
  })

  it('calculates E-Ajo advance exposure c × (N − s) before and after member payout (§2.8, §2.1)', () => {
    // C4: c = 10,000, N = 12
    expect(
      calculateEAjoAdvanceExposure({ payoutPosition: 1, totalSlots: 12, contributionAmount: '10000.00' }).toFixed(2),
    ).toBe('110000.00')
    expect(
      calculateEAjoAdvanceExposure({ payoutPosition: 2, totalSlots: 12, contributionAmount: '10000.00' }).toFixed(2),
    ).toBe('100000.00')
    // Last slot: nothing is advanced, the guarantee is a zero reservation
    expect(
      calculateEAjoAdvanceExposure({ payoutPosition: 12, totalSlots: 12, contributionAmount: '10000.00' }).toFixed(2),
    ).toBe('0.00')

    // After payout: remaining unpaid scheduled contributions, never above the advance
    expect(
      calculateEAjoAdvanceExposure({
        payoutPosition: 4,
        totalSlots: 6,
        contributionAmount: '20000.00',
        hasReceivedPayout: true,
        unpaidScheduledContributions: '20000.00',
      }).toFixed(2),
    ).toBe('20000.00')
    expect(
      calculateEAjoAdvanceExposure({
        payoutPosition: 4,
        totalSlots: 6,
        contributionAmount: '20000.00',
        hasReceivedPayout: true,
        unpaidScheduledContributions: '60000.00', // e.g. month 3 still unpaid
      }).toFixed(2),
    ).toBe('40000.00')

    expect(() =>
      calculateEAjoAdvanceExposure({ payoutPosition: 7, totalSlots: 6, contributionAmount: 1 }),
    ).toThrow()
  })
})
