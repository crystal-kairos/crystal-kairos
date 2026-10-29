import {
  AllocationTargetType,
  PaymentComponentType,
} from '@/generated/prisma/client'

export interface AllocationPeriodItem {
  periodId: string
  targetType: 'LOAN' | 'SAVINGS' | 'EAJO'
  targetId: string
  periodNumber: number
  dueDate: Date
  penaltyDue: number
  interestDue: number
  principalDue: number // For savings: amountDue; for eajo: contributionDue; for loan: principalDue
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

/**
 * Calculates allocation order per §2.10:
 * 1. Oldest dueDate first.
 * 2. Within a period: PENALTY -> INTEREST -> PRINCIPAL/CONTRIBUTION.
 * 3. Any leftover confirmed amount goes to WALLET_TOPUP (or savings plan principal), never silently to unselected periods.
 */
export function calculatePaymentAllocation(params: {
  amount: number
  memberId: string
  periods: AllocationPeriodItem[]
  excessToSavingsPlanId?: string
}): AllocationResult {
  const { amount, memberId, periods, excessToSavingsPlanId } = params

  let remaining = Math.round(amount * 100) / 100
  const allocations: CalculatedAllocation[] = []
  const periodSummaries: AllocationResult['periodSummaries'] = []

  // 1. Sort periods oldest dueDate first, then periodNumber
  const sortedPeriods = [...periods].sort((a, b) => {
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

    // Component 3: PRINCIPAL / CONTRIBUTION
    if (period.principalDue > 0 && remaining > 0) {
      const pay = Math.min(remaining, period.principalDue)
      const roundedPay = Math.round(pay * 100) / 100
      if (roundedPay > 0) {
        const componentType =
          period.targetType === 'EAJO'
            ? PaymentComponentType.CONTRIBUTION
            : PaymentComponentType.PRINCIPAL

        allocations.push({
          targetType: period.targetType as AllocationTargetType,
          targetId: period.targetId,
          periodId: period.periodId,
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
    } else {
      excessToWallet = excess
      allocations.push({
        targetType: AllocationTargetType.WALLET,
        targetId: memberId,
        periodId: null,
        componentType: PaymentComponentType.WALLET_TOPUP,
        amount: excess,
      })
    }
    remaining = 0
  }

  const totalAllocated = Math.round((amount - remaining) * 100) / 100

  return {
    allocations,
    totalAllocated,
    excessToWallet,
    periodSummaries,
  }
}
