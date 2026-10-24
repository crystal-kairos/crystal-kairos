import { Prisma } from '@/generated/prisma/client'
import { LedgerAccountType } from '@/generated/prisma/enums'

/**
 * Appendix C7: Recovery Waterfall Execution (§2.4, §2.12)
 */
export const c7RecoveryWaterfallFixture = {
  input: {
    obligation: {
      assessedPenalties: new Prisma.Decimal('24000.00'),
      interestDue: new Prisma.Decimal('15000.00'),
      principalDue: new Prisma.Decimal('50000.00'),
      totalDue: new Prisma.Decimal('89000.00'),
    },
    scenarioA: {
      debtorWallet: new Prisma.Decimal('10000.00'),
      debtorSavings: new Prisma.Decimal('100000.00'),
      guarantorSavings: new Prisma.Decimal('50000.00'),
    },
    scenarioB: {
      debtorWallet: new Prisma.Decimal('10000.00'),
      debtorSavings: new Prisma.Decimal('30000.00'),
      guarantorSavings: new Prisma.Decimal('50000.00'),
    },
  },
  expected: {
    scenarioA: {
      walletDeduction: new Prisma.Decimal('10000.00'),
      debtorSavingsDeduction: new Prisma.Decimal('79000.00'),
      guarantorSavingsDeduction: new Prisma.Decimal('0.00'),
      remainingDebtorSavings: new Prisma.Decimal('21000.00'),
      guarantorReservationRemaining: new Prisma.Decimal('50000.00'),
      journalLines: [
        {
          accountType: LedgerAccountType.MEMBER_WALLET_LIABILITY,
          debit: new Prisma.Decimal('10000.00'),
          credit: new Prisma.Decimal('0.00'),
        },
        {
          accountType: LedgerAccountType.SAVINGS_PRINCIPAL_LIABILITY,
          debit: new Prisma.Decimal('79000.00'),
          credit: new Prisma.Decimal('0.00'),
        },
        {
          accountType: LedgerAccountType.LOAN_PENALTY_RECEIVABLE,
          debit: new Prisma.Decimal('0.00'),
          credit: new Prisma.Decimal('24000.00'),
        },
        {
          accountType: LedgerAccountType.LOAN_INTEREST_RECEIVABLE,
          debit: new Prisma.Decimal('0.00'),
          credit: new Prisma.Decimal('15000.00'),
        },
        {
          accountType: LedgerAccountType.LOAN_RECEIVABLE_PRINCIPAL,
          debit: new Prisma.Decimal('0.00'),
          credit: new Prisma.Decimal('50000.00'),
        },
      ],
      totalDebits: new Prisma.Decimal('89000.00'),
      totalCredits: new Prisma.Decimal('89000.00'),
    },
    scenarioB: {
      walletDeduction: new Prisma.Decimal('10000.00'),
      debtorSavingsDeduction: new Prisma.Decimal('30000.00'),
      guarantorSavingsDeduction: new Prisma.Decimal('49000.00'),
      remainingGuarantorReservation: new Prisma.Decimal('1000.00'),
      totalRecovered: new Prisma.Decimal('89000.00'),
    },
  },
}
