'use server'

import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import {
  AdminPermission,
  AllocationStatus,
  AllocationTargetType,
  PaymentStatus,
  SavingsStatus,
} from '@/generated/prisma/enums'
import {
  AuthzError,
  requireAuthenticatedSession,
  requireMemberOrStaffWithPermission,
} from '@/lib/authz/guards'
import { roundMoney } from '@/lib/domain/money'
import { formatDateOnly, lagosToday } from '@/lib/domain/dates'
import { lotInterest } from '@/lib/domain/savings-interest'
import { generateMemberPaymentReference } from '@/lib/domain/payment-reference'
import { maskAccountNumber } from '@/lib/domain/profile-change'
import { getAccruedInterest, pendingPlanExpiresOn } from '@/lib/services/savings.service'
import { getSocietySetting } from '@/lib/services/society-settings.service'
import { getWalletSummary } from '@/lib/services/wallet.service'
import { summarizePaymentBreakdown } from '@/lib/services/allocation.service'

const iso = (d: Date | null | undefined) => (d ? formatDateOnly(d) : null)

/**
 * A member's plans with product names, for the savings hub.
 */
export const getMemberSavingsPlans = async (userId: string) => {
  try {
    await requireMemberOrStaffWithPermission(userId, [
      AdminPermission.SAVINGS_READ,
      AdminPermission.SAVINGS_MANAGE,
      AdminPermission.SAVINGS_PAYMENTS_REVIEW,
      AdminPermission.SAVINGS_PAYOUTS_MANAGE,
    ])
    const plans = await prisma.savings.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { product: { select: { title: true, badge: true } } },
    })
    return {
      success: true,
      data: plans.map((p) => ({
        id: p.id,
        title: p.product?.title ?? 'Savings plan',
        badge: p.product?.badge || null,
        savingsType: p.savingsType,
        frequency: p.frequency,
        durationMonths: p.durationMonths,
        ratePercentSnapshot: Number(p.ratePercentSnapshot),
        targetAmount: p.targetAmount ? Number(p.targetAmount) : null,
        currentBalance: Number(p.currentBalance),
        status: p.status,
        startDate: iso(p.startDate),
        maturityDate: iso(p.maturityDate),
      })),
    }
  } catch (error) {
    if (error instanceof AuthzError) return { success: false, data: [], error: error.message }
    console.error('Error fetching savings plans:', error)
    return { success: false, data: [], error: 'Failed to fetch savings plans' }
  }
}

/**
 * Plan details: schedule, lots, interest, receipts and withdrawal state.
 * Owner member, or staff with savings read/manage/review permission.
 */
export const getSavingsPlanById = async (savingsId: string) => {
  try {
    const savings = await prisma.savings.findUnique({
      where: { id: savingsId },
      include: {
        user: {
          select: {
            name: true,
            username: true,
            membership: { select: { membershipNumber: true } },
          },
        },
        product: { select: { title: true, badge: true, description: true } },
        periods: { orderBy: { periodNumber: 'asc' } },
        lots: {
          orderBy: [{ valueDate: 'asc' }, { createdAt: 'asc' }],
          include: { accruals: { where: { reversedAt: null }, select: { amount: true } } },
        },
        withdrawalDisbursement: {
          include: { bankAccount: { select: { bankName: true, accountNumber: true, accountName: true } } },
        },
      },
    })

    if (!savings) {
      return { success: false, error: 'Savings plan not found' }
    }

    await requireMemberOrStaffWithPermission(savings.userId, [
      AdminPermission.SAVINGS_READ,
      AdminPermission.SAVINGS_MANAGE,
      AdminPermission.SAVINGS_PAYMENTS_REVIEW,
      AdminPermission.SAVINGS_PAYOUTS_MANAGE,
    ])

    const submissions = await prisma.paymentSubmission.findMany({
      where: {
        memberId: savings.userId,
        targets: { some: { targetType: AllocationTargetType.SAVINGS, targetId: savings.id } },
      },
      orderBy: { submittedAt: 'desc' },
      include: {
        targets: { select: { targetPeriodId: true } },
        payment: { select: { valueDate: true, totalConfirmedAmount: true } },
      },
    })

    const accruedInterest = await getAccruedInterest(prisma, savings.id)
    let projectedInterest = new Prisma.Decimal(0)
    if (savings.startDate && savings.maturityDate) {
      for (const lot of savings.lots) {
        if (lot.voidedAt || !lot.interestBearing) continue
        projectedInterest = projectedInterest.plus(
          lotInterest({
            principal: lot.principal,
            ratePercent: savings.ratePercentSnapshot,
            lotValueDate: lot.valueDate,
            planStartDate: savings.startDate,
            maturityDate: savings.maturityDate,
          }),
        )
      }
    }

    const walletSummary = await getWalletSummary(savings.userId, prisma)
    const confirmedPayments = await prisma.payment.findMany({
      where: {
        memberId: savings.userId,
        status: PaymentStatus.CONFIRMED,
        allocations: {
          some: {
            targetType: AllocationTargetType.SAVINGS,
            targetId: savings.id,
            status: AllocationStatus.ACTIVE,
          },
        },
      },
      orderBy: { valueDate: 'desc' },
      include: {
        allocations: {
          where: {
            targetType: AllocationTargetType.SAVINGS,
            targetId: savings.id,
            status: AllocationStatus.ACTIVE,
          },
        },
      },
    })

    const windowDays = await getSocietySetting('savingsFirstDepositWindowDays')
    const membershipNumber = savings.user.membership?.membershipNumber ?? null
    const receivingAccount = await prisma.societyBankAccount.findFirst({
      where: { isActive: true },
      select: { id: true, bankName: true, accountNumber: true, accountName: true },
    })
    const withdrawal = savings.withdrawalDisbursement

    return {
      success: true,
      data: {
        id: savings.id,
        userId: savings.userId,
        memberName: savings.user.name,
        title: savings.product?.title ?? 'Savings plan',
        badge: savings.product?.badge || null,
        savingsType: savings.savingsType,
        frequency: savings.frequency,
        durationMonths: savings.durationMonths,
        ratePercentSnapshot: Number(savings.ratePercentSnapshot),
        rateVersionSnapshot: savings.rateVersionSnapshot,
        targetAmount: savings.targetAmount ? Number(savings.targetAmount) : null,
        currentBalance: Number(savings.currentBalance),
        totalDeposited: Number(savings.totalDeposited),
        accruedInterest: accruedInterest.toNumber(),
        projectedInterest: roundMoney(projectedInterest).toNumber(),
        availableWallet: walletSummary.availableBalance.toNumber(),
        walletSummary: {
          totalBalance: walletSummary.totalBalance.toNumber(),
          heldBalance: walletSummary.heldBalance.toNumber(),
          availableBalance: walletSummary.availableBalance.toNumber(),
        },
        status: savings.status,
        startDate: iso(savings.startDate),
        maturityDate: iso(savings.maturityDate),
        createdAt: savings.createdAt.toISOString(),
        cancellationReason: savings.cancellationReason,
        firstDepositDeadline:
          savings.status === SavingsStatus.PENDING ? pendingPlanExpiresOn(savings.createdAt, windowDays) : null,
        today: lagosToday(),
        paymentReference: membershipNumber ? generateMemberPaymentReference(membershipNumber, 'SAV') : null,
        receivingAccount,
        withdrawal: withdrawal
          ? {
              kind: savings.withdrawalKind,
              principal: Number(savings.withdrawalPrincipal ?? 0),
              interest: Number(savings.withdrawalInterest ?? 0),
              amount: Number(withdrawal.amount),
              status: withdrawal.status,
              disbursementNumber: withdrawal.disbursementNumber,
              approvedById: withdrawal.approvedById,
              requestedAt: savings.withdrawalRequestedAt?.toISOString() ?? null,
              bankName: withdrawal.bankAccount.bankName,
              accountNumberMasked: maskAccountNumber(withdrawal.bankAccount.accountNumber),
            }
          : null,
        withdrawalKind: savings.withdrawalKind,
        withdrawnAt: savings.withdrawnAt?.toISOString() ?? null,
        periods: savings.periods.map((p) => ({
          id: p.id,
          periodNumber: p.periodNumber,
          dueDate: iso(p.dueDate) as string,
          amountDue: Number(p.amountDue),
          amountPaid: Number(p.amountPaid),
          outstanding: Math.max(0, roundMoney(p.amountDue.minus(p.amountPaid)).toNumber()),
          status: p.status,
          interestForfeited: p.interestForfeited,
        })),
        lots: savings.lots.map((l) => ({
          id: l.id,
          principal: Number(l.principal),
          valueDate: iso(l.valueDate) as string,
          savingsPeriodId: l.savingsPeriodId,
          interestBearing: l.interestBearing,
          forfeitReason: l.forfeitReason,
          voided: Boolean(l.voidedAt),
          accrued: l.accruals.reduce((s, a) => s + Number(a.amount), 0),
        })),
        submissions: submissions.map((s) => ({
          id: s.id,
          submissionNumber: s.submissionNumber,
          purpose: s.purpose,
          claimedAmount: Number(s.claimedAmount),
          paidOn: iso(s.paidOn) as string,
          status: s.status,
          rejectionReason: s.rejectionReason,
          submittedAt: s.submittedAt.toISOString(),
          valueDate: iso(s.payment?.valueDate ?? s.valueDate),
          confirmedAmount: s.payment ? Number(s.payment.totalConfirmedAmount) : null,
          bankReference: s.bankReference,
          receiptFileId: s.receiptFileId,
          periodIds: s.targets.map((t) => t.targetPeriodId).filter(Boolean) as string[],
        })),
        payments: confirmedPayments.map((p) => ({
          id: p.id,
          paymentNumber: p.paymentNumber,
          source: p.source,
          valueDate: iso(p.valueDate) as string,
          totalConfirmedAmount: Number(p.totalConfirmedAmount),
          breakdown: summarizePaymentBreakdown(p.allocations),
        })),
      },
    }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error fetching savings plan:', error)
    return { success: false, error: 'Failed to fetch savings plan' }
  }
}

export type SavingsPlanDetails = NonNullable<
  Awaited<ReturnType<typeof getSavingsPlanById>>['data']
>

function serializeProduct(product: {
  id: string
  type: string
  title: string
  description: string
  rates: string
  badge: string | null
  icon: string
  isActive: boolean
  termRates: { durationMonths: number; ratePercent: Prisma.Decimal; version: number }[]
}) {
  return {
    id: product.id,
    type: product.type,
    title: product.title,
    description: product.description,
    rates: product.rates,
    badge: product.badge || null,
    icon: product.icon,
    isActive: product.isActive,
    termRates: product.termRates.map((r) => ({
      durationMonths: r.durationMonths,
      ratePercent: Number(r.ratePercent),
      version: r.version,
    })),
  }
}

const activeTermRates = {
  where: { isActive: true },
  orderBy: { durationMonths: 'asc' as const },
  select: { durationMonths: true, ratePercent: true, version: true },
}

/** Active savings plans with their enabled terms. */
export const getSavingsProducts = async () => {
  try {
    await requireAuthenticatedSession()
    const products = await prisma.savingsProduct.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      include: { termRates: activeTermRates },
    })
    return { success: true, data: products.map(serializeProduct) }
  } catch (error: unknown) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Failed to fetch savings products:', error)
    return { success: false, error: 'Failed to fetch products' }
  }
}

export const getSavingsProductById = async (id: string) => {
  try {
    await requireAuthenticatedSession()
    const product = await prisma.savingsProduct.findUnique({
      where: { id },
      include: { termRates: activeTermRates },
    })
    return { success: true, data: product ? serializeProduct(product) : null }
  } catch (error: unknown) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Failed to fetch savings product:', error)
    return { success: false, error: 'Failed to fetch product' }
  }
}

export type SavingsProductView = ReturnType<typeof serializeProduct>
