'use server'

import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import {
  AdminPermission,
  MembershipStatus,
  LoanStatus,
  EAjoStatus,
  TransactionStatus,
  TransactionType,
  TransactionCategory,
  UserRole,
} from '@/generated/prisma/enums'
import {
  AuthzError,
  requireAnyPermission,
  requirePermission,
  requireStaffSession,
} from '@/lib/authz/guards'
import { queryAuditEvents, AuditQueryParams } from '@/lib/services/audit.service'
import { getLoanPlanById } from '@/models/loans/query'
import { getLoanReviewContext } from '@/lib/services/loans.service'
import { maskAccountNumber } from '@/lib/domain/profile-change'

/**
 * Fetches comprehensive aggregate statistics and activity feeds for the Admin Dashboard
 */
export const getAdminDashboardStats = async () => {
  try {
    await requireStaffSession()

    // 1. Pending Receipts (awaiting review - deposits that are PENDING)
    const pendingReceiptsCount = await prisma.transaction.count({
      where: {
        status: TransactionStatus.PENDING,
        type: TransactionType.DEPOSIT,
      },
    })

    // 2. Disbursements Due (money-out transactions that are PENDING)
    const disbursementsDueCount = await prisma.transaction.count({
      where: {
        status: TransactionStatus.PENDING,
        type: TransactionType.WITHDRAWAL,
      },
    })

    // 3. Active Members (approved KYC users)
    const activeMembersCount = await prisma.user.count({
      where: {
        role: 'USER',
        membership: {
          status: MembershipStatus.APPROVED,
        },
      },
    })

    // 4. Active Ajo Groups
    const activeGroupsCount = await prisma.eAjo.count({
      where: {
        status: EAjoStatus.ACTIVE,
      },
    })

    // 5. Pending KYC Documents (Memberships awaiting approval)
    const pendingKycCount = await prisma.membership.count({
      where: {
        status: MembershipStatus.PENDING,
      },
    })

    // 6. Recent Admin Actions (last 5 processed or verified transactions)
    const recentTransactions = await prisma.transaction.findMany({
      where: {
        status: {
          in: [
            TransactionStatus.CONFIRMED,
            TransactionStatus.DISBURSED,
            TransactionStatus.REJECTED,
          ],
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
      take: 5,
      include: {
        user: {
          select: { name: true },
        },
        processor: {
          select: { name: true },
        },
      },
    })

    // Map recent actions to a clean UI format
    const recentActions = recentTransactions.map((tx) => {
      let actionLabel = ''
      if (tx.status === TransactionStatus.CONFIRMED) {
        actionLabel = 'Approved Receipt'
      } else if (tx.status === TransactionStatus.DISBURSED) {
        actionLabel = 'Processed Payout'
      } else if (tx.status === TransactionStatus.REJECTED) {
        actionLabel = 'Rejected Receipt'
      }

      let targetLabel = 'Transaction'
      if (
        tx.category === TransactionCategory.SAVINGS_DEPOSIT ||
        tx.category === TransactionCategory.SAVINGS_WITHDRAWAL
      ) {
        targetLabel = `Savings: ${tx.savingsId ? tx.savingsId.substring(0, 8).toUpperCase() : 'Plan'}`
      } else if (
        tx.category === TransactionCategory.LOAN_DISBURSEMENT ||
        tx.category === TransactionCategory.LOAN_REPAYMENT
      ) {
        targetLabel = `Loan: ${tx.loanId ? tx.loanId.substring(0, 8).toUpperCase() : 'Record'}`
      } else if (
        tx.category === TransactionCategory.AJO_CONTRIBUTION ||
        tx.category === TransactionCategory.AJO_PAYOUT
      ) {
        targetLabel = `Ajo: ${tx.eAjoId ? tx.eAjoId.substring(0, 8).toUpperCase() : 'Group'}`
      }

      return {
        id: tx.id,
        timestamp: tx.processedAt || tx.updatedAt,
        adminName: tx.processor?.name || 'System Auto',
        action: actionLabel,
        target: targetLabel,
        status: tx.status,
      }
    })

    return {
      success: true,
      data: {
        pendingReceiptsCount,
        disbursementsDueCount,
        activeMembersCount,
        activeGroupsCount,
        pendingKycCount,
        recentActions,
      },
    }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error fetching admin dashboard stats:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to fetch admin stats.',
    }
  }
}

/**
 * Fetches all administrators and owners for the staff directory list
 */
export const getAdminStaffMembers = async () => {
  try {
    const actor = await requirePermission(AdminPermission.STAFF_MANAGE)

    const staff = await prisma.user.findMany({
      where: {
        role: {
          in: ['ADMIN', 'OWNER'],
        },
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        lastLoginAt: true,
        createdAt: true,
        adminPermissionGrants: {
          select: {
            permission: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    })

    const formatted = staff.map((s) => ({
      id: s.id,
      name: s.name,
      email: s.email,
      role: s.role,
      lastLoginAt: s.lastLoginAt,
      createdAt: s.createdAt,
      permissions: s.adminPermissionGrants.map((g) => g.permission),
    }))

    return {
      success: true,
      data: formatted,
      actorRole: actor.role,
    }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error fetching admin staff:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to fetch admin staff.',
    }
  }
}

/**
 * Fetches all pending deposit receipts for the Verification Queue
 */
export const getPendingReceipts = async () => {
  try {
    await requireAnyPermission([
      AdminPermission.TRANSACTIONS_READ,
      AdminPermission.TRANSACTIONS_REVIEW,
      AdminPermission.SAVINGS_PAYMENTS_REVIEW,
      AdminPermission.LOANS_REVIEW,
      AdminPermission.EAJO_PAYMENTS_REVIEW,
    ])

    const receipts = await prisma.transaction.findMany({
      where: {
        status: TransactionStatus.PENDING,
        type: TransactionType.DEPOSIT,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            userInfo: {
              select: {
                phoneNumber: true,
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    })

    // Serialize Decimal values to prevent RSC errors
    const serializedReceipts = receipts.map((rx) => ({
      id: rx.id,
      userId: rx.userId,
      amount: Number(rx.amount),
      category: rx.category,
      type: rx.type,
      status: rx.status,
      eAjoId: rx.eAjoId,
      savingsId: rx.savingsId,
      loanId: rx.loanId,
      receiptUrl: rx.receiptUrl,
      rejectionReason: rx.rejectionReason,
      referenceNumber: rx.referenceNumber,
      notes: rx.notes,
      recordedBy: rx.recordedBy,
      createdAt: rx.createdAt,
      user: rx.user,
    }))

    return { success: true, data: serializedReceipts }
  } catch (error) {
    console.error('Error fetching pending receipts:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to fetch pending receipts.',
    }
  }
}

/**
 * Fetches all pending money-out disbursements for the Disbursements Queue
 */
export const getPendingDisbursements = async () => {
  try {
    await requireAnyPermission([
      AdminPermission.TRANSACTIONS_READ,
      AdminPermission.TRANSACTIONS_REVIEW,
      AdminPermission.LOANS_DISBURSE,
      AdminPermission.EAJO_PAYOUTS_MANAGE,
      AdminPermission.WALLET_WITHDRAWALS_REVIEW,
    ])

    const disbursements = await prisma.transaction.findMany({
      where: {
        status: TransactionStatus.PENDING,
        type: TransactionType.WITHDRAWAL,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            membership: {
              select: {
                membershipNumber: true,
              },
            },
          },
        },
        bankAccount: {
          select: {
            bankName: true,
            accountNumber: true,
            accountName: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc', // Oldest first
      },
    })

    // Serialize Decimal amounts to prevent RSC errors
    const serializedDisbursements = disbursements.map((dx) => ({
      id: dx.id,
      userId: dx.userId,
      amount: Number(dx.amount),
      category: dx.category,
      type: dx.type,
      status: dx.status,
      eAjoId: dx.eAjoId,
      savingsId: dx.savingsId,
      loanId: dx.loanId,
      receiptUrl: dx.receiptUrl,
      rejectionReason: dx.rejectionReason,
      referenceNumber: dx.referenceNumber,
      notes: dx.notes,
      bankAccountId: dx.bankAccountId,
      recordedBy: dx.recordedBy,
      createdAt: dx.createdAt,
      user: dx.user,
      bankAccount: dx.bankAccount,
    }))

    return { success: true, data: serializedDisbursements }
  } catch (error) {
    console.error('Error fetching pending disbursements:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to fetch pending disbursements.',
    }
  }
}

// ============================================
// E-AJO GROUP ADMIN QUERIES
// ============================================

/**
 * Fetches all eAjo groups with member counts and slot fill status
 */
export const getAllEAjoGroups = async () => {
  try {
    await requireAnyPermission([
      AdminPermission.EAJO_READ,
      AdminPermission.EAJO_MANAGE,
      AdminPermission.EAJO_PAYMENTS_REVIEW,
      AdminPermission.EAJO_PAYOUTS_MANAGE,
    ])

    const groups = await prisma.eAjoGroup.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { members: true } },
        createdByUser: { select: { name: true } },
      },
    })

    const serialized = groups.map((g) => ({
      ...g,
      contributionAmount: Number(g.contributionAmount),
    }))

    return { success: true, data: serialized }
  } catch (error) {
    console.error('Error fetching eAjo groups:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to fetch eAjo groups.',
    }
  }
}


/**
 * Fetches all pending member applications across all groups
 */
export const getPendingEAjoApplications = async () => {
  try {
    await requireAnyPermission([
      AdminPermission.EAJO_READ,
      AdminPermission.EAJO_MANAGE,
    ])

    const applications = await prisma.eAjoMember.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { id: true, name: true, email: true } },
        group: {
          select: {
            id: true,
            title: true,
            contributionAmount: true,
            duration: true,
          },
        },
      },
    })

    const serialized = applications.map((a) => ({
      ...a,
      feePercentage: Number(a.feePercentage),
      feeAmount: Number(a.feeAmount),
      totalExpectedPayout: Number(a.totalExpectedPayout),
      netPayoutAmount: Number(a.netPayoutAmount),
      currentBalance: Number(a.currentBalance),
      totalContributed: Number(a.totalContributed),
      group: {
        ...a.group,
        contributionAmount: Number(a.group.contributionAmount),
      },
    }))

    return { success: true, data: serialized }
  } catch (error) {
    console.error('Error fetching pending eAjo applications:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to fetch pending applications.',
    }
  }
}

// ============================================
// ADMIN LOANS QUERIES
// ============================================

export const getAllLoansQuery = async (filters?: { status?: LoanStatus }) => {
  try {
    await requireAnyPermission([
      AdminPermission.LOANS_READ,
      AdminPermission.LOANS_REVIEW,
      AdminPermission.LOANS_DISBURSE,
      AdminPermission.LOAN_SETTINGS_MANAGE,
    ])

    const loans = await prisma.loan.findMany({
      where: filters?.status ? { status: filters.status } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true, photoUrl: true } },
      },
    })

    const serialized = loans.map((loan) => ({
      ...loan,
      requestedAmount: Number(loan.requestedAmount),
      approvedAmount: loan.approvedAmount ? Number(loan.approvedAmount) : null,
      interestRate: Number(loan.interestRate),
      applicationFee: Number(loan.applicationFee),
      outstandingBalance: Number(loan.outstandingBalance),
      totalRepaid: Number(loan.totalRepaid),
      defaultPenalty: Number(loan.defaultPenalty),
    }))

    return { success: true, data: serialized }
  } catch (error) {
    console.error('Error fetching admin loans:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch loans.',
    }
  }
}

export const getLoanByIdQuery = async (loanId: string) => {
  try {
    await requireAnyPermission([
      AdminPermission.LOANS_READ,
      AdminPermission.LOANS_REVIEW,
      AdminPermission.LOANS_DISBURSE,
      AdminPermission.LOAN_SETTINGS_MANAGE,
    ])

    // P3-04: one review screen — consent states, capacity, lock, history, fee, receipts
    const plan = await getLoanPlanById(loanId)
    if (!plan.success || !plan.data) {
      return { success: false, error: plan.error ?? 'Loan not found.', data: null }
    }
    const loan = plan.data
    const [review, member, submissions] = await Promise.all([
      getLoanReviewContext(loanId),
      prisma.user.findUnique({
        where: { id: loan.userId },
        select: {
          id: true,
          name: true,
          email: true,
          photoUrl: true,
          createdAt: true,
          bankAccounts: {
            select: { id: true, bankName: true, accountName: true, accountNumber: true, isPrimary: true, isVerified: true },
          },
        },
      }),
      prisma.paymentSubmission.findMany({
        where: {
          status: 'SUBMITTED',
          targets: {
            some: {
              OR: [
                { targetType: 'LOAN', targetId: loanId },
                ...(loan.fee ? [{ targetType: 'FEE' as const, targetId: loan.fee.id }] : []),
              ],
            },
          },
        },
        select: {
          id: true,
          submissionNumber: true,
          claimedAmount: true,
          paidOn: true,
          bankReference: true,
          purpose: true,
          submittedAt: true,
          receiptFileId: true,
        },
        orderBy: { submittedAt: 'asc' },
      }),
    ])

    const toNum = (d: Prisma.Decimal | null | undefined) => (d ? d.toNumber() : null)
    return {
      success: true,
      data: {
        ...loan,
        member: member
          ? {
              ...member,
              bankAccounts: member.bankAccounts.map((b) => ({
                id: b.id,
                bankName: b.bankName,
                accountName: b.accountName,
                accountNumberMasked: maskAccountNumber(b.accountNumber),
                isPrimary: b.isPrimary,
                isVerified: b.isVerified,
              })),
            }
          : null,
        receiptsToReview: submissions.map((s) => ({
          ...s,
          claimedAmount: Number(s.claimedAmount),
          receiptUrl: s.receiptFileId ? `/api/files/${s.receiptFileId}` : null,
        })),
        review: review
          ? {
              eligibleSavings: review.eligibility.eligibleSavings.toNumber(),
              standaloneLimit: review.eligibility.standaloneLimit.toNumber(),
              existingExposure: review.eligibility.existingExposure.toNumber(),
              guarantorFreeCapacity: toNum(review.eligibility.guarantorFreeCapacity),
              supportNeeded: toNum(review.support?.needed),
              guaranteeReserved: toNum(review.guarantee?.reservedAmount),
              guaranteeConsentedAmount: toNum(review.guarantee?.consentedAmount),
              guarantorName: review.guarantee?.guarantor.name ?? null,
              savingsLocked: review.lien.isLocked,
              overdueInstalments: review.overdueInstalments,
              otherLoans: review.otherLoans.map((l) => ({
                id: l.id,
                status: l.status as string,
                requestedAmount: l.requestedAmount.toNumber(),
                approvedAmount: toNum(l.approvedAmount),
                duration: l.duration,
                outstandingBalance: l.outstandingBalance.toNumber(),
                createdAt: l.createdAt,
              })),
            }
          : null,
      },
    }
  } catch (error) {
    console.error('Error fetching admin loan details:', error)
    return {
      success: false,
      error: 'Failed to fetch loan details',
      data: null,
    }
  }
}

/**
 * Fetches all savings products for admin management
 */
export const getAllSavingsProducts = async () => {
  try {
    await requireAnyPermission([
      AdminPermission.SAVINGS_READ,
      AdminPermission.SAVINGS_MANAGE,
      AdminPermission.SAVINGS_PAYMENTS_REVIEW,
    ])
    const products = await prisma.savingsProduct.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        createdByUser: {
          select: { name: true, email: true },
        },
        termRates: {
          where: { isActive: true },
          orderBy: { durationMonths: 'asc' },
          select: { durationMonths: true, ratePercent: true, version: true },
        },
      },
    })
    return { success: true, data: products }
  } catch (error) {
    console.error('Error fetching admin savings products:', error)
    return {
      success: false,
      error: 'Failed to fetch savings products',
      data: [],
    }
  }
}

/**
 * Fetches all user savings records for admin management
 */
export const getAllUserSavings = async () => {
  try {
    await requireAnyPermission([
      AdminPermission.SAVINGS_READ,
      AdminPermission.SAVINGS_MANAGE,
      AdminPermission.SAVINGS_PAYMENTS_REVIEW,
      AdminPermission.SAVINGS_PAYOUTS_MANAGE,
    ])
    const savings = await prisma.savings.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { name: true, email: true, username: true },
        },
      },
    })

    const serialized = savings.map((s) => ({
      ...s,
      targetAmount: s.targetAmount ? Number(s.targetAmount) : null,
      ratePercentSnapshot: Number(s.ratePercentSnapshot),
      currentBalance: Number(s.currentBalance),
      totalDeposited: Number(s.totalDeposited),
      withdrawalPrincipal: s.withdrawalPrincipal ? Number(s.withdrawalPrincipal) : null,
      withdrawalInterest: s.withdrawalInterest ? Number(s.withdrawalInterest) : null,
    }))

    return { success: true, data: serialized }
  } catch (error) {
    console.error('Error fetching admin user savings:', error)
    return { success: false, error: 'Failed to fetch user savings', data: [] }
  }
}

export const getAllMembers = async () => {
  try {
    await requireAnyPermission([
      AdminPermission.MEMBERS_READ,
      AdminPermission.MEMBERS_CREATE,
      AdminPermission.MEMBERS_APPROVE,
      AdminPermission.LOANS_REVIEW,
      AdminPermission.SAVINGS_MANAGE,
      AdminPermission.EAJO_MANAGE,
    ])
    const members = await prisma.user.findMany({
      where: { role: UserRole.USER },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
      },
    })
    return { success: true, data: members }
  } catch (error) {
    console.error('Error fetching members:', error)
    return { success: false, error: 'Failed to fetch members', data: [] }
  }
}

/**
 * Fetches general operational ledger balances across all 22 accounts (§2.12).
 * Verifies general ledger equality: Total Debits == Total Credits.
 */
export const getOperationalLedgerBalances = async () => {
  try {
    await requireStaffSession()

    const lines = await prisma.journalLine.groupBy({
      by: ['accountType'],
      _sum: {
        debit: true,
        credit: true,
      },
    })

    const accounts = lines.map((l) => {
      const debit = l._sum.debit || new Prisma.Decimal(0)
      const credit = l._sum.credit || new Prisma.Decimal(0)
      return {
        accountType: l.accountType,
        debit,
        credit,
        netBalance: credit.minus(debit),
      }
    })

    const totalDebits = accounts.reduce((acc, a) => acc.plus(a.debit), new Prisma.Decimal(0))
    const totalCredits = accounts.reduce((acc, a) => acc.plus(a.credit), new Prisma.Decimal(0))

    return {
      success: true,
      data: {
        accounts,
        totalDebits,
        totalCredits,
        isBalanced: totalDebits.equals(totalCredits),
      },
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch ledger balances',
    }
  }
}

/**
 * Fetches journal entries with pagination and optional filtering (§2.12).
 */
export const getJournalEntries = async (filter?: {
  memberId?: string
  limit?: number
}) => {
  try {
    await requireStaffSession()

    const entries = await prisma.journalEntry.findMany({
      where: filter?.memberId
        ? {
            lines: {
              some: { memberId: filter.memberId },
            },
          }
        : undefined,
      include: {
        lines: true,
        postedBy: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: { postedAt: 'desc' },
      take: filter?.limit || 50,
    })

    return { success: true, data: entries }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch journal entries',
    }
  }
}

/**
 * Retrieves paginated audit events with rich filtering for admins/owners (PR P2-06).
 */
export const getAdminAuditEventsQuery = async (params: AuditQueryParams = {}) => {
  try {
    await requireAnyPermission([AdminPermission.AUDIT_READ])

    const result = await queryAuditEvents(params)
    return {
      success: true,
      data: result,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch audit events',
    }
  }
}
