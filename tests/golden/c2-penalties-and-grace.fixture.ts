import { Prisma } from '@/generated/prisma/client'

/**
 * Appendix C2: Penalties, Cap, Grace Window & Case Eligibility (§2.2, §2.4, §2.10)
 */
export const c2PenaltiesAndGraceFixture = {
  input: {
    principal: new Prisma.Decimal('300000.00'),
    instalment1DueDate: '2027-02-10',
    dailyPenaltyPercent: new Prisma.Decimal('0.5000'),
    dailyPenaltyAmount: new Prisma.Decimal('1500.00'),
    graceDays: 7,
  },
  expected: {
    graceWindowEnd: '2027-02-17',
    firstPenaltyDate: '2027-02-18',
    recoveryEligibilityDate: '2027-02-25',
    capPercentOfPrincipal: {
      capPercent: new Prisma.Decimal('10.0000'),
      capAmount: new Prisma.Decimal('30000.00'),
      maxPenaltyDays: 20,
      totalAccrual: new Prisma.Decimal('30000.00'),
    },
    capFixedAmount: {
      capAmount: new Prisma.Decimal('20000.00'),
      days1To13Total: new Prisma.Decimal('19500.00'),
      day14ClampedAccrual: new Prisma.Decimal('500.00'),
      totalAccrual: new Prisma.Decimal('20000.00'),
    },
    paymentAllocationOnFeb20: {
      paymentAmount: new Prisma.Decimal('20000.00'),
      penaltyAccrued: new Prisma.Decimal('3000.00'), // Feb 18 & 19
      allocatedPenalty: new Prisma.Decimal('3000.00'),
      allocatedInterest: new Prisma.Decimal('15000.00'),
      allocatedPrincipal: new Prisma.Decimal('2000.00'),
      remainingInstalmentPrincipal: new Prisma.Decimal('48000.00'),
    },
  },
}
