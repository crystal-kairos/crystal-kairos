'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import {
  AdminPermission,
  BorrowerOfferDecision,
  GuaranteeState,
  LoanStatus,
  TransactionCategory,
  TransactionStatus,
  TransactionType,
} from '@/generated/prisma/enums'
import { Prisma } from '@/generated/prisma/client'
import {
  assertTargetUserIsMember,
  enforceDualControl,
  requirePermission,
} from '@/lib/authz/guards'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { AppError } from '@/lib/errors/app-error'
import { lockMembers } from '@/lib/db/concurrency'
import {
  calculateApplicantTotalLoanExposure,
  calculateRequiredGuaranteeSupport,
  getBorrowerStandaloneLimit,
} from '@/lib/domain/capacity'
import {
  getMemberEligibleSavingsPrincipal,
  getMemberUnencumberedSavings,
} from '@/lib/services/guarantees.service'
import { validateAmount } from '@/lib/validation/money'
import { generateAndPersistLoanSchedule } from '@/lib/services/schedules.service'

/**
 * Admin approves a loan and sets the final approved amount.
 */
export const approveLoanAction = async (
  loanId: string,
  approvedAmount: number,
) => {
  try {
    const actor = await requirePermission(AdminPermission.LOANS_REVIEW)
    const validatedApprovedAmount = validateAmount(approvedAmount, 'approvedAmount')

    const updated = await prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findUnique({
        where: { id: loanId },
        include: {
          guaranteeReservations: {
            where: {
              state: {
                in: [
                  GuaranteeState.CONSENTED,
                  GuaranteeState.PENDING,
                  GuaranteeState.AWAITING_RECONSENT,
                ],
              },
            },
          },
        },
      })
      if (!loan) {
        throw new AppError('NOT_FOUND', 'Loan not found.', { statusCode: 404 })
      }
      if (loan.status !== LoanStatus.PENDING) {
        throw new AppError(
          'INVALID_STATE',
          'Only pending loans can be approved.',
          { statusCode: 422 },
        )
      }

      // Collect member IDs to lock (borrower and any associated guarantor)
      const reservation = loan.guaranteeReservations[0] || null
      const memberIdsToLock = reservation
        ? [loan.userId, reservation.guarantorId]
        : [loan.userId]
      await lockMembers(tx, memberIdsToLock)

      // Calculate cumulative exposure & guarantee requirements (§2.1)
      const borrowerSavings = await getMemberEligibleSavingsPrincipal(
        loan.userId,
        tx,
      )
      const existingLoans = await tx.loan.findMany({
        where: {
          userId: loan.userId,
          id: { not: loanId },
          status: {
            in: [
              LoanStatus.APPROVED,
              LoanStatus.ACCEPTED,
              LoanStatus.DISBURSED,
              LoanStatus.ACTIVE,
              LoanStatus.OVERDUE,
              LoanStatus.DEFAULTED,
            ],
          },
        },
        select: { approvedAmount: true, requestedAmount: true },
      })

      const standaloneLimit = getBorrowerStandaloneLimit(borrowerSavings)
      const existingExposure = calculateApplicantTotalLoanExposure(existingLoans)
      const totalExposure = existingExposure.plus(validatedApprovedAmount)
      const requiredGuaranteeSupport = calculateRequiredGuaranteeSupport(
        totalExposure,
        standaloneLimit,
      )

      if (requiredGuaranteeSupport.gt(0)) {
        if (!reservation) {
          throw new AppError(
            'GUARANTOR_REQUIRED',
            `Loan requires guarantee support of ₦${requiredGuaranteeSupport.toFixed(2)}, but no guarantor is attached to this loan.`,
            { statusCode: 422 },
          )
        }

        // Check if approved terms differ from consented terms (§2.7)
        const termsDiffer =
          !reservation.consentedAmount.equals(validatedApprovedAmount) ||
          reservation.state === GuaranteeState.AWAITING_RECONSENT

        if (termsDiffer && reservation.state === GuaranteeState.CONSENTED) {
          // Move to AWAITING_RECONSENT and release old reservation
          await tx.guaranteeReservation.update({
            where: { id: reservation.id },
            data: {
              state: GuaranteeState.AWAITING_RECONSENT,
              reservedAmount: new Prisma.Decimal(0),
              requestedAmount: validatedApprovedAmount,
              termsVersion: reservation.termsVersion + 1,
            },
          })

          return {
            needsReconsent: true,
            code: 'AWAITING_RECONSENT',
            error: `Approved amount (₦${validatedApprovedAmount.toFixed(2)}) differs from consented terms (₦${reservation.consentedAmount.toFixed(2)}). Guarantor must re-consent before loan can be approved (§2.7).`,
          }
        }

        if (reservation.state !== GuaranteeState.CONSENTED) {
          throw new AppError(
            'GUARANTOR_CONSENT_REQUIRED',
            `Loan cannot be approved: guarantor has not consented (state: ${reservation.state}).`,
            { statusCode: 422 },
          )
        }
      }

      const res = await tx.loan.update({
        where: { id: loanId },
        data: {
          status: LoanStatus.APPROVED,
          approvedAmount: validatedApprovedAmount,
          approvedBy: actor.id,
          approvedAt: new Date(),
        },
      })

      return res
    })

    if ('needsReconsent' in updated && updated.needsReconsent) {
      return {
        success: false,
        error: updated.error,
        code: updated.code,
      }
    }

    try {
      revalidatePath('/admin/loans')
      revalidatePath(`/admin/loans/${loanId}`)
    } catch {}

    return { success: true, data: updated }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'approveLoanAction',
      fallbackMessage: 'Failed to approve loan.',
      context: { loanId },
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
 * Admin rejects a loan with a mandatory reason.
 */
export const rejectLoanAction = async (
  loanId: string,
  rejectionReason: string,
) => {
  try {
    const actor = await requirePermission(AdminPermission.LOANS_REVIEW)

    const loan = await prisma.loan.findUnique({ where: { id: loanId } })
    if (!loan) return { success: false, error: 'Loan not found.' }
    if (loan.status !== LoanStatus.PENDING) {
      return { success: false, error: 'Only pending loans can be rejected.' }
    }

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
    const err = toActionErrorResult(error, {
      actionName: 'rejectLoanAction',
      fallbackMessage: 'Failed to reject loan.',
      context: { loanId },
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
 * Admin disburses a loan and uploads the receipt.
 */
export const disburseLoanAction = async (
  loanId: string,
  receiptUrl: string,
) => {
  try {
    const actor = await requirePermission(AdminPermission.LOANS_DISBURSE)

    const loan = await prisma.loan.findUnique({ where: { id: loanId } })
    if (!loan) return { success: false, error: 'Loan not found.' }
    if (loan.status !== LoanStatus.ACCEPTED) {
      return { success: false, error: 'Only accepted loans can be disbursed' }
    }
    if (!loan.approvedAmount) {
      return { success: false, error: 'Approved amount is missing.' }
    }

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
    const totalInterest =
      (approvedAmountNum * interestRateNum * loan.duration) / 100
    const initialDebt = approvedAmountNum + totalInterest

    // Run in a transaction: Create disbursement record + update loan
    const result = await prisma.$transaction(async (tx) => {
      // Lock borrower during disbursement (§2.1, §2.7)
      await lockMembers(tx, [loan.userId])

      // Verify borrower explicit offer acceptance (§2.7, §2.9)
      const acceptance = await tx.borrowerOfferAcceptance.findUnique({
        where: { loanId: loan.id },
      })
      if (!acceptance || acceptance.decision !== BorrowerOfferDecision.ACCEPTED) {
        throw new AppError(
          'OFFER_NOT_ACCEPTED',
          'Loan cannot be disbursed: borrower has not explicitly accepted the final loan offer (§2.7).',
          { statusCode: 422 },
        )
      }

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

      await generateAndPersistLoanSchedule(tx, {
        loanId,
        principal: loan.approvedAmount!,
        termMonths: loan.duration,
        monthlyInterestRatePercent: loan.interestRate,
        disbursementValueDate: now,
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
    const err = toActionErrorResult(error, {
      actionName: 'disburseLoanAction',
      fallbackMessage: 'Failed to disburse loan.',
      context: { loanId },
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

export const reviewLoanRepaymentAction = async (
  transactionId: string,
  status: 'CONFIRMED' | 'REJECTED',
  rejectionReason?: string,
) => {
  try {
    const actor = await requirePermission(AdminPermission.LOANS_REVIEW)

    const tx = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { loan: true },
    })

    if (!tx || !tx.loanId) {
      return {
        success: false,
        error: 'Transaction or associated loan not found.',
      }
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

        const newTotalRepaid = new Prisma.Decimal(
          Number(loan.totalRepaid) + Number(tx.amount),
        )
        const newOutstandingBalance = new Prisma.Decimal(
          Math.max(0, Number(loan.outstandingBalance) - Number(tx.amount)),
        )

        await txPrisma.loan.update({
          where: { id: loan.id },
          data: {
            totalRepaid: newTotalRepaid,
            outstandingBalance: newOutstandingBalance,
            actualRepaymentDate:
              newOutstandingBalance.toNumber() <= 0 ? new Date() : undefined,
            status:
              newOutstandingBalance.toNumber() <= 0
                ? LoanStatus.COMPLETED
                : loan.status,
          },
        })
      }
    })

    try {
      revalidatePath(`/admin/loans/${tx.loanId}`)
    } catch {}
    return { success: true }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'reviewLoanRepaymentAction',
      fallbackMessage: 'Failed to review loan repayment.',
      context: { transactionId, status },
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

    // Fetch Global Loan Interest Rate
    const loanSettings = await prisma.loanSettings.findUnique({
      where: { id: 'global' },
    })
    const interestRate = loanSettings?.interestRate
      ? Number(loanSettings.interestRate)
      : 10

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
