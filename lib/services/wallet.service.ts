import { Prisma } from '@/generated/prisma/client'
import { LedgerAccountType, WalletWithdrawalStatus } from '@/generated/prisma/enums'
import { prisma } from '@/lib/prisma'
import { AppError } from '@/lib/errors/app-error'
import { roundMoney, toDecimal } from '@/lib/domain/money'
import { lockMembers } from '@/lib/db/concurrency'

export interface WalletSummary {
  memberId: string
  totalBalance: Prisma.Decimal
  heldBalance: Prisma.Decimal
  availableBalance: Prisma.Decimal
}

/**
 * Calculates a member's total wallet liability balance directly from immutable journal lines (§2.12).
 * Liability balance = Total Credits (money credited to member) - Total Debits (money spent/withdrawn by member).
 */
export async function getWalletBalance(
  memberId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<Prisma.Decimal> {
  const aggregate = await tx.journalLine.aggregate({
    where: {
      memberId,
      accountType: LedgerAccountType.MEMBER_WALLET_LIABILITY,
    },
    _sum: {
      debit: true,
      credit: true,
    },
  })

  const totalCredits = aggregate._sum.credit || new Prisma.Decimal(0)
  const totalDebits = aggregate._sum.debit || new Prisma.Decimal(0)

  return roundMoney(totalCredits.minus(totalDebits))
}

/**
 * Calculates total held funds against the member's wallet (§2.11, P3-08):
 * Sum of all pending/approved wallet cash-out requests awaiting disbursement.
 */
export async function getWalletHolds(
  memberId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<Prisma.Decimal> {
  const aggregate = await tx.walletWithdrawal.aggregate({
    where: {
      memberId,
      status: {
        in: [WalletWithdrawalStatus.REQUESTED, WalletWithdrawalStatus.APPROVED],
      },
    },
    _sum: {
      amount: true,
    },
  })

  return roundMoney(aggregate._sum.amount || new Prisma.Decimal(0))
}

/**
 * Returns a comprehensive wallet summary including total, held, and available balance.
 * Available balance = Total Balance - Held Balance.
 */
export async function getWalletSummary(
  memberId: string,
  tx: Prisma.TransactionClient = prisma,
): Promise<WalletSummary> {
  const totalBalance = await getWalletBalance(memberId, tx)
  const heldBalance = await getWalletHolds(memberId, tx)
  const availableBalance = roundMoney(totalBalance.minus(heldBalance))

  return {
    memberId,
    totalBalance,
    heldBalance,
    availableBalance,
  }
}

/**
 * Asserts that a member has sufficient available wallet funds to cover an obligation.
 * Throws INSUFFICIENT_WALLET_BALANCE if the requested amount exceeds available balance.
 */
export async function assertSufficientWallet(
  memberId: string,
  requiredAmount: Prisma.Decimal | number | string,
  tx: Prisma.TransactionClient = prisma,
): Promise<WalletSummary> {
  const dAmount = roundMoney(requiredAmount)
  const summary = await getWalletSummary(memberId, tx)

  if (summary.availableBalance.lt(dAmount)) {
    throw new AppError(
      'INSUFFICIENT_WALLET_BALANCE',
      `Insufficient available wallet balance. Required: ₦${dAmount.toFixed(2)}, Available: ₦${summary.availableBalance.toFixed(2)} (Total: ₦${summary.totalBalance.toFixed(2)}, Held: ₦${summary.heldBalance.toFixed(2)}).`,
      { statusCode: 422 },
    )
  }

  return summary
}

/**
 * Requests a member-initiated wallet withdrawal, placing a hold on available wallet funds (§2.11).
 * Transaction-scoped advisory lock taken on memberId to prevent concurrent overdrafts.
 */
export async function requestWalletWithdrawal(
  tx: Prisma.TransactionClient,
  params: {
    memberId: string
    amount: Prisma.Decimal | number | string
    bankAccountId: string
    idempotencyKey: string
  },
) {
  const dAmount = roundMoney(params.amount)
  if (dAmount.lte(0)) {
    throw new AppError('VALIDATION_ERROR', 'Withdrawal amount must be greater than zero.')
  }

  // 1. Idempotency replay check
  const existing = await tx.walletWithdrawal.findUnique({
    where: { idempotencyKey: params.idempotencyKey },
    include: { bankAccount: true },
  })
  if (existing) {
    return existing
  }

  // 2. Concurrency advisory lock
  await lockMembers(tx, [params.memberId])

  // 3. Verify bank account ownership
  const bankAccount = await tx.bankAccount.findFirst({
    where: {
      id: params.bankAccountId,
      userId: params.memberId,
    },
  })
  if (!bankAccount) {
    throw new AppError('NOT_FOUND', 'Verified destination bank account not found for member.')
  }

  // 4. Assert sufficient available wallet
  await assertSufficientWallet(params.memberId, dAmount, tx)

  // 5. Generate sequential withdrawal number
  const count = await tx.walletWithdrawal.count()
  const withdrawalNumber = `WTH-${String(count + 1).padStart(6, '0')}`

  // 6. Create withdrawal hold record
  const withdrawal = await tx.walletWithdrawal.create({
    data: {
      withdrawalNumber,
      memberId: params.memberId,
      amount: dAmount,
      bankAccountId: params.bankAccountId,
      status: WalletWithdrawalStatus.REQUESTED,
      idempotencyKey: params.idempotencyKey,
    },
    include: { bankAccount: true },
  })

  return withdrawal
}
