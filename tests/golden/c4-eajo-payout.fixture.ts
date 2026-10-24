import { Prisma } from '@/generated/prisma/client'
import { LedgerAccountType } from '@/generated/prisma/enums'

/**
 * Appendix C4: E-Ajo Payout, Advance Exposure & Monthly Cash Requirement (§2.8, §2.12)
 */
export const c4EajoPayoutFixture = {
  input: {
    monthlyContribution: new Prisma.Decimal('10000.00'),
    totalSlots: 12,
    payoutSlot: 2,
    earlySlotPenaltyPercent: new Prisma.Decimal('10.0000'),
  },
  expected: {
    expectedPayout: new Prisma.Decimal('120000.00'),
    contributionsHeld: new Prisma.Decimal('20000.00'),
    advanceAmount: new Prisma.Decimal('100000.00'),
    earlySlotPenaltyAmount: new Prisma.Decimal('10000.00'),
    netPayout: new Prisma.Decimal('110000.00'),
    journalLines: [
      {
        accountType: LedgerAccountType.EAJO_CONTRIBUTION_LIABILITY,
        debit: new Prisma.Decimal('20000.00'),
        credit: new Prisma.Decimal('0.00'),
      },
      {
        accountType: LedgerAccountType.EAJO_ADVANCE_RECEIVABLE,
        debit: new Prisma.Decimal('100000.00'),
        credit: new Prisma.Decimal('0.00'),
      },
      {
        accountType: LedgerAccountType.COOPERATIVE_CASH,
        debit: new Prisma.Decimal('0.00'),
        credit: new Prisma.Decimal('110000.00'),
      },
      {
        accountType: LedgerAccountType.EAJO_EARLY_SLOT_INCOME,
        debit: new Prisma.Decimal('0.00'),
        credit: new Prisma.Decimal('10000.00'),
      },
    ],
    totalDebits: new Prisma.Decimal('120000.00'),
    totalCredits: new Prisma.Decimal('120000.00'),
    month2CashRequirement: {
      slot2Disbursements: new Prisma.Decimal('220000.00'), // 2 participants
      totalMonthContributions: new Prisma.Decimal('30000.00'), // 3 participants
      netCashRequired: new Prisma.Decimal('190000.00'),
    },
  },
}
