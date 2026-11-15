'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import {
  AdminPermission,
  LoanStatus,
  TransactionCategory,
  TransactionStatus,
  TransactionType,
  PenaltyCapType,
} from '@/generated/prisma/enums'
import { Prisma } from '@/generated/prisma/client'
import { getActiveLoanRateForDuration } from '@/lib/services/rate-policy.service'
import { assertTargetUserIsMember, requirePermission } from '@/lib/authz/guards'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { validateAmount } from '@/lib/validation/money'
import { approveLoan, disburseLoan, rejectLoan } from '@/lib/services/loans.service'
import { runLoanOfferExpiryJob } from '@/lib/jobs/loan-offers.job'
import { serializeLoanQuote } from '@/lib/loans'

const errorResult = (error: unknown, actionName: string, fallbackMessage: string, context?: Record<string, unknown>) =>
  toActionErrorResult(error, { actionName, fallbackMessage, context })

function revalidateAdminLoan(loanId: string, memberId?: string) {
  try {
    revalidatePath('/admin/loans')
    revalidatePath(`/admin/loans/${loanId}`)
    if (memberId) {
      revalidatePath(`/dashboard/${memberId}/loans`)
      revalidatePath(`/dashboard/${memberId}/loans/${loanId}`)
    }
  } catch {}
}

/**
 * Admin approves a loan (P3-04, D-07). The admin may approve the requested
 * amount and term, or a lower amount / different term, which needs borrower
 * acceptance and guarantor re-consent (D-10). Never automatic.
 */
export const approveLoanAction = async (
  loanId: string,
  approvedAmount: number,
  options: { approvedTermMonths?: number; note?: string } = {},
) => {
  try {
    const actor = await requirePermission(AdminPermission.LOANS_REVIEW)
    const amount = validateAmount(approvedAmount, 'approvedAmount')
    const term =
      options.approvedTermMonths === undefined || options.approvedTermMonths === null
        ? undefined
        : Number(options.approvedTermMonths)
    const result = await approveLoan({
      loanId: String(loanId),
      actor,
      approvedAmount: amount,
      approvedTermMonths: term,
      note: typeof options.note === 'string' ? options.note.slice(0, 500) : undefined,
    })
    revalidateAdminLoan(result.loan.id, result.loan.userId)
    return {
      success: true,
      data: {
        id: result.loan.id,
        status: result.loan.status as string,
        termsChanged: result.termsChanged,
        quote: serializeLoanQuote(result.quote),
      },
    }
  } catch (error) {
    const err = errorResult(error, 'approveLoanAction', 'Failed to approve loan.', { loanId })
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
 * Admin rejects a loan with a mandatory reason; reservations are released.
 */
export const rejectLoanAction = async (loanId: string, rejectionReason: string) => {
  try {
    const actor = await requirePermission(AdminPermission.LOANS_REVIEW)
    const loan = await rejectLoan({ loanId: String(loanId), actor, reason: String(rejectionReason ?? '') })
    revalidateAdminLoan(loan.id, loan.userId)
    return { success: true, data: { id: loan.id, status: loan.status as string } }
  } catch (error) {
    const err = errorResult(error, 'rejectLoanAction', 'Failed to reject loan.', { loanId })
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
 * Records the offline loan disbursement (ACCEPTED → ACTIVE): amount, value
 * date (schedule anchor), bank reference and evidence. Dual control (A-19):
 * the approver cannot disburse when another eligible staff user exists.
 */
export const disburseLoanAction = async (
  loanId: string,
  input: {
    amount: number
    valueDate: string
    bankReference: string
    evidenceFileId: string
    bankAccountId?: string
  },
) => {
  try {
    const actor = await requirePermission(AdminPermission.LOANS_DISBURSE)
    const amount = validateAmount(input?.amount, 'amount')
    const result = await disburseLoan({
      loanId: String(loanId),
      actor,
      amount,
      valueDate: String(input?.valueDate ?? ''),
      bankReference: String(input?.bankReference ?? ''),
      evidenceFileId: String(input?.evidenceFileId ?? ''),
      bankAccountId: input?.bankAccountId ? String(input.bankAccountId) : undefined,
    })
    revalidateAdminLoan(result.loan.id, result.loan.userId)
    return {
      success: true,
      data: {
        id: result.loan.id,
        status: result.loan.status as string,
        disbursementNumber: result.disbursement.disbursementNumber,
        isReplay: result.isReplay,
      },
    }
  } catch (error) {
    const err = errorResult(error, 'disburseLoanAction', 'Failed to disburse loan.', { loanId })
    return {
      success: false,
      error: err.error,
      code: err.code,
      fieldErrors: err.fieldErrors,
      correlationId: err.correlationId,
    }
  }
}

/** Runs the offer-expiry job on demand (until P4-04 schedules it). */
export const expireLoanOffersAction = async () => {
  try {
    await requirePermission(AdminPermission.LOANS_REVIEW)
    const result = await runLoanOfferExpiryJob()
    try {
      revalidatePath('/admin/loans')
    } catch {}
    return { success: true, data: result }
  } catch (error) {
    const err = errorResult(error, 'expireLoanOffersAction', 'Failed to expire loan offers.')
    return {
      success: false,
      error: err.error,
      code: err.code,
      fieldErrors: err.fieldErrors,
      correlationId: err.correlationId,
    }
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

    const {
      userId,
      purpose,
      requestedAmount,
      duration,
      status,
      approvedAmount,
    } = data

    const validatedRequestedAmount = validateAmount(requestedAmount, 'requestedAmount')
    const validatedApprovedAmount = approvedAmount
      ? validateAmount(approvedAmount, 'approvedAmount')
      : undefined

    await assertTargetUserIsMember(userId)

    // Verify member exists and has bank accounts
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { bankAccounts: true },
    })

    if (!user) return { success: false, error: 'Member not found.' }
    if (!user.bankAccounts || user.bankAccounts.length === 0) {
      return {
        success: false,
        error: 'Member must have a bank account set up first.',
      }
    }

    // Fetch Active Loan Rate for duration (§2.9, D-05)
    const activeRate = await getActiveLoanRateForDuration(duration)
    const interestRate = activeRate ? Number(activeRate.monthlyInterestPercent) : 5.0
    const latePenaltyDailyPercent = activeRate ? activeRate.latePenaltyDailyPercent : new Prisma.Decimal('0.5')
    const penaltyCapType = activeRate ? activeRate.penaltyCapType : PenaltyCapType.PERCENT_OF_PRINCIPAL
    const penaltyCapValue = activeRate ? activeRate.penaltyCapValue : new Prisma.Decimal('10.0')
    const rateVersion = activeRate ? activeRate.version : 1

    const actualApprovedAmount = validatedApprovedAmount
      ? validatedApprovedAmount.toNumber()
      : validatedRequestedAmount.toNumber()

    // Total repayment = Principal + (Principal * Interest Rate / 100)
    let totalRepayment = validatedRequestedAmount.toNumber()
    let outstandingBalance = validatedRequestedAmount.toNumber()

    if (
      status === LoanStatus.DISBURSED ||
      status === LoanStatus.ACCEPTED ||
      status === LoanStatus.APPROVED
    ) {
      const interestAmount = (actualApprovedAmount * interestRate) / 100
      totalRepayment = actualApprovedAmount + interestAmount
      outstandingBalance = totalRepayment
    }

    const newLoan = await prisma.loan.create({
      data: {
        userId,
        purpose,
        requestedAmount: validatedRequestedAmount,
        approvedAmount:
          status === LoanStatus.DISBURSED ||
          status === LoanStatus.ACCEPTED ||
          status === LoanStatus.APPROVED
            ? new Prisma.Decimal(actualApprovedAmount)
            : null,
        outstandingBalance: new Prisma.Decimal(outstandingBalance),
        interestRate: new Prisma.Decimal(interestRate),
        monthlyInterestRatePercent: new Prisma.Decimal(interestRate),
        interestCalculationMethod: 'FLAT_MONTHLY_ON_ORIGINAL_PRINCIPAL',
        latePenaltyDailyPercent,
        penaltyCapType,
        penaltyCapValue,
        loanTermRateVersion: rateVersion,
        duration,
        status,
        repaymentEndDate: new Date(
          Date.now() + duration * 30 * 24 * 60 * 60 * 1000,
        ), // Approx. duration months
      },
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
        },
      })
    }

    try {
      revalidatePath('/admin/loans')
      revalidatePath(`/dashboard/${userId}/loans`)
    } catch {}
    return { success: true, data: newLoan }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'createLoanForMemberAction',
      fallbackMessage: 'Failed to create loan record.',
      context: { userId: data.userId },
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
