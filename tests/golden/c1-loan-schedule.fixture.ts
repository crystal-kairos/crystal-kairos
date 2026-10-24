import { Prisma } from '@/generated/prisma/client'

/**
 * Appendix C1: Flat-Monthly Loan Schedule & Lagos Due Dates (§2.9, §2.6)
 */
export const c1LoanScheduleFixture = {
  input: {
    principal: new Prisma.Decimal('300000.00'),
    termMonths: 6,
    monthlyInterestRatePercent: new Prisma.Decimal('5.0000'),
    disbursementDate: '2027-01-10',
    monthEndAnchorDate: '2027-01-31',
  },
  expected: {
    monthlyInterest: new Prisma.Decimal('15000.00'),
    totalInterest: new Prisma.Decimal('90000.00'),
    totalScheduledRepayment: new Prisma.Decimal('390000.00'),
    instalments: [
      {
        instalmentNumber: 1,
        dueDate: '2027-02-10',
        principalPortion: new Prisma.Decimal('50000.00'),
        interestPortion: new Prisma.Decimal('15000.00'),
        totalDue: new Prisma.Decimal('650000.00').dividedBy(10), // 65000.00
      },
      {
        instalmentNumber: 2,
        dueDate: '2027-03-10',
        principalPortion: new Prisma.Decimal('50000.00'),
        interestPortion: new Prisma.Decimal('15000.00'),
        totalDue: new Prisma.Decimal('65000.00'),
      },
      {
        instalmentNumber: 3,
        dueDate: '2027-04-10',
        principalPortion: new Prisma.Decimal('50000.00'),
        interestPortion: new Prisma.Decimal('15000.00'),
        totalDue: new Prisma.Decimal('65000.00'),
      },
      {
        instalmentNumber: 4,
        dueDate: '2027-05-10',
        principalPortion: new Prisma.Decimal('50000.00'),
        interestPortion: new Prisma.Decimal('15000.00'),
        totalDue: new Prisma.Decimal('65000.00'),
      },
      {
        instalmentNumber: 5,
        dueDate: '2027-06-10',
        principalPortion: new Prisma.Decimal('50000.00'),
        interestPortion: new Prisma.Decimal('15000.00'),
        totalDue: new Prisma.Decimal('65000.00'),
      },
      {
        instalmentNumber: 6,
        dueDate: '2027-07-10',
        principalPortion: new Prisma.Decimal('50000.00'),
        interestPortion: new Prisma.Decimal('15000.00'),
        totalDue: new Prisma.Decimal('65000.00'),
      },
    ],
    monthEndDueDates: [
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
      '2027-05-31',
      '2027-06-30',
      '2027-07-31',
    ],
  },
}
