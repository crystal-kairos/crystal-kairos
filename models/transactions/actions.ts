'use server'

import { prisma } from '@/lib/prisma'
import {
  AdminPermission,
  TransactionStatus,
  TransactionCategory,
  TransactionType,
  SavingsStatus,
  LoanStatus,
  UserRole,
} from '@/generated/prisma/enums'
import { Prisma } from '@/generated/prisma/client'
import { revalidatePath } from 'next/cache'
import {
  assertTargetUserIsMember,
  requireAnyPermission,
  requireMemberOrStaffWithPermission,
} from '@/lib/authz/guards'
import { AppError } from '@/lib/errors/app-error'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { calculateMaturityDate } from '@/lib/savings'
import { validateAmount } from '@/lib/validation/money'
import { lockMembers } from '@/lib/db/concurrency'
import {
  generateAndPersistLoanSchedule,
  generateAndPersistSavingsSchedule,
  generateAndPersistEAjoSchedule,
} from '@/lib/services/schedules.service'
import {
  postSavingsDeposit,
  postWalletCredit,
  postLoanDisbursement,
  postLoanRepayment,
  postEajoContribution,
  postWalletWithdrawal,
} from '@/lib/services/ledger.service'
import { recordAuditEvent, AuditAction, AuditOutcome } from '@/lib/services/audit.service'

interface CreateTransactionInput {
  userId: string
  amount: number | Prisma.Decimal | string
  category: TransactionCategory
  type: TransactionType
  eAjoId?: string
  eAjoMemberId?: string
  savingsId?: string
  loanId?: string
  receiptUrl?: string
  notes?: string
  bankAccountId?: string
  recordedBy?: string
}

function permissionsForTransactionTransition(
  category: TransactionCategory,
  action: 'CONFIRM' | 'REJECT' | 'DISBURSE' | 'FAIL',
): AdminPermission[] {
  switch (category) {
    case TransactionCategory.SAVINGS_DEPOSIT:
      return [
        AdminPermission.TRANSACTIONS_REVIEW,
        AdminPermission.SAVINGS_PAYMENTS_REVIEW,
      ]
    case TransactionCategory.SAVINGS_WITHDRAWAL:
      return [
        AdminPermission.TRANSACTIONS_REVIEW,
        AdminPermission.SAVINGS_PAYMENTS_REVIEW,
        AdminPermission.WALLET_WITHDRAWALS_REVIEW,
      ]
    case TransactionCategory.LOAN_REPAYMENT:
    case TransactionCategory.FEE:
      return [AdminPermission.TRANSACTIONS_REVIEW, AdminPermission.LOANS_REVIEW]
    case TransactionCategory.LOAN_DISBURSEMENT:
      return action === 'DISBURSE'
        ? [AdminPermission.LOANS_DISBURSE, AdminPermission.TRANSACTIONS_REVIEW]
        : [
            AdminPermission.LOANS_DISBURSE,
            AdminPermission.LOANS_REVIEW,
            AdminPermission.TRANSACTIONS_REVIEW,
          ]
    case TransactionCategory.AJO_CONTRIBUTION:
      return [
        AdminPermission.TRANSACTIONS_REVIEW,
        AdminPermission.EAJO_PAYMENTS_REVIEW,
      ]
    case TransactionCategory.AJO_PAYOUT:
      return [
        AdminPermission.TRANSACTIONS_REVIEW,
        AdminPermission.EAJO_PAYOUTS_MANAGE,
      ]
    case TransactionCategory.WALLET_WITHDRAWAL:
      return [
        AdminPermission.TRANSACTIONS_REVIEW,
        AdminPermission.WALLET_WITHDRAWALS_REVIEW,
      ]
    case TransactionCategory.WALLET_TOPUP:
    default:
      return [AdminPermission.TRANSACTIONS_REVIEW]
  }
}

/**
 * Creates a pending transaction in the database.
 * Enforces member session ownership or staff permission, and derives actor identity from the live session.
 */
export const createTransaction = async (input: CreateTransactionInput) => {
  try {
    const actor = await requireMemberOrStaffWithPermission(input.userId, [
      AdminPermission.TRANSACTIONS_REVIEW,
      AdminPermission.SAVINGS_MANAGE,
      AdminPermission.LOANS_REVIEW,
      AdminPermission.EAJO_MANAGE,
    ])

    const targetUserId =
      actor.role === UserRole.USER ? actor.id : input.userId

    await assertTargetUserIsMember(targetUserId)

    const validatedAmount = validateAmount(input.amount)

    if (input.savingsId) {
      const savings = await prisma.savings.findFirst({
        where: { id: input.savingsId, userId: targetUserId },
        select: { id: true },
      })
      if (!savings) {
        return {
          success: false,
          error: 'Savings plan not found for this member.',
        }
      }
    }

    if (input.loanId) {
      const loan = await prisma.loan.findFirst({
        where: { id: input.loanId, userId: targetUserId },
        select: { id: true },
      })
      if (!loan) {
        return {
          success: false,
          error: 'Loan record not found for this member.',
        }
      }
    }

    if (input.eAjoId) {
      const eAjo = await prisma.eAjo.findFirst({
        where: { id: input.eAjoId, userId: targetUserId },
        select: { id: true },
      })
      if (!eAjo) {
        return {
          success: false,
          error: 'eAjo record not found for this member.',
        }
      }
    }

    if (input.eAjoMemberId) {
      const eAjoMember = await prisma.eAjoMember.findFirst({
        where: { id: input.eAjoMemberId, userId: targetUserId },
        select: { id: true },
      })
      if (!eAjoMember) {
        return {
          success: false,
          error: 'eAjo member record not found for this member.',
        }
      }
    }

    if (input.bankAccountId) {
      const bankAccount = await prisma.bankAccount.findFirst({
        where: { id: input.bankAccountId, userId: targetUserId },
        select: { id: true },
      })
      if (!bankAccount) {
        return {
          success: false,
          error: 'Bank account not found for this member.',
        }
      }
    }

    const transaction = await prisma.transaction.create({
      data: {
        userId: targetUserId,
        amount: validatedAmount,
        category: input.category,
        type: input.type,
        status: TransactionStatus.PENDING,
        eAjoId: input.eAjoId || null,
        eAjoMemberId: input.eAjoMemberId || null,
        savingsId: input.savingsId || null,
        loanId: input.loanId || null,
        receiptUrl: input.receiptUrl || null,
        notes: input.notes || null,
        bankAccountId: input.bankAccountId || null,
        recordedBy: actor.id,
      },
    })

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      affectedUserId: targetUserId,
      action: AuditAction.RECEIPT_SUBMITTED,
      entityType: 'Transaction',
      entityId: transaction.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: {
        transactionId: transaction.id,
        category: transaction.category,
        type: transaction.type,
        amount: Number(transaction.amount),
        notes: transaction.notes,
      },
    }).catch(() => {})

    try {
      revalidatePath('/admin/transactions')
      revalidatePath(`/dashboard/${targetUserId}`)
    } catch {}

    return { success: true, data: transaction }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'createTransaction',
      fallbackMessage: 'Failed to create transaction',
      context: { userId: input.userId, category: input.category },
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      fieldErrors: err.fieldErrors,
      correlationId: err.correlationId,
    }
  }
}

/**
 * Transition a transaction to a new state (CONFIRMED, REJECTED, DISBURSED, FAILED)
 * and apply the business ledger calculations dynamically in a transaction lock.
 */
export const transitionTransaction = async (
  transactionId: string,
  action: 'CONFIRM' | 'REJECT' | 'DISBURSE' | 'FAIL',
  _adminId: string,
  rejectionReason?: string,
  referenceNumber?: string,
) => {
  try {
    void _adminId

    // Load transaction category first so we can enforce category-appropriate permission
    const existingTx = await prisma.transaction.findUnique({
      where: { id: transactionId },
      select: { id: true, category: true },
    })

    const allowedPerms = existingTx
      ? permissionsForTransactionTransition(existingTx.category, action)
      : [
          AdminPermission.TRANSACTIONS_REVIEW,
          AdminPermission.SAVINGS_PAYMENTS_REVIEW,
          AdminPermission.LOANS_REVIEW,
          AdminPermission.LOANS_DISBURSE,
          AdminPermission.EAJO_PAYMENTS_REVIEW,
          AdminPermission.EAJO_PAYOUTS_MANAGE,
          AdminPermission.WALLET_WITHDRAWALS_REVIEW,
        ]

    const actor = await requireAnyPermission(allowedPerms)

    const result = await prisma.$transaction(async (tx) => {
      let newStatus: TransactionStatus = TransactionStatus.PENDING
      const upperAction = action.toUpperCase()

      if (upperAction === 'CONFIRM') {
        newStatus = TransactionStatus.CONFIRMED
      } else if (upperAction === 'REJECT') {
        newStatus = TransactionStatus.REJECTED
      } else if (upperAction === 'DISBURSE') {
        newStatus = TransactionStatus.DISBURSED
      } else if (upperAction === 'FAIL') {
        newStatus = TransactionStatus.FAILED
      }

      // 1. Double-confirmation race prevention: Conditional atomic update
      const updateResult = await tx.transaction.updateMany({
        where: {
          id: transactionId,
          status: TransactionStatus.PENDING,
        },
        data: {
          status: newStatus,
          processedBy: actor.id,
          processedAt: new Date(),
          rejectionReason: rejectionReason || null,
          referenceNumber: referenceNumber || null,
        },
      })

      if (updateResult.count !== 1) {
        const existingTxCheck = await tx.transaction.findUnique({
          where: { id: transactionId },
          select: { id: true, status: true },
        })
        if (!existingTxCheck) {
          throw new AppError('NOT_FOUND', 'Transaction not found.')
        }
        throw new AppError(
          'STALE_STATE',
          `Transaction was already processed. Status: ${existingTxCheck.status}`,
        )
      }

      // 2. Fetch current transaction details with relations
      const transaction = await tx.transaction.findUnique({
        where: { id: transactionId },
        include: {
          eAjo: true,
          savings: true,
          loan: true,
        },
      })

      if (!transaction) {
        throw new AppError('NOT_FOUND', 'Transaction not found.')
      }

      // Take transaction-scoped advisory lock on member to prevent concurrent ledger anomalies (PR P2-02, §2.12)
      await lockMembers(tx, [transaction.userId])

      // 3. Apply Ledger Invariants and Journal Postings based on Category & Action
      if (newStatus === TransactionStatus.CONFIRMED) {
        // A. Ajo contributions
        if (
          transaction.category === TransactionCategory.AJO_CONTRIBUTION &&
          transaction.eAjoMemberId
        ) {
          await tx.eAjoMember.update({
            where: { id: transaction.eAjoMemberId },
            data: {
              currentBalance: { increment: transaction.amount },
              totalContributed: { increment: transaction.amount },
            },
          })

          await postEajoContribution(tx, {
            amount: transaction.amount,
            memberId: transaction.userId,
            eAjoMemberId: transaction.eAjoMemberId,
            isPostPayout: false,
            effectiveDate: new Date(),
            idempotencyKey: `tx-${transaction.id}-confirm`,
            postedById: actor.id,
          })
        }

        // B. Savings deposits
        if (
          transaction.category === TransactionCategory.SAVINGS_DEPOSIT &&
          transaction.savingsId
        ) {
          // If the savings was pending, activate it on first deposit
          const updateData: Prisma.SavingsUpdateInput = {
            currentBalance: { increment: transaction.amount },
            totalDeposited: { increment: transaction.amount },
          }
          if (transaction.savings?.status === SavingsStatus.PENDING) {
            updateData.status = SavingsStatus.ACTIVE
            const startDate = new Date()
            updateData.startDate = startDate

            // Calculate maturity date from startDate for FIXED or REGULAR savings
            if (
              transaction.savings.savingsType === 'FIXED' ||
              transaction.savings.savingsType === 'REGULAR'
            ) {
              updateData.maturityDate = calculateMaturityDate(
                startDate,
                transaction.savings.maturity,
              )
            }

            await generateAndPersistSavingsSchedule(tx, {
              savingsId: transaction.savingsId,
              savingsType: transaction.savings.savingsType,
              frequency: transaction.savings.frequency,
              maturity: transaction.savings.maturity,
              targetAmount:
                transaction.savings.targetAmount || transaction.amount,
              firstDepositValueDate: startDate,
            })
          }
          await tx.savings.update({
            where: { id: transaction.savingsId },
            data: updateData,
          })

          await postSavingsDeposit(tx, {
            amount: transaction.amount,
            memberId: transaction.userId,
            savingsId: transaction.savingsId,
            effectiveDate: new Date(),
            idempotencyKey: `tx-${transaction.id}-confirm`,
            postedById: actor.id,
          })
        }

        // C. Loan Repayments
        if (
          transaction.category === TransactionCategory.LOAN_REPAYMENT &&
          transaction.loanId
        ) {
          const currentOutstanding = new Prisma.Decimal(
            transaction.loan?.outstandingBalance?.toString() || '0',
          )
          const repaymentAmount = transaction.amount
          const newOutstanding = Prisma.Decimal.max(
            0,
            currentOutstanding.minus(repaymentAmount),
          )

          await tx.loan.update({
            where: { id: transaction.loanId },
            data: {
              outstandingBalance: newOutstanding,
              totalRepaid: { increment: repaymentAmount },
              status: newOutstanding.equals(0)
                ? LoanStatus.COMPLETED
                : undefined,
            },
          })

          await postLoanRepayment(tx, {
            memberId: transaction.userId,
            loanId: transaction.loanId,
            principalPortion: transaction.amount,
            effectiveDate: new Date(),
            idempotencyKey: `tx-${transaction.id}-confirm`,
            postedById: actor.id,
          })
        }

        // D. General Wallet Top-up
        if (transaction.category === TransactionCategory.WALLET_TOPUP) {
          await postWalletCredit(tx, {
            amount: transaction.amount,
            memberId: transaction.userId,
            effectiveDate: new Date(),
            idempotencyKey: `tx-${transaction.id}-confirm`,
            postedById: actor.id,
          })
        }
      }

      if (newStatus === TransactionStatus.DISBURSED) {
        // A. Ajo Payouts (Money disbursed to member)
        if (
          transaction.category === TransactionCategory.AJO_PAYOUT &&
          transaction.eAjoMemberId
        ) {
          await tx.eAjoMember.update({
            where: { id: transaction.eAjoMemberId },
            data: {
              currentBalance: { decrement: transaction.amount },
              hasReceivedPayout: true,
            },
          })
        }

        // B. Savings Withdrawals (Money paid back to saver)
        if (
          transaction.category === TransactionCategory.SAVINGS_WITHDRAWAL &&
          transaction.savingsId
        ) {
          await tx.savings.update({
            where: { id: transaction.savingsId },
            data: {
              currentBalance: 0,
              status: SavingsStatus.WITHDRAWN,
            },
          })
        }

        // C. Loan Disbursements (Approved borrow amount paid to applicant)
        if (
          transaction.category === TransactionCategory.LOAN_DISBURSEMENT &&
          transaction.loanId &&
          transaction.loan
        ) {
          const approvedAmountNum = Number(transaction.loan.approvedAmount || 0)
          const interestRateNum = Number(transaction.loan.interestRate || 0)
          const totalInterest =
            (approvedAmountNum * interestRateNum * transaction.loan.duration) /
            100
          const initialDebt = approvedAmountNum + totalInterest

          await tx.loan.update({
            where: { id: transaction.loanId },
            data: {
              status: LoanStatus.ACTIVE,
              disbursedAt: new Date(),
              outstandingBalance: initialDebt, // Initial debt matches approved amount + interest
            },
          })

          await generateAndPersistLoanSchedule(tx, {
            loanId: transaction.loanId,
            principal: transaction.loan.approvedAmount || transaction.amount,
            termMonths: transaction.loan.duration,
            monthlyInterestRatePercent: transaction.loan.interestRate,
            disbursementValueDate: new Date(),
          })

          await postLoanDisbursement(tx, {
            amount: transaction.amount,
            memberId: transaction.userId,
            loanId: transaction.loanId,
            effectiveDate: new Date(),
            idempotencyKey: `tx-${transaction.id}-disburse`,
            postedById: actor.id,
          })
        }

        // D. Wallet Withdrawal
        if (transaction.category === TransactionCategory.WALLET_WITHDRAWAL) {
          await postWalletWithdrawal(tx, {
            amount: transaction.amount,
            memberId: transaction.userId,
            withdrawalId: transaction.id,
            effectiveDate: new Date(),
            idempotencyKey: `tx-${transaction.id}-disburse`,
            postedById: actor.id,
          })
        }
      }

      await recordAuditEvent(
        {
          actorId: actor.id,
          actorRole: actor.role,
          affectedUserId: transaction.userId,
          action:
            newStatus === TransactionStatus.CONFIRMED
              ? AuditAction.RECEIPT_CONFIRMED
              : newStatus === TransactionStatus.REJECTED
                ? AuditAction.RECEIPT_REJECTED
                : AuditAction.FINANCIAL_POSTING,
          entityType: 'Transaction',
          entityId: transaction.id,
          outcome: newStatus === TransactionStatus.FAILED ? AuditOutcome.FAILURE : AuditOutcome.SUCCESS,
          metadata: {
            transactionId: transaction.id,
            category: transaction.category,
            amount: Number(transaction.amount),
            action,
            newStatus,
            rejectionReason: rejectionReason || null,
            referenceNumber: referenceNumber || null,
          },
        },
        tx
      )

      return {
        ...transaction,
        status: newStatus,
        processedBy: actor.id,
        processedAt: new Date(),
        rejectionReason: rejectionReason || null,
        referenceNumber: referenceNumber || null,
      }
    })

    try {
      revalidatePath('/admin')
      revalidatePath('/admin/verification')
      revalidatePath('/admin/disbursements')
      revalidatePath('/admin/transactions')
      revalidatePath(`/dashboard/${result.userId}`)
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'transitionTransaction',
      fallbackMessage: 'Transition failed',
      context: { transactionId, action },
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      fieldErrors: err.fieldErrors,
      correlationId: err.correlationId,
    }
  }
}

/**
 * Returns user ledger balance summaries (unified wallet + products details)
 */
export const getUserLedgerBalances = async (userId: string) => {
  try {
    await requireMemberOrStaffWithPermission(userId, [
      AdminPermission.TRANSACTIONS_READ,
      AdminPermission.TRANSACTIONS_REVIEW,
      AdminPermission.MEMBERS_READ,
    ])

    // 1. Fetch confirmed/disbursed transactions
    const txs = await prisma.transaction.findMany({
      where: {
        userId,
        status: {
          in: [TransactionStatus.CONFIRMED, TransactionStatus.DISBURSED],
        },
      },
    })

    let ledgerBalance = new Prisma.Decimal(0)
    let totalAjoContributed = new Prisma.Decimal(0)
    let totalSavingsDeposited = new Prisma.Decimal(0)
    let totalSavingsWithdrawn = new Prisma.Decimal(0)
    let totalLoansDisbursed = new Prisma.Decimal(0)
    let totalLoansRepaid = new Prisma.Decimal(0)

    for (const tx of txs) {
      // Base ledger balance includes general WALLET transactions
      if (tx.category === TransactionCategory.WALLET_TOPUP) {
        ledgerBalance = ledgerBalance.plus(tx.amount)
      } else if (tx.category === TransactionCategory.WALLET_WITHDRAWAL) {
        ledgerBalance = ledgerBalance.minus(tx.amount)
      }

      // Sub-ledgers breakdown
      if (tx.category === TransactionCategory.AJO_CONTRIBUTION) {
        totalAjoContributed = totalAjoContributed.plus(tx.amount)
      } else if (tx.category === TransactionCategory.SAVINGS_DEPOSIT) {
        totalSavingsDeposited = totalSavingsDeposited.plus(tx.amount)
      } else if (tx.category === TransactionCategory.SAVINGS_WITHDRAWAL) {
        totalSavingsWithdrawn = totalSavingsWithdrawn.plus(tx.amount)
      } else if (tx.category === TransactionCategory.LOAN_DISBURSEMENT) {
        totalLoansDisbursed = totalLoansDisbursed.plus(tx.amount)
      } else if (tx.category === TransactionCategory.LOAN_REPAYMENT) {
        totalLoansRepaid = totalLoansRepaid.plus(tx.amount)
      }
    }

    return {
      success: true,
      data: {
        generalWalletBalance: ledgerBalance.toNumber(),
        subLedgers: {
          ajo: {
            totalContributed: totalAjoContributed.toNumber(),
          },
          savings: {
            totalDeposited: totalSavingsDeposited.toNumber(),
            totalWithdrawn: totalSavingsWithdrawn.toNumber(),
            currentSavingsBalance: totalSavingsDeposited
              .minus(totalSavingsWithdrawn)
              .toNumber(),
          },
          loans: {
            totalBorrowed: totalLoansDisbursed.toNumber(),
            totalRepaid: totalLoansRepaid.toNumber(),
            outstandingDebt: totalLoansDisbursed
              .minus(totalLoansRepaid)
              .toNumber(),
          },
        },
      },
    }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'getUserLedgerBalances',
      fallbackMessage: 'Failed to retrieve ledger balances',
      context: { userId },
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      fieldErrors: err.fieldErrors,
      correlationId: err.correlationId,
    }
  }
}

export const getUserTransactions = async (userId: string) => {
  try {
    await requireMemberOrStaffWithPermission(userId, [
      AdminPermission.TRANSACTIONS_READ,
      AdminPermission.TRANSACTIONS_REVIEW,
      AdminPermission.MEMBERS_READ,
    ])

    const transactions = await prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })

    return { success: true, data: transactions }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'getUserTransactions',
      fallbackMessage: 'Failed to retrieve transactions',
      context: { userId },
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      fieldErrors: err.fieldErrors,
      correlationId: err.correlationId,
    }
  }
}
