import { Prisma } from '@/generated/prisma/client'

/**
 * Appendix C5: Savings Interest Accrual, Posting & Forfeiture (§2.5, §2.12)
 */
export const c5SavingsInterestFixture = {
  input: {
    termMonths: 6,
    termRatePercent: new Prisma.Decimal('12.0000'),
    startDate: '2027-01-01',
    maturityDate: '2027-07-01',
    totalEligibleDays: 181,
    lotA: {
      depositAmount: new Prisma.Decimal('100000.00'),
      valueDate: '2027-01-01',
      eligibleDays: 181,
    },
    lotB: {
      depositAmount: new Prisma.Decimal('50000.00'),
      valueDate: '2027-04-01',
      eligibleDays: 91,
    },
  },
  expected: {
    lotAInterest: new Prisma.Decimal('12000.00'),
    lotBInterest: new Prisma.Decimal('3016.57'),
    totalMaturityPayable: new Prisma.Decimal('165016.57'),
    lotALinearMonthlyPostings: {
      jan31Posting: new Prisma.Decimal('1988.95'), // 30 days
      feb28AccruedToDate: new Prisma.Decimal('3845.30'), // 58 days
      feb28Posting: new Prisma.Decimal('1856.35'), // 3845.30 - 1988.95
    },
    regularSavingsForfeiture: {
      periodDue: '2027-03-01',
      graceWindowEnd: '2027-03-08',
      onTimePaymentDate: '2027-03-08',
      onTimeInterestEarned: new Prisma.Decimal('1524.86'),
      latePaymentDate: '2027-03-09',
      lateInterestEarned: new Prisma.Decimal('0.00'), // Forfeited
      forfeitureReason: 'GRACE_PERIOD_EXPIRED',
    },
  },
}
