import { Prisma } from '@/generated/prisma/client'

/**
 * Appendix C3: Capacity, Guarantee Reservation & Own-Savings Lock (§2.1)
 */
export const c3CapacityAndLienFixture = {
  input: {
    borrowerSavings: new Prisma.Decimal('100000.00'),
    guarantorSavings: new Prisma.Decimal('80000.00'),
    standaloneMultiplier: 2,
    loan1Amount: new Prisma.Decimal('250000.00'),
    loan2Amount: new Prisma.Decimal('40000.00'),
  },
  expected: {
    borrowerStandaloneLimit: new Prisma.Decimal('200000.00'),
    maxTotalBorrowingCapacity: new Prisma.Decimal('280000.00'),
    loan1: {
      requiredGuaranteeSupport: new Prisma.Decimal('50000.00'),
      guarantorReservation: new Prisma.Decimal('50000.00'),
      guarantorFreeCapacityRemaining: new Prisma.Decimal('30000.00'),
      ownSavingsLockAmount: new Prisma.Decimal('100000.00'), // FULL lien mode
      isApproved: true,
    },
    loan2: {
      additionalSupportNeeded: new Prisma.Decimal('40000.00'),
      guarantorAvailableCapacity: new Prisma.Decimal('30000.00'),
      isApproved: false, // Refused due to capacity deficit
      deficit: new Prisma.Decimal('10000.00'),
    },
  },
}
