'use server'

import { prisma } from '@/lib/prisma'
import {
  LoanStatus,
  TransactionCategory,
  TransactionType,
  TransactionStatus,
  UserRole,
} from '@/generated/prisma/enums'
import { revalidatePath } from 'next/cache'
import { serializeLoan, serializeTransaction } from '@/lib/loans'
import { Prisma } from '@/generated/prisma/client'
import {
  requireAuthenticatedSession,
  requireMemberSession,
} from '@/lib/authz/guards'
import { bindStoredFileToRecord } from '@/lib/storage/cloudinary'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { AppError } from '@/lib/errors/app-error'
import { validateAmount } from '@/lib/validation/money'
import {
  decideGuarantorRequest,
  recordBorrowerOfferAcceptance,
  requestLoanGuarantor,
  withdrawGuarantorConsent,
} from '@/lib/services/guarantees.service'

/**
 * Searches for an active cooperative member by email to nominate as a guarantor.
 * Staff accounts (OWNER / ADMIN) are never eligible to be members or guarantors (D-15).
 */
export const searchMemberByEmailAction = async (email: string) => {
  try {
    await requireAuthenticatedSession()

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

    if (!member || member.role !== UserRole.USER) {
      return {
        success: false,
        error: 'No cooperative member found with this email.',
      }
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
    const err = toActionErrorResult(error, {
      actionName: 'searchMemberByEmailAction',
      fallbackMessage: 'An error occurred during search.',
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
  },
) => {
  try {
    const actor = await requireMemberSession(userId)
    const validatedRequestedAmount = validateAmount(
      data.requestedAmount,
      'requestedAmount',
    )
    const requestedAmountNum = validatedRequestedAmount.toNumber()

    // 1. Fetch user's savings balance to calculate eligibility and tiers
    const savings = await prisma.savings.findMany({
      where: { userId: actor.id, status: 'ACTIVE' },
      select: { currentBalance: true },
    })

    const totalSavings = savings.reduce(
      (sum, s) => sum + Number(s.currentBalance),
      0,
    )
    const borrowLimit = totalSavings * 2

    // 2. Validate borrowing limit if member has savings
    if (totalSavings > 0 && requestedAmountNum > borrowLimit) {
      return {
        success: false,
        error: `Requested amount exceeds borrowing limit of ${new Intl.NumberFormat(
          'en-NG',
          {
            style: 'currency',
            currency: 'NGN',
          },
        ).format(borrowLimit)} (double your savings).`,
      }
    }

    // 3. Fetch global loan interest rate
    let interestRate = 5 // Fallback
    const settings = await prisma.loanSettings.findUnique({
      where: { id: 'global' },
    })
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
        return {
          success: false,
          error: searchRes.error || 'Guarantor verification failed.',
        }
      }
      guarantorId = searchRes.member.id
      guarantorName = searchRes.member.name
      guarantorPhoneNumber = searchRes.member.phoneNumber
    }

    // 5. Create PENDING Loan record & guarantor reservation if guarantor provided
    const newLoan = await prisma.$transaction(async (tx) => {
      const loan = await tx.loan.create({
        data: {
          userId: actor.id,
          requestedAmount: validatedRequestedAmount,
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

      if (guarantorId) {
        await requestLoanGuarantor(tx, {
          loanId: loan.id,
          applicantId: actor.id,
          guarantorId,
          requestedAmount: validatedRequestedAmount,
          termMonths: data.duration,
          monthlyInterestRate: interestRate,
        })
      }

      return loan
    })

    try {
      revalidatePath(`/dashboard/${actor.id}/loans`)
      revalidatePath(`/dashboard/${actor.id}`)
    } catch {
      // Ignored outside Next.js context
    }

    return { success: true, data: serializeLoan(newLoan) }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'applyForLoanAction',
      fallbackMessage: 'Failed to apply for loan.',
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
  },
) => {
  try {
    const actor = await requireMemberSession(userId)
    const validatedAmount = validateAmount(data.amount)

    const loan = await prisma.loan.findFirst({
      where: { id: data.loanId, userId: actor.id },
    })

    if (!loan) {
      return { success: false, error: 'Loan not found.' }
    }

    if (
      loan.status !== LoanStatus.ACTIVE &&
      loan.status !== LoanStatus.OVERDUE &&
      loan.status !== LoanStatus.DEFAULTED
    ) {
      return {
        success: false,
        error:
          'Repayment is only allowed on active, overdue, or defaulted loans.',
      }
    }

    const newTransaction = await prisma.transaction.create({
      data: {
        userId: actor.id,
        amount: validatedAmount,
        category: TransactionCategory.LOAN_REPAYMENT,
        type: TransactionType.DEPOSIT,
        status: TransactionStatus.PENDING,
        loanId: data.loanId,
        receiptUrl: data.receiptUrl,
        referenceNumber: data.referenceNumber || null,
        notes: data.notes || null,
        recordedBy: actor.id,
      },
    })

    await bindStoredFileToRecord({
      fileUrl: data.receiptUrl,
      ownerUserId: actor.id,
      associatedType: 'TRANSACTION',
      associatedId: newTransaction.id,
    })

    try {
      revalidatePath(`/dashboard/${actor.id}/loans`)
      revalidatePath(`/dashboard/${actor.id}`)
    } catch {
      // Ignored outside Next.js context
    }

    return { success: true, data: serializeTransaction(newTransaction) }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'submitLoanRepaymentAction',
      fallbackMessage: 'Failed to submit loan repayment.',
      context: { userId, loanId: data.loanId },
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

export const acceptLoanOfferAction = async (userId: string, loanId: string) => {
  try {
    const actor = await requireMemberSession(userId)

    const loan = await prisma.loan.findFirst({
      where: { id: loanId, userId: actor.id },
    })

    if (!loan) {
      return { success: false, error: 'Loan not found' }
    }
    if (loan.status !== LoanStatus.APPROVED) {
      return { success: false, error: 'Only approved loans can be accepted' }
    }

    const principal =
      loan.approvedAmount || loan.requestedAmount || new Prisma.Decimal(0)
    const rateNum = Number(loan.interestRate || 0)
    const duration = loan.duration || 1
    const totalInterest = (Number(principal) * rateNum * duration) / 100
    const totalScheduledRepayment = Number(principal) + totalInterest
    const monthlyInstalment =
      duration > 0 ? totalScheduledRepayment / duration : totalScheduledRepayment

    let result: unknown
    try {
      result = await prisma.$transaction(async (tx) => {
        return recordBorrowerOfferAcceptance(tx, {
          loanId,
          borrowerId: actor.id,
          decision: 'ACCEPT',
          offeredPrincipal: principal,
          offeredTermMonths: duration,
          offeredMonthlyInterestRate: loan.interestRate || new Prisma.Decimal(0),
          totalScheduledRepayment,
          monthlyInstalment,
        })
      })
    } catch {
      result = await prisma.loan.update({
        where: { id: loanId },
        data: {
          status: LoanStatus.ACCEPTED,
        },
      })
    }

    try {
      revalidatePath(`/dashboard/${actor.id}/loans`)
    } catch {}
    return { success: true, data: result }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'acceptLoanOfferAction',
      fallbackMessage: 'Failed to accept loan',
      context: { userId, loanId },
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

export const declineLoanOfferAction = async (
  userId: string,
  loanId: string,
  reason: string,
) => {
  try {
    const actor = await requireMemberSession(userId)
    if (!reason || !reason.trim()) {
      return { success: false, error: 'Decline reason is required' }
    }

    const loan = await prisma.loan.findFirst({
      where: { id: loanId, userId: actor.id },
    })

    if (!loan) {
      return { success: false, error: 'Loan not found' }
    }
    if (loan.status !== LoanStatus.APPROVED) {
      return { success: false, error: 'Only approved loans can be declined' }
    }

    const principal =
      loan.approvedAmount || loan.requestedAmount || new Prisma.Decimal(0)
    const rateNum = Number(loan.interestRate || 0)
    const duration = loan.duration || 1
    const totalInterest = (Number(principal) * rateNum * duration) / 100
    const totalScheduledRepayment = Number(principal) + totalInterest
    const monthlyInstalment =
      duration > 0 ? totalScheduledRepayment / duration : totalScheduledRepayment

    let outcome: unknown
    try {
      outcome = await prisma.$transaction(async (tx) => {
        const res = await recordBorrowerOfferAcceptance(tx, {
          loanId,
          borrowerId: actor.id,
          decision: 'DECLINE',
          offeredPrincipal: principal,
          offeredTermMonths: duration,
          offeredMonthlyInterestRate: loan.interestRate || new Prisma.Decimal(0),
          totalScheduledRepayment,
          monthlyInstalment,
        })

        await tx.loan.update({
          where: { id: loanId },
          data: {
            rejectionReason: reason,
          },
        })

        return res
      })
    } catch {
      outcome = await prisma.loan.update({
        where: { id: loanId },
        data: {
          status: LoanStatus.DECLINED,
          rejectionReason: reason,
        },
      })
    }

    try {
      revalidatePath(`/dashboard/${actor.id}/loans`)
    } catch {}
    return { success: true, data: outcome }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'declineLoanOfferAction',
      fallbackMessage: 'Failed to decline loan',
      context: { userId, loanId },
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
 * Guarantor accepts or declines a guarantee request (§2.7).
 * Strictly authenticates the guarantor member actor and cannot be called by the applicant.
 */
export const decideGuarantorRequestAction = async (params: {
  reservationId: string
  decision: 'ACCEPT' | 'DECLINE'
  reason?: string
}) => {
  try {
    const actor = await requireAuthenticatedSession()
    if (actor.role !== UserRole.USER) {
      throw new AppError(
        'FORBIDDEN',
        'Staff accounts cannot act as guarantors.',
        { statusCode: 403 },
      )
    }

    const result = await prisma.$transaction(async (tx) => {
      return decideGuarantorRequest(tx, {
        reservationId: params.reservationId,
        guarantorId: actor.id,
        decision: params.decision,
        reason: params.reason,
      })
    })

    try {
      revalidatePath(`/dashboard/${actor.id}/guarantees`)
      revalidatePath(`/dashboard/${actor.id}`)
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'decideGuarantorRequestAction',
      fallbackMessage: 'Failed to process guarantee decision.',
      context: { reservationId: params.reservationId },
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
 * Guarantor withdraws consent before loan activation (§2.7).
 */
export const withdrawGuarantorConsentAction = async (params: {
  reservationId: string
  reason: string
}) => {
  try {
    const actor = await requireAuthenticatedSession()
    if (actor.role !== UserRole.USER) {
      throw new AppError(
        'FORBIDDEN',
        'Staff accounts cannot act as guarantors.',
        { statusCode: 403 },
      )
    }

    const result = await prisma.$transaction(async (tx) => {
      return withdrawGuarantorConsent(tx, {
        reservationId: params.reservationId,
        guarantorId: actor.id,
        reason: params.reason,
      })
    })

    try {
      revalidatePath(`/dashboard/${actor.id}/guarantees`)
    } catch {}

    return { success: true, data: result }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'withdrawGuarantorConsentAction',
      fallbackMessage: 'Failed to withdraw guarantee consent.',
      context: { reservationId: params.reservationId },
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
