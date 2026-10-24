import { addMonthsClamped } from '@/lib/domain/dates'
import { generateLoanSchedule } from '@/lib/domain/loan-schedule'

interface Installment {
  installmentNumber: number
  dueDate: Date
  principalAmount: number
  interestAmount: number
  totalAmount: number
  status: 'PAID' | 'PENDING' | 'OVERDUE'
}

// Helper to serialize Decimal fields to numbers to prevent RSC boundary serialization errors
export const serializeLoan = (loan: any) => {
  if (!loan) return null
  return {
    ...loan,
    requestedAmount: Number(loan.requestedAmount),
    approvedAmount: loan.approvedAmount ? Number(loan.approvedAmount) : null,
    interestRate: Number(loan.interestRate),
    applicationFee: Number(loan.applicationFee),
    outstandingBalance: Number(loan.outstandingBalance),
    totalRepaid: Number(loan.totalRepaid),
    defaultPenalty: Number(loan.defaultPenalty),
  }
}

export const serializeTransaction = (tx: any) => {
  if (!tx) return null
  return {
    ...tx,
    amount: Number(tx.amount),
  }
}

/**
 * Calculates a standard loan amortization schedule based on simple cooperative interest
 */
export const calculateRepaymentSchedule = (
  approvedAmount: number,
  interestRatePct: number,
  durationMonths: number,
  startDate: Date | null,
  totalRepaid: number,
  gracePeriodDays: number = 7
): Installment[] => {
  const schedule: Installment[] = []
  if (durationMonths <= 0 || approvedAmount <= 0) return schedule

  const baseDate = startDate ? new Date(startDate) : new Date()

  const gen = generateLoanSchedule({
    principal: approvedAmount,
    termMonths: durationMonths,
    monthlyInterestRatePercent: interestRatePct,
    anchorDate: baseDate,
  })

  let runningRepaid = totalRepaid

  for (const item of gen.instalments) {
    const installmentTotal = Number(item.totalDue)
    let status: 'PAID' | 'PENDING' | 'OVERDUE' = 'PENDING'
    if (runningRepaid >= installmentTotal) {
      status = 'PAID'
      runningRepaid -= installmentTotal
    } else {
      const graceLimit = new Date(item.dueDate)
      graceLimit.setDate(item.dueDate.getDate() + gracePeriodDays)
      if (new Date() > graceLimit) {
        status = 'OVERDUE'
      }
    }

    schedule.push({
      installmentNumber: item.instalmentNumber,
      dueDate: item.dueDate,
      principalAmount: Number(item.principalDue),
      interestAmount: Number(item.interestDue),
      totalAmount: installmentTotal,
      status,
    })
  }

  return schedule
}

/**
 * Calculates a dynamic daily penalty fee for an overdue loan.
 * Applies a small daily percentage (e.g., 0.5%) on the total approved amount 
 * for every day past the due date after the 3-day grace period.
 */
export const calculateLoanPenaltyAmount = (
  approvedAmount: number,
  repaymentEndDate: Date | null,
  currentDate: Date = new Date(),
  dailyPenaltyPct: number = 0.5,
  gracePeriodDays: number = 3
): number => {
  if (!repaymentEndDate || approvedAmount <= 0) return 0

  const graceLimit = new Date(repaymentEndDate)
  graceLimit.setDate(graceLimit.getDate() + gracePeriodDays)

  if (currentDate <= graceLimit) return 0

  const diffTime = Math.abs(currentDate.getTime() - graceLimit.getTime())
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

  // Calculate penalty: daily % of the total approved loan amount
  const penalty = (approvedAmount * (dailyPenaltyPct / 100)) * diffDays
  return penalty
}
