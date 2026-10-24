import { Prisma } from '@/generated/prisma/client'

/**
 * Appendix C8: Review Delay & Value Date Shield (§1.2, §2.10)
 */
export const c8ReviewShieldFixture = {
  input: {
    loanDueDate: '2027-02-10',
    graceWindowEnd: '2027-02-17',
    receiptUploadDate: '2027-02-15',
    claimedPaidOn: '2027-02-15',
    reviewActionDate: '2027-02-22',
    dailyPenaltyAmount: new Prisma.Decimal('1500.00'),
  },
  expected: {
    approvedScenario: {
      verifiedValueDate: '2027-02-15',
      assessedPenalties: new Prisma.Decimal('0.00'),
      isForfeited: false,
      isRecoverySuppressed: true,
    },
    rejectedScenario: {
      shieldDropped: true,
      unshieldedDaysCount: 5, // Feb 18, 19, 20, 21, 22
      catchUpPenaltyAmount: new Prisma.Decimal('7500.00'), // 5 * 1500.00
      isRecoveryEligible: false, // Day +15 is Feb 25
    },
  },
}
