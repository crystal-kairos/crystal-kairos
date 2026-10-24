import { Prisma } from '@/generated/prisma/client'
import { LedgerAccountType } from '@/generated/prisma/enums'

/**
 * Appendix C9: Reversal with Spent Wallet Credit (§2.10, §2.12)
 */
export const c9ReversalCascadeFixture = {
  input: {
    initialInboundPayment: new Prisma.Decimal('100000.00'),
    spentOnLoan: new Prisma.Decimal('65000.00'),
    withdrawnToBank: new Prisma.Decimal('30000.00'),
    walletBalanceBeforeReversal: new Prisma.Decimal('5000.00'),
  },
  expected: {
    step1LoanPaymentReversal: {
      loanReopenedOutstanding: new Prisma.Decimal('65000.00'),
      restoredWalletBalance: new Prisma.Decimal('70000.00'), // 5,000 + 65,000
    },
    step2InboundPaymentReversal: {
      walletAbsorbedAmount: new Prisma.Decimal('70000.00'),
      shortfallReceivableAmount: new Prisma.Decimal('30000.00'),
      finalWalletBalance: new Prisma.Decimal('0.00'),
    },
    journalLines: [
      {
        accountType: LedgerAccountType.MEMBER_WALLET_LIABILITY,
        debit: new Prisma.Decimal('70000.00'),
        credit: new Prisma.Decimal('0.00'),
      },
      {
        accountType: LedgerAccountType.REVERSAL_SHORTFALL_RECEIVABLE,
        debit: new Prisma.Decimal('30000.00'),
        credit: new Prisma.Decimal('0.00'),
      },
      {
        accountType: LedgerAccountType.COOPERATIVE_CASH,
        debit: new Prisma.Decimal('0.00'),
        credit: new Prisma.Decimal('100000.00'),
      },
    ],
    totalDebits: new Prisma.Decimal('100000.00'),
    totalCredits: new Prisma.Decimal('100000.00'),
  },
}
