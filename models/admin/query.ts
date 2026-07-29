'use server'

import { prisma } from '@/lib/prisma'
import { getSessionHelper } from '../members/actions'
import {
  MembershipStatus,
  SavingsStatus,
  LoanStatus,
  EAjoStatus,
  TransactionStatus,
  TransactionType,
  TransactionCategory,
} from '@/generated/prisma/enums'

/**
 * Fetches comprehensive aggregate statistics and activity feeds for the Admin Dashboard
 */
export const getAdminDashboardStats = async () => {
  try {
    const session = await getSessionHelper()
    if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized admin access.' }
    }

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
          in: [TransactionStatus.CONFIRMED, TransactionStatus.DISBURSED, TransactionStatus.REJECTED],
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
      if (tx.category === TransactionCategory.SAVINGS_DEPOSIT || tx.category === TransactionCategory.SAVINGS_WITHDRAWAL) {
        targetLabel = `Savings: ${tx.savingsId ? tx.savingsId.substring(0, 8).toUpperCase() : 'Plan'}`
      } else if (tx.category === TransactionCategory.LOAN_DISBURSEMENT || tx.category === TransactionCategory.LOAN_REPAYMENT) {
        targetLabel = `Loan: ${tx.loanId ? tx.loanId.substring(0, 8).toUpperCase() : 'Record'}`
      } else if (tx.category === TransactionCategory.AJO_CONTRIBUTION || tx.category === TransactionCategory.AJO_PAYOUT) {
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
    console.error('Error fetching admin dashboard stats:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch admin stats.',
    }
  }
}

/**
 * Fetches all administrators and owners for the staff directory list
 */
export const getAdminStaffMembers = async () => {
  try {
    const session = await getSessionHelper()
    if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized admin access.' }
    }

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
      },
      orderBy: {
        createdAt: 'asc',
      },
    })

    return { success: true, data: staff }
  } catch (error) {
    console.error('Error fetching admin staff:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch admin staff.',
    }
  }
}

/**
 * Fetches all pending deposit receipts for the Verification Queue
 */
export const getPendingReceipts = async () => {
  try {
    const session = await getSessionHelper()
    if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized admin access.' }
    }

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
      error: error instanceof Error ? error.message : 'Failed to fetch pending receipts.',
    }
  }
}

/**
 * Fetches all pending money-out disbursements for the Disbursements Queue
 */
export const getPendingDisbursements = async () => {
  try {
    const session = await getSessionHelper()
    if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized admin access.' }
    }

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
      error: error instanceof Error ? error.message : 'Failed to fetch pending disbursements.',
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
    const session = await getSessionHelper()
    if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized admin access.' }
    }

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
      error: error instanceof Error ? error.message : 'Failed to fetch eAjo groups.',
    }
  }
}

/**
 * Fetches a single eAjo group with full member details
 */
export const getEAjoGroupById = async (groupId: string) => {
  try {
    const session = await getSessionHelper()
    if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized admin access.' }
    }

    const group = await prisma.eAjoGroup.findUnique({
      where: { id: groupId },
      include: {
        createdByUser: { select: { name: true, email: true } },
        members: {
          orderBy: { payoutPosition: 'asc' },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                userInfo: { select: { phoneNumber: true } },
                membership: { select: { membershipNumber: true } },
              },
            },
          },
        },
      },
    })

    if (!group) return { success: false, error: 'Group not found.' }

    const serialized = {
      ...group,
      contributionAmount: Number(group.contributionAmount),
      members: group.members.map((m) => ({
        ...m,
        feePercentage: Number(m.feePercentage),
        feeAmount: Number(m.feeAmount),
        totalExpectedPayout: Number(m.totalExpectedPayout),
        netPayoutAmount: Number(m.netPayoutAmount),
        currentBalance: Number(m.currentBalance),
        totalContributed: Number(m.totalContributed),
      })),
    }

    return { success: true, data: serialized }
  } catch (error) {
    console.error('Error fetching eAjo group:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch eAjo group.',
    }
  }
}

/**
 * Fetches all pending member applications across all groups
 */
export const getPendingEAjoApplications = async () => {
  try {
    const session = await getSessionHelper()
    if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized admin access.' }
    }

    const applications = await prisma.eAjoMember.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { id: true, name: true, email: true } },
        group: { select: { id: true, title: true, contributionAmount: true, duration: true } },
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
      group: { ...a.group, contributionAmount: Number(a.group.contributionAmount) },
    }))

    return { success: true, data: serialized }
  } catch (error) {
    console.error('Error fetching pending eAjo applications:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fetch pending applications.',
    }
  }
}

// ============================================
// ADMIN LOANS QUERIES
// ============================================

export const getAllLoansQuery = async (filters?: { status?: LoanStatus }) => {
  try {
    const session = await getSessionHelper()
    if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized admin access.' }
    }

    const loans = await prisma.loan.findMany({
      where: filters?.status ? { status: filters.status } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true, photoUrl: true } }
      }
    })

    const serialized = loans.map(loan => ({
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
    return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch loans.' }
  }
}

export const getLoanByIdQuery = async (loanId: string) => {
  try {
    const session = await getSessionHelper()
    if (!session?.user || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
      return { success: false, error: 'Unauthorized admin access.' }
    }

    const loan = await prisma.loan.findUnique({
      where: { id: loanId },
      include: {
        user: {
          include: {
            userInfo: true,
            bankAccounts: true,
            membership: true,
          }
        },
        transactions: {
          orderBy: { createdAt: 'desc' }
        }
      }
    })

    if (!loan) return { success: false, error: 'Loan not found.' }

    const serialized = {
      ...loan,
      requestedAmount: Number(loan.requestedAmount),
      approvedAmount: loan.approvedAmount ? Number(loan.approvedAmount) : null,
      interestRate: Number(loan.interestRate),
      applicationFee: Number(loan.applicationFee),
      outstandingBalance: Number(loan.outstandingBalance),
      totalRepaid: Number(loan.totalRepaid),
      defaultPenalty: Number(loan.defaultPenalty),
      transactions: loan.transactions.map(tx => ({
        ...tx,
        amount: Number(tx.amount)
      }))
    }

    return { success: true, data: serialized }
  } catch (error) {
    console.error('Error fetching admin loan details:', error)
    return { success: false, error: 'Failed to fetch loan details', data: null }
  }
}

/**
 * Fetches all savings products for admin management
 */
export const getAllSavingsProducts = async () => {
  try {
    const products = await prisma.savingsProduct.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        createdByUser: {
          select: { name: true, email: true },
        },
      },
    })
    return { success: true, data: products }
  } catch (error) {
    console.error('Error fetching admin savings products:', error)
    return { success: false, error: 'Failed to fetch savings products', data: [] }
  }
}

/**
 * Fetches all user savings records for admin management
 */
export const getAllUserSavings = async () => {
  try {
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
      interestRate: Number(s.interestRate),
      currentBalance: Number(s.currentBalance),
      accruedInterest: Number(s.accruedInterest),
      totalDeposited: Number(s.totalDeposited),
      expectedMaturityAmount: s.expectedMaturityAmount ? Number(s.expectedMaturityAmount) : null,
    }))

    return { success: true, data: serialized }
  } catch (error) {
    console.error('Error fetching admin user savings:', error)
    return { success: false, error: 'Failed to fetch user savings', data: [] }
  }
}

export const getAllMembers = async () => {
  try {
    const members = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
      }
    })
    return { success: true, data: members }
  } catch (error) {
    console.error('Error fetching members:', error)
    return { success: false, error: 'Failed to fetch members', data: [] }
  }
}
