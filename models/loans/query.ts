'use server'

import { prisma } from '@/lib/prisma'
import {
  AdminPermission,
  AllocationStatus,
  AllocationTargetType,
  FeeType,
  GuaranteeType,
  PaymentSubmissionStatus,
} from '@/generated/prisma/enums'
import {
  AuthzError,
  requireMemberOrStaffWithPermission,
} from '@/lib/authz/guards'
import {
  serializeInstalment,
  serializeLoanQuote,
  serializeSettlementQuote,
} from '@/lib/loans'
import {
  computeSettlementQuote,
  LOAN_REPAYABLE_STATUSES,
} from '@/lib/domain/loan-workflow'
import { getFeeOutstanding, quoteFromLoan } from '@/lib/services/loans.service'
import { getWalletSummary } from '@/lib/services/wallet.service'

/**
 * Loan details for the member (or staff with loan permissions): persisted
 * instalments, offer and total cost, guarantee state, fee, settlement quote,
 * receipts under review and a breakdown of what each payment covered.
 */
export const getLoanPlanById = async (loanId: string) => {
  try {
    const loan = await prisma.loan.findUnique({
      where: { id: loanId },
      include: {
        user: { select: { id: true, name: true, email: true } },
        instalments: { orderBy: { instalmentNumber: 'asc' } },
        guaranteeReservations: {
          where: { guaranteeType: GuaranteeType.LOAN },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            state: true,
            termsVersion: true,
            consentedAt: true,
            guarantor: { select: { id: true, name: true } },
          },
        },
        offerAcceptance: {
          select: { decision: true, termsVersion: true, decidedAt: true, evidenceDocumentId: true },
        },
      },
    })

    if (!loan) {
      return { success: false, error: 'Loan not found.' }
    }

    const actor = await requireMemberOrStaffWithPermission(loan.userId, [
      AdminPermission.LOANS_READ,
      AdminPermission.LOANS_REVIEW,
      AdminPermission.LOANS_DISBURSE,
    ])

    const [allocations, pendingSubmissions, fee] = await Promise.all([
      prisma.paymentAllocation.findMany({
        where: { targetType: AllocationTargetType.LOAN, targetId: loan.id, status: AllocationStatus.ACTIVE },
        include: { payment: { select: { id: true, paymentNumber: true, valueDate: true, source: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.paymentSubmission.findMany({
        where: {
          memberId: loan.userId,
          status: PaymentSubmissionStatus.SUBMITTED,
          targets: { some: { targetType: AllocationTargetType.LOAN, targetId: loan.id } },
        },
        select: { id: true, submissionNumber: true, claimedAmount: true, paidOn: true, submittedAt: true, purpose: true },
        orderBy: { submittedAt: 'desc' },
      }),
      prisma.feeAssessment.findFirst({
        where: { feeType: FeeType.LOAN_APPLICATION, targetId: loan.id },
        orderBy: { assessedAt: 'desc' },
      }),
    ])

    // Plain-language breakdown per payment (§4.2): penalty / interest / principal
    const byPayment = new Map<
      string,
      { paymentId: string; paymentNumber: string; valueDate: Date; source: string; penalty: number; interest: number; principal: number }
    >()
    for (const a of allocations) {
      const row =
        byPayment.get(a.paymentId) ??
        {
          paymentId: a.paymentId,
          paymentNumber: a.payment.paymentNumber,
          valueDate: a.payment.valueDate,
          source: a.payment.source as string,
          penalty: 0,
          interest: 0,
          principal: 0,
        }
      if (a.componentType === 'PENALTY') row.penalty += Number(a.amount)
      else if (a.componentType === 'INTEREST') row.interest += Number(a.amount)
      else row.principal += Number(a.amount)
      byPayment.set(a.paymentId, row)
    }

    let offerQuote = null
    try {
      offerQuote = serializeLoanQuote(quoteFromLoan(loan))
    } catch {
      offerQuote = null // legacy row without snapshotted penalty terms
    }
    const settlementQuote = LOAN_REPAYABLE_STATUSES.includes(loan.status)
      ? serializeSettlementQuote(computeSettlementQuote(loan.instalments))
      : null
    const feeOutstanding = fee ? (await getFeeOutstanding(prisma, fee.id)).outstanding.toNumber() : 0
    const wallet =
      actor.role === 'USER' ? await getWalletSummary(loan.userId) : null

    const guarantee = loan.guaranteeReservations[0] ?? null
    return {
      success: true,
      data: {
        id: loan.id,
        userId: loan.userId,
        status: loan.status as string,
        purpose: loan.purpose,
        requestedAmount: loan.requestedAmount.toNumber(),
        approvedAmount: loan.approvedAmount?.toNumber() ?? null,
        duration: loan.duration,
        requestedDurationMonths: loan.requestedDurationMonths,
        monthlyInterestRatePercent: Number(loan.monthlyInterestRatePercent ?? loan.interestRate),
        applicationFee: loan.applicationFee.toNumber(),
        outstandingBalance: loan.outstandingBalance.toNumber(),
        totalRepaid: loan.totalRepaid.toNumber(),
        termsVersion: loan.termsVersion,
        rejectionReason: loan.rejectionReason,
        approvalNote: loan.approvalNote,
        createdAt: loan.createdAt,
        approvedAt: loan.approvedAt,
        approvedBy: loan.approvedBy,
        offerExpiresAt: loan.offerExpiresAt,
        disbursedAt: loan.disbursedAt,
        disbursementValueDate: loan.disbursementValueDate,
        completedAt: loan.completedAt,
        user: { id: loan.user.id, name: loan.user.name, email: loan.user.email },
        instalments: loan.instalments.map(serializeInstalment),
        offerQuote,
        settlementQuote,
        guarantee: guarantee
          ? {
              state: guarantee.state as string,
              termsVersion: guarantee.termsVersion,
              consentedAt: guarantee.consentedAt,
              guarantorName: guarantee.guarantor.name,
            }
          : null,
        offer: loan.offerAcceptance
          ? {
              decision: loan.offerAcceptance.decision as string,
              termsVersion: loan.offerAcceptance.termsVersion,
              decidedAt: loan.offerAcceptance.decidedAt,
              evidenceDocumentId: loan.offerAcceptance.evidenceDocumentId,
            }
          : null,
        fee: fee
          ? { id: fee.id, amount: Number(fee.amount), status: fee.status as string, outstanding: feeOutstanding }
          : null,
        pendingSubmissions: pendingSubmissions.map((s) => ({
          ...s,
          claimedAmount: Number(s.claimedAmount),
        })),
        payments: [...byPayment.values()],
        availableWallet: wallet ? wallet.availableBalance.toNumber() : null,
      },
    }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error fetching loan plan:', error)
    return { success: false, error: 'Failed to fetch loan plan.' }
  }
}

/**
 * Loan guarantee requests addressed to this member as guarantor (§2.7, P3-04).
 * Each row carries the exact terms the guarantor is asked to consent to (amount, term,
 * rate, instalment, total repayable, penalty terms and cap) and how much of the
 * guarantor's savings would be reserved. Members read their own; staff need
 * LOANS_READ or GUARANTEES_REVIEW.
 */
export const getMyLoanGuaranteeRequests = async (userId: string) => {
  try {
    const actor = await requireMemberOrStaffWithPermission(userId, [
      AdminPermission.LOANS_READ,
      AdminPermission.GUARANTEES_REVIEW,
    ])

    const rows = await prisma.guaranteeReservation.findMany({
      where: { guarantorId: userId, guaranteeType: GuaranteeType.LOAN },
      orderBy: { createdAt: 'desc' },
      include: {
        applicant: { select: { name: true } },
        loan: {
          select: {
            id: true,
            status: true,
            purpose: true,
            requestedAmount: true,
            approvedAmount: true,
            duration: true,
            interestRate: true,
            monthlyInterestRatePercent: true,
            latePenaltyDailyPercent: true,
            penaltyCapType: true,
            penaltyCapValue: true,
            applicationFee: true,
          },
        },
      },
    })

    return {
      success: true,
      viewerIsGuarantor: actor.id === userId,
      data: rows.map((r) => {
        let quote: ReturnType<typeof serializeLoanQuote> | null = null
        if (r.loan) {
          try {
            quote = serializeLoanQuote(quoteFromLoan(r.loan))
          } catch {
            quote = null // legacy loans without snapshotted penalty terms
          }
        }
        const reserved = r.state === 'CONSENTED' ? r.reservedAmount : r.requestedAmount
        return {
          id: r.id,
          state: r.state,
          applicantName: r.applicant.name,
          loanId: r.loanId,
          loanStatus: r.loan?.status ?? null,
          purpose: r.loan?.purpose ?? '',
          isRevisedTerms: r.state === 'AWAITING_RECONSENT',
          guaranteeAmount: Number(reserved),
          quote,
          decisionReason: r.decisionReason,
          hasEvidence: Boolean(r.evidenceDocumentId),
          createdAt: r.createdAt.toISOString(),
          consentedAt: r.consentedAt ? r.consentedAt.toISOString() : null,
        }
      }),
    }
  } catch (error) {
    return {
      success: false,
      viewerIsGuarantor: false,
      data: [],
      error: error instanceof AuthzError ? error.message : 'Unable to load guarantee requests.',
    }
  }
}
