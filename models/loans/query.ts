'use server'

import { prisma } from '@/lib/prisma'
import {
  serializeLoan,
  calculateRepaymentSchedule,
  calculateLoanPenaltyAmount,
} from '@/lib/loans'
import { AdminPermission } from '@/generated/prisma/enums'
import {
  AuthzError,
  requireMemberOrStaffWithPermission,
} from '@/lib/authz/guards'

/**
 * Fetches a single loan details along with its transactions, user details, and computed schedule.
 * Enforces member ownership or staff loan permissions.
 */
export const getLoanPlanById = async (loanId: string) => {
  try {
    const loan = await prisma.loan.findUnique({
      where: { id: loanId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        transactions: {
          orderBy: { createdAt: 'desc' },
        },
      },
    })

    if (!loan) {
      return { success: false, error: 'Loan not found.' }
    }

    await requireMemberOrStaffWithPermission(loan.userId, [
      AdminPermission.LOANS_READ,
      AdminPermission.LOANS_REVIEW,
      AdminPermission.LOANS_DISBURSE,
    ])

    const serializedLoan = serializeLoan(loan)
    const serializedTransactions = (loan.transactions || []).map((t) => ({
      ...t,
      amount: Number(t.amount),
    }))

    // Calculate dynamic schedule if disbursed (ACTIVE/OVERDUE/COMPLETED/DEFAULTED)
    const schedule = calculateRepaymentSchedule(
      loan.approvedAmount
        ? Number(loan.approvedAmount)
        : Number(loan.requestedAmount),
      Number(loan.interestRate),
      loan.duration,
      loan.disbursedAt,
      Number(loan.totalRepaid),
      loan.gracePeriodDays,
    )

    // Calculate dynamic penalty
    const computedPenaltyAmount = calculateLoanPenaltyAmount(
      loan.approvedAmount
        ? Number(loan.approvedAmount)
        : Number(loan.requestedAmount),
      loan.repaymentEndDate,
      new Date(),
      0.5, // 0.5% daily fee
      3, // 3 days grace period
    )

    return {
      success: true,
      data: {
        ...serializedLoan,
        computedPenaltyAmount,
        user: {
          id: loan.user.id,
          name: loan.user.name,
          email: loan.user.email,
        },
        transactions: serializedTransactions,
        schedule,
      },
    }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error fetching loan plan:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to fetch loan plan.',
    }
  }
}
