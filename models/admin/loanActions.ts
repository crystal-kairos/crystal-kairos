'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { AdminPermission, LoanStatus, TransactionCategory, TransactionStatus, TransactionType } from '@/generated/prisma/enums'
import { Prisma } from '@/generated/prisma/client'
import { AuthzError, enforceDualControl, requirePermission } from '@/lib/authz/guards'

/**
 * Admin approves a loan and sets the final approved amount.
 */
export const approveLoanAction = async (loanId: string, approvedAmount: number) => {
  try {
    const actor = await requirePermission(AdminPermission.LOANS_REVIEW)

    const loan = await prisma.loan.findUnique({ where: { id: loanId } })
    if (!loan) return { success: false, error: 'Loan not found.' }
    if (loan.status !== LoanStatus.PENDING) return { success: false, error: 'Only pending loans can be approved.' }

    const updated = await prisma.loan.update({
      where: { id: loanId },
      data: {
        status: LoanStatus.APPROVED,
        approvedAmount,
        approvedBy: actor.id,
        approvedAt: new Date(),
      },
    })

    try {
      revalidatePath('/admin/loans')
      revalidatePath(`/admin/loans/${loanId}`)
    } catch {}

    return { success: true, data: updated }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error approving loan:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to approve loan.' }
  }
}

/**
 * Admin rejects a loan with a mandatory reason.
 */
export const rejectLoanAction = async (loanId: string, rejectionReason: string) => {
  try {
    const actor = await requirePermission(AdminPermission.LOANS_REVIEW)

    const loan = await prisma.loan.findUnique({ where: { id: loanId } })
    if (!loan) return { success: false, error: 'Loan not found.' }
    if (loan.status !== LoanStatus.PENDING) return { success: false, error: 'Only pending loans can be rejected.' }

    const updated = await prisma.loan.update({
      where: { id: loanId },
      data: {
        status: LoanStatus.REJECTED,
        rejectionReason,
        approvedBy: actor.id,
        approvedAt: new Date(),
      },
    })

    try {
      revalidatePath('/admin/loans')
      revalidatePath(`/admin/loans/${loanId}`)
    } catch {}

    return { success: true, data: updated }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error rejecting loan:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to reject loan.' }
  }
}

/**
 * Admin disburses a loan and uploads the receipt.
 */
export const disburseLoanAction = async (loanId: string, receiptUrl: string) => {
  try {
    const actor = await requirePermission(AdminPermission.LOANS_DISBURSE)

    const loan = await prisma.loan.findUnique({ where: { id: loanId } })
    if (!loan) return { success: false, error: 'Loan not found.' }
    if (loan.status !== LoanStatus.ACCEPTED) {
      return { success: false, error: 'Only accepted loans can be disbursed' }
    }
    if (!loan.approvedAmount) return { success: false, error: 'Approved amount is missing.' }

    await enforceDualControl({
      actor,
      previousActorId: loan.approvedBy,
      requiredPermission: AdminPermission.LOANS_DISBURSE,
    })

    const now = new Date()
    const repaymentEndDate = new Date(now)
    repaymentEndDate.setMonth(repaymentEndDate.getMonth() + loan.duration)

    const approvedAmountNum = Number(loan.approvedAmount || 0)
    const interestRateNum = Number(loan.interestRate || 0)
    const totalInterest = (approvedAmountNum * interestRateNum * loan.duration) / 100
    const initialDebt = approvedAmountNum + totalInterest

    // Run in a transaction: Create disbursement record + update loan
    const result = await prisma.$transaction(async (tx) => {
      // Create the disbursement transaction
      await tx.transaction.create({
        data: {
          userId: loan.userId,
          amount: loan.approvedAmount!,
          type: TransactionType.WITHDRAWAL, // Money leaving the system
          category: TransactionCategory.LOAN_DISBURSEMENT,
          status: TransactionStatus.DISBURSED,
          receiptUrl,
          loanId: loan.id,
          notes: `Disbursement for Loan ${loan.id.substring(0, 8)}`,
          recordedBy: actor.id,
          processedBy: actor.id,
          processedAt: now,
        },
      })

      // Update the loan status to ACTIVE
      const updatedLoan = await tx.loan.update({
        where: { id: loanId },
        data: {
          status: LoanStatus.ACTIVE,
          disbursedAt: now,
          repaymentStartDate: now,
          repaymentEndDate,
          outstandingBalance: initialDebt, // initial debt matches approved amount + interest
        },
      })

      return updatedLoan
    })

    try {
      revalidatePath('/admin/loans')
      revalidatePath(`/admin/loans/${loanId}`)
      revalidatePath(`/dashboard/${loan.userId}/loans`)
      revalidatePath(`/dashboard/${loan.userId}/loans/${loanId}`)
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error disbursing loan:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to disburse loan.' }
  }
}

export const reviewLoanRepaymentAction = async (transactionId: string, status: 'CONFIRMED' | 'REJECTED', rejectionReason?: string) => {
  try {
    const actor = await requirePermission(AdminPermission.LOANS_REVIEW)

    const tx = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { loan: true },
    })

    if (!tx || !tx.loanId) {
      return { success: false, error: 'Transaction or associated loan not found.' }
    }
    if (tx.status !== 'PENDING') {
      return { success: false, error: 'Transaction is not pending review.' }
    }
    if (tx.category !== 'LOAN_REPAYMENT' && tx.category !== 'FEE') {
      return { success: false, error: 'Not a loan transaction.' }
    }

    await prisma.$transaction(async (txPrisma) => {
      await txPrisma.transaction.update({
        where: { id: transactionId },
        data: {
          status,
          rejectionReason: status === 'REJECTED' ? rejectionReason : null,
          processedBy: actor.id,
          processedAt: new Date(),
        },
      })

      if (status === 'CONFIRMED') {
        const loan = tx.loan!
        
        const newTotalRepaid = new Prisma.Decimal(Number(loan.totalRepaid) + Number(tx.amount))
        const newOutstandingBalance = new Prisma.Decimal(Math.max(0, Number(loan.outstandingBalance) - Number(tx.amount)))

        await txPrisma.loan.update({
          where: { id: loan.id },
          data: {
            totalRepaid: newTotalRepaid,
            outstandingBalance: newOutstandingBalance,
            actualRepaymentDate: newOutstandingBalance.toNumber() <= 0 ? new Date() : undefined,
            status: newOutstandingBalance.toNumber() <= 0 ? LoanStatus.COMPLETED : loan.status,
          },
        })
      }
    })

    try { revalidatePath(`/admin/loans/${tx.loanId}`) } catch {}
    return { success: true }
  } catch (error: unknown) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Failed to review loan repayment:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to review loan repayment.' }
  }
}

export const createLoanForMemberAction = async (data: {
  userId: string
  purpose: string
  requestedAmount: number
  duration: number
  status: LoanStatus
  approvedAmount?: number
}) => {
  try {
    const actor = await requirePermission(AdminPermission.LOANS_REVIEW)

    const { userId, purpose, requestedAmount, duration, status, approvedAmount } = data

    // Verify member exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { bankAccounts: true }
    })
    
    if (!user) return { success: false, error: 'Member not found.' }
    if (!user.bankAccounts || user.bankAccounts.length === 0) {
      return { success: false, error: 'Member must have a bank account set up first.' }
    }

    // Fetch Global Loan Interest Rate
    const loanSettings = await prisma.loanSettings.findUnique({
      where: { id: 'global' },
    })
    const interestRate = loanSettings?.interestRate ? Number(loanSettings.interestRate) : 10

    const actualApprovedAmount = approvedAmount || requestedAmount
    
    // Total repayment = Principal + (Principal * Interest Rate / 100)
    let totalRepayment = requestedAmount
    let outstandingBalance = requestedAmount

    if (status === LoanStatus.DISBURSED || status === LoanStatus.ACCEPTED || status === LoanStatus.APPROVED) {
      const interestAmount = (actualApprovedAmount * interestRate) / 100
      totalRepayment = actualApprovedAmount + interestAmount
      outstandingBalance = totalRepayment
    }

    const newLoan = await prisma.loan.create({
      data: {
        userId,
        purpose,
        requestedAmount: new Prisma.Decimal(requestedAmount),
        approvedAmount: (status === LoanStatus.DISBURSED || status === LoanStatus.ACCEPTED || status === LoanStatus.APPROVED) ? new Prisma.Decimal(actualApprovedAmount) : null,
        outstandingBalance: new Prisma.Decimal(outstandingBalance),
        interestRate: new Prisma.Decimal(interestRate),
        duration,
        status,
        repaymentEndDate: new Date(Date.now() + duration * 30 * 24 * 60 * 60 * 1000), // Approx. duration months
      }
    })

    if (status === LoanStatus.DISBURSED) {
      // Create a disbursement transaction record automatically if disbursed
      await prisma.transaction.create({
        data: {
          userId,
          amount: new Prisma.Decimal(actualApprovedAmount),
          type: TransactionType.WITHDRAWAL, // Disbursement is a withdrawal from system to user
          category: TransactionCategory.LOAN_DISBURSEMENT,
          status: TransactionStatus.CONFIRMED,
          loanId: newLoan.id,
          notes: 'Loan auto-disbursed by Admin during record creation',
          recordedBy: actor.id,
          processedBy: actor.id,
          processedAt: new Date(),
        }
      })
    }

    try {
      revalidatePath('/admin/loans')
      revalidatePath(`/dashboard/${userId}/loans`)
    } catch {}
    return { success: true, data: newLoan }
  } catch (error: unknown) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error creating loan for member:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to create loan record.' }
  }
}
