import {
  AllocationTargetType,
  PaymentComponentType,
} from '@/generated/prisma/client'

export type WalletPriorityMode = 'AUTO' | 'MEMBER'

export interface AllocationPeriodItem {
  periodId: string
  targetType: 'LOAN' | 'SAVINGS' | 'EAJO' | 'FEE'
  targetId: string
  periodNumber: number
  dueDate: Date
  penaltyDue: number
  interestDue: number
  principalDue: number // For savings: amountDue; for eajo: contributionDue; for loan: principalDue; for fee: feeDue
}

export interface CalculatedAllocation {
  targetType: AllocationTargetType
  targetId: string
  periodId: string | null
  componentType: PaymentComponentType
  amount: number
}

export interface AllocationResult {
  allocations: CalculatedAllocation[]
  totalAllocated: number
  excessToWallet: number
  periodSummaries: {
    periodId: string
    penaltyPaid: number
    interestPaid: number
    principalPaid: number
    totalPaid: number
    isFullySettled: boolean
  }[]
}

export interface PaymentComponentBreakdown {
  penalty: number
  interest: number
  principal: number
  contribution: number
  fee: number
  walletTopup: number
  total: number
}

const PRODUCT_PRIORITY_RANK: Record<string, number> = {
  LOAN: 1,
  EAJO: 2,
  SAVINGS: 3,
  FEE: 4,
}

/**
 * Sorts obligations according to the approved priority rules (D-12, §2.10, §2.11, Appendix C6):
 * - AUTO mode: filters to LOAN and EAJO only (SAVINGS is never auto-applied),
 *   then orders LOAN -> EAJO, oldest dueDate first, then periodNumber.
 * - MEMBER mode: orders LOAN -> EAJO -> SAVINGS -> FEE, oldest dueDate first, then periodNumber.
 */
export function sortObligationsByPriority(
  periods: AllocationPeriodItem[],
  mode: WalletPriorityMode = 'MEMBER',
): AllocationPeriodItem[] {
  const filtered =
    mode === 'AUTO'
      ? periods.filter(
          (p) => p.targetType === 'LOAN' || p.targetType === 'EAJO',
        )
      : [...periods]

  return filtered.sort((a, b) => {
    const rankA = PRODUCT_PRIORITY_RANK[a.targetType] ?? 99
    const rankB = PRODUCT_PRIORITY_RANK[b.targetType] ?? 99
    if (rankA !== rankB) return rankA - rankB

    const timeA = new Date(a.dueDate).getTime()
    const timeB = new Date(b.dueDate).getTime()
    if (timeA !== timeB) return timeA - timeB

    return a.periodNumber - b.periodNumber
  })
}

/**
 * Summarizes an array of allocations into plain-language component totals
 * (penalty, interest, principal, contribution, fee, walletTopup).
 */
export function summarizePaymentBreakdown(
  allocations: Array<{
    componentType: PaymentComponentType | string
    amount: number | string | { toNumber(): number }
  }>,
): PaymentComponentBreakdown {
  let penalty = 0
  let interest = 0
  let principal = 0
  let contribution = 0
  let fee = 0
  let walletTopup = 0

  for (const a of allocations) {
    const val =
      typeof a.amount === 'number'
        ? a.amount
        : typeof a.amount === 'string'
          ? Number(a.amount)
          : a.amount.toNumber()

    if (a.componentType === PaymentComponentType.PENALTY) {
      penalty = Math.round((penalty + val) * 100) / 100
    } else if (a.componentType === PaymentComponentType.INTEREST) {
      interest = Math.round((interest + val) * 100) / 100
    } else if (a.componentType === PaymentComponentType.PRINCIPAL) {
      principal = Math.round((principal + val) * 100) / 100
    } else if (a.componentType === PaymentComponentType.CONTRIBUTION) {
      contribution = Math.round((contribution + val) * 100) / 100
    } else if (a.componentType === PaymentComponentType.FEE) {
      fee = Math.round((fee + val) * 100) / 100
    } else if (a.componentType === PaymentComponentType.WALLET_TOPUP) {
      walletTopup = Math.round((walletTopup + val) * 100) / 100
    }
  }

  const total =
    Math.round(
      (penalty + interest + principal + contribution + fee + walletTopup) * 100,
    ) / 100

  return {
    penalty,
    interest,
    principal,
    contribution,
    fee,
    walletTopup,
    total,
  }
}

/**
 * Calculates allocation order per §2.10 & §2.11:
 * 1. If preserveCrossProductPriority is true, sorts by LOAN -> EAJO -> SAVINGS (or LOAN -> EAJO in AUTO mode),
 *    then oldest dueDate first, then periodNumber. Otherwise sorts by oldest dueDate first, then periodNumber.
 * 2. Within a period: PENALTY -> INTEREST -> PRINCIPAL/CONTRIBUTION/FEE.
 * 3. Any leftover confirmed amount goes to WALLET_TOPUP (or savings plan principal) when creditExcessToWallet !== false.
 */
export function calculatePaymentAllocation(params: {
  amount: number
  memberId: string
  periods: AllocationPeriodItem[]
  excessToSavingsPlanId?: string
  preserveCrossProductPriority?: boolean
  mode?: WalletPriorityMode
  creditExcessToWallet?: boolean
}): AllocationResult {
  const {
    amount,
    memberId,
    periods,
    excessToSavingsPlanId,
    preserveCrossProductPriority = false,
    mode = 'MEMBER',
    creditExcessToWallet = true,
  } = params

  let remaining = Math.round(amount * 100) / 100
  const allocations: CalculatedAllocation[] = []
  const periodSummaries: AllocationResult['periodSummaries'] = []

  // 1. Sort periods
  const sortedPeriods = preserveCrossProductPriority
    ? sortObligationsByPriority(periods, mode)
    : [...periods].sort((a, b) => {
        const timeA = new Date(a.dueDate).getTime()
        const timeB = new Date(b.dueDate).getTime()
        if (timeA !== timeB) return timeA - timeB
        return a.periodNumber - b.periodNumber
      })

  for (const period of sortedPeriods) {
    if (remaining <= 0) break

    let periodPenaltyPaid = 0
    let periodInterestPaid = 0
    let periodPrincipalPaid = 0

    // Component 1: PENALTY
    if (period.penaltyDue > 0 && remaining > 0) {
      const pay = Math.min(remaining, period.penaltyDue)
      const roundedPay = Math.round(pay * 100) / 100
      if (roundedPay > 0) {
        allocations.push({
          targetType: period.targetType as AllocationTargetType,
          targetId: period.targetId,
          periodId: period.periodId,
          componentType: PaymentComponentType.PENALTY,
          amount: roundedPay,
        })
        remaining = Math.round((remaining - roundedPay) * 100) / 100
        periodPenaltyPaid = roundedPay
      }
    }

    // Component 2: INTEREST (loans)
    if (period.interestDue > 0 && remaining > 0) {
      const pay = Math.min(remaining, period.interestDue)
      const roundedPay = Math.round(pay * 100) / 100
      if (roundedPay > 0) {
        allocations.push({
          targetType: period.targetType as AllocationTargetType,
          targetId: period.targetId,
          periodId: period.periodId,
          componentType: PaymentComponentType.INTEREST,
          amount: roundedPay,
        })
        remaining = Math.round((remaining - roundedPay) * 100) / 100
        periodInterestPaid = roundedPay
      }
    }

    // Component 3: PRINCIPAL / CONTRIBUTION / FEE
    if (period.principalDue > 0 && remaining > 0) {
      const pay = Math.min(remaining, period.principalDue)
      const roundedPay = Math.round(pay * 100) / 100
      if (roundedPay > 0) {
        const componentType =
          period.targetType === 'EAJO'
            ? PaymentComponentType.CONTRIBUTION
            : period.targetType === 'FEE'
              ? PaymentComponentType.FEE
              : PaymentComponentType.PRINCIPAL

        allocations.push({
          targetType: period.targetType as AllocationTargetType,
          targetId: period.targetId,
          periodId: period.periodId === period.targetId && period.targetType === 'FEE' ? null : period.periodId,
          componentType,
          amount: roundedPay,
        })
        remaining = Math.round((remaining - roundedPay) * 100) / 100
        periodPrincipalPaid = roundedPay
      }
    }

    const totalPaidForPeriod =
      periodPenaltyPaid + periodInterestPaid + periodPrincipalPaid
    const isFullySettled =
      periodPenaltyPaid >= period.penaltyDue &&
      periodInterestPaid >= period.interestDue &&
      periodPrincipalPaid >= period.principalDue

    periodSummaries.push({
      periodId: period.periodId,
      penaltyPaid: periodPenaltyPaid,
      interestPaid: periodInterestPaid,
      principalPaid: periodPrincipalPaid,
      totalPaid: totalPaidForPeriod,
      isFullySettled,
    })
  }

  // 3. Excess handling
  let excessToWallet = 0
  if (remaining > 0) {
    const excess = Math.round(remaining * 100) / 100
    if (excessToSavingsPlanId) {
      allocations.push({
        targetType: AllocationTargetType.SAVINGS,
        targetId: excessToSavingsPlanId,
        periodId: null,
        componentType: PaymentComponentType.PRINCIPAL,
        amount: excess,
      })
      remaining = 0
    } else if (creditExcessToWallet) {
      excessToWallet = excess
      allocations.push({
        targetType: AllocationTargetType.WALLET,
        targetId: memberId,
        periodId: null,
        componentType: PaymentComponentType.WALLET_TOPUP,
        amount: excess,
      })
      remaining = 0
    }
  }

  const totalAllocated = Math.round((amount - remaining) * 100) / 100

  return {
    allocations,
    totalAllocated,
    excessToWallet,
    periodSummaries,
  }
}
