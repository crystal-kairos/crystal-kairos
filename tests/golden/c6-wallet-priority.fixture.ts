import { Prisma } from '@/generated/prisma/client'

/**
 * Appendix C6: Wallet Allocation Priority (§1.6, §2.10, §2.11)
 */
export const c6WalletPriorityFixture = {
  input: {
    availableWallet: new Prisma.Decimal('40000.00'),
    obligations: {
      loanInstalment: {
        penaltyDue: new Prisma.Decimal('3000.00'),
        interestDue: new Prisma.Decimal('7000.00'),
        principalDue: new Prisma.Decimal('15000.00'),
        totalDue: new Prisma.Decimal('25000.00'),
      },
      eAjoContribution: {
        amountDue: new Prisma.Decimal('20000.00'),
      },
      savingsPeriod: {
        amountDue: new Prisma.Decimal('10000.00'),
      },
    },
  },
  expected: {
    allocationOrder: ['LOANS', 'EAJO', 'SAVINGS'],
    step1LoanAllocation: {
      appliedPenalty: new Prisma.Decimal('3000.00'),
      appliedInterest: new Prisma.Decimal('7000.00'),
      appliedPrincipal: new Prisma.Decimal('15000.00'),
      totalApplied: new Prisma.Decimal('25000.00'),
      isFullySettled: true,
      walletRemaining: new Prisma.Decimal('15000.00'),
    },
    step2EAjoAllocation: {
      totalApplied: new Prisma.Decimal('15000.00'),
      remainingDue: new Prisma.Decimal('5000.00'),
      isFullySettled: false,
      walletRemaining: new Prisma.Decimal('0.00'),
    },
    step3SavingsAllocation: {
      totalApplied: new Prisma.Decimal('0.00'),
      remainingDue: new Prisma.Decimal('10000.00'),
      isFullySettled: false,
      note: 'Savings is never automated from wallet',
    },
  },
}
