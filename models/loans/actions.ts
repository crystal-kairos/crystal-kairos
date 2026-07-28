'use server'

import { prisma } from '@/lib/prisma'
import { auth } from '@/auth'
import {
  LoanStatus,
  TransactionCategory,
  TransactionType,
  TransactionStatus,
  UserRole,
} from '@/generated/prisma/enums'
import { getSessionHelper } from '../members/actions'
import { revalidatePath } from 'next/cache'
import { serializeLoan, serializeTransaction } from '@/lib/loans'
import { Prisma } from '@/generated/prisma/client'

/**
 * Searches for an active cooperative member by email to nominate as a guarantor.
 */
export const searchMemberByEmailAction = async (email: string) => {
  try {
    const session = await getSessionHelper()
    if (!session?.user) {
      return { success: false, error: 'Unauthorized' }
    }

    const member = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: {
        id: true,
        name: true,
        role: true,
        userInfo: {
          select: {
            phoneNumber: true,
          },
        },
      },
    })

    if (!member) {
      return { success: false, error: 'No cooperative member found with this email.' }
    }

    return {
      success: true,
      member: {
        id: member.id,
        name: member.name,
        phoneNumber: member.userInfo?.phoneNumber || '',
      },
    }
  } catch (error) {
    console.error('Error searching member:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'An error occurred during search.',
    }
  }
}

/**
 * Apply for a loan, dynamically calculating interest rates and fees.
 */
export const applyForLoanAction = async (
  userId: string,
  data: {
    requestedAmount: number
    duration: number
    purpose: string
    guarantorEmail?: string
    collateralDetails?: string
  }
) => {
  try {
    const session = await getSessionHelper()
    if (!session?.user) {
      return { success: false, error: 'Unauthorized' }
    }

    // 1. Fetch user's savings balance to calculate eligibility and tiers
    const savings = await prisma.savings.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { currentBalance: true },
    })

    const totalSavings = savings.reduce((sum, s) => sum + Number(s.currentBalance), 0)
    const borrowLimit = totalSavings * 2

    // 2. Validate borrowing limit if member has savings
    if (totalSavings > 0 && data.requestedAmount > borrowLimit) {
      return {
        success: false,
        error: `Requested amount exceeds borrowing limit of ${new Intl.NumberFormat('en-NG', {
          style: 'currency',
          currency: 'NGN',
        }).format(borrowLimit)} (double your savings).`,
      }
    }

    // 3. Fetch global loan interest rate
    let interestRate = 5 // Fallback
    const settings = await prisma.loanSettings.findUnique({ where: { id: 'global' } })
    if (settings) {
      interestRate = Number(settings.interestRate)
    }

    const applicationFee = 2000 // Standard form/application fee

    // 4. Resolve guarantor details
    let guarantorId: string | null = null
    let guarantorName: string | null = null
    let guarantorPhoneNumber: string | null = null

    if (data.guarantorEmail) {
      const searchRes = await searchMemberByEmailAction(data.guarantorEmail)
      if (!searchRes.success || !searchRes.member) {
        return { success: false, error: searchRes.error || 'Guarantor verification failed.' }
      }
      guarantorId = searchRes.member.id
      guarantorName = searchRes.member.name
      guarantorPhoneNumber = searchRes.member.phoneNumber
    }

    // 5. Create PENDING Loan record
    const newLoan = await prisma.loan.create({
      data: {
        userId,
        requestedAmount: new Prisma.Decimal(data.requestedAmount.toString()),
        interestRate: new Prisma.Decimal(interestRate.toString()),
        duration: data.duration,
        purpose: data.purpose,
        guarantorId,
        guarantorName,
        guarantorPhoneNumber,
        collateralDetails: data.collateralDetails || null,
        applicationFee: new Prisma.Decimal(applicationFee.toString()),
        status: LoanStatus.PENDING,
      },
    })

    try {
      revalidatePath(`/dashboard/${userId}/loans`)
      revalidatePath(`/dashboard/${userId}`)
    } catch (e) {
      // Ignored outside Next.js context
    }

    return { success: true, data: serializeLoan(newLoan) }
  } catch (error) {
    console.error('Error applying for loan:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to apply for loan.',
    }
  }
}

/**
 * Submit loan repayment receipt for verification
 */
export const submitLoanRepaymentAction = async (
  userId: string,
  data: {
    loanId: string
    amount: number
    receiptUrl: string
    referenceNumber?: string
    notes?: string
  }
) => {
  try {
    const session = await getSessionHelper()
    if (!session?.user) {
      return { success: false, error: 'Unauthorized' }
    }

    const loan = await prisma.loan.findUnique({
      where: { id: data.loanId },
    })

    if (!loan) {
      return { success: false, error: 'Loan not found.' }
    }

    if (loan.status !== LoanStatus.ACTIVE && loan.status !== LoanStatus.OVERDUE && loan.status !== LoanStatus.DEFAULTED) {
      return { success: false, error: 'Repayment is only allowed on active, overdue, or defaulted loans.' }
    }

    const newTransaction = await prisma.transaction.create({
      data: {
        userId,
        amount: new Prisma.Decimal(data.amount.toString()),
        category: TransactionCategory.LOAN_REPAYMENT,
        type: TransactionType.DEPOSIT,
        status: TransactionStatus.PENDING,
        loanId: data.loanId,
        receiptUrl: data.receiptUrl,
        referenceNumber: data.referenceNumber || null,
        notes: data.notes || null,
        recordedBy: userId,
      },
    })

    try {
      revalidatePath(`/dashboard/${userId}/loans`)
      revalidatePath(`/dashboard/${userId}`)
    } catch (e) {
      // Ignored outside Next.js context
    }

    return { success: true, data: serializeTransaction(newTransaction) }
  } catch (error) {
    console.error('Error submitting loan repayment:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to submit loan repayment.',
    }
  }
}

export const acceptLoanOfferAction = async (userId: string, loanId: string) => {
  try {
    const loan = await prisma.loan.findFirst({
      where: { id: loanId, userId },
    })

    if (!loan) return { success: false, error: 'Loan not found' }
    if (loan.status !== 'APPROVED') return { success: false, error: 'Only approved loans can be accepted' }

    await prisma.loan.update({
      where: { id: loanId },
      data: {
        status: LoanStatus.ACCEPTED,
      },
    })

    revalidatePath(`/dashboard/${userId}/loans`)
    return { success: true }
  } catch (error: any) {
    console.error('Failed to accept loan:', error)
    return { success: false, error: error.message || 'Failed to accept loan' }
  }
}

export const declineLoanOfferAction = async (userId: string, loanId: string, reason: string) => {
  try {
    const loan = await prisma.loan.findFirst({
      where: { id: loanId, userId },
    })

    if (!loan) return { success: false, error: 'Loan not found' }
    if (loan.status !== 'APPROVED') return { success: false, error: 'Only approved loans can be declined' }
    if (!reason || !reason.trim()) return { success: false, error: 'Decline reason is required' }

    await prisma.loan.update({
      where: { id: loanId },
      data: {
        status: LoanStatus.DECLINED,
        rejectionReason: reason,
      },
    })

    revalidatePath(`/dashboard/${userId}/loans`)
    return { success: true }
  } catch (error: any) {
    console.error('Failed to decline loan:', error)
    return { success: false, error: error.message || 'Failed to decline loan' }
  }
}
