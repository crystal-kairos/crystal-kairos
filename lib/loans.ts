import { addMonthsClamped } from '@/lib/domain/dates'
import { generateLoanSchedule } from '@/lib/domain/loan-schedule'
import { PenaltyCapType } from '@/generated/prisma/enums'
import {
  calculateDailyPenaltyAccrual,
  deriveUnaccruedPenaltyDates,
} from '@/lib/domain/penalty-calculation'
import { roundMoney } from '@/lib/domain/money'

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
 * Calculates late penalty fee for an overdue loan obligation based on snapshotted rate parameters (§2.2, D-05).
 * Due date is Day 0. Grace period is Days 1..7. First penalty day is Day +8.
 * Daily penalty = original principal * dailyPercent / 100, subject to mandatory cap.
 */
export const calculateLoanPenaltyAmount = (
  approvedAmount: number,
  repaymentEndDate: Date | null,
  currentDate: Date = new Date(),
  dailyPenaltyPct: number = 0.5,
  gracePeriodDays: number = 7,
  penaltyCapType: PenaltyCapType = PenaltyCapType.PERCENT_OF_PRINCIPAL,
  penaltyCapValue: number = 10,
  penaltiesAssessedNet: number = 0
): number => {
  if (!repaymentEndDate || approvedAmount <= 0) return 0

  const unaccruedDates = deriveUnaccruedPenaltyDates({
    dueDate: repaymentEndDate,
    evaluationDate: currentDate,
  })

  if (unaccruedDates.length === 0) return 0

  let totalAccrued = penaltiesAssessedNet
  let newPenaltyAccrued = 0

  for (const _d of unaccruedDates) {
    const res = calculateDailyPenaltyAccrual({
      base: approvedAmount,
      latePenaltyDailyPercent: dailyPenaltyPct,
      penaltyCapType,
      penaltyCapValue,
      penaltiesAssessedNet: totalAccrued,
    })

    const dayAmount = res.accrualAmount.toNumber()
    newPenaltyAccrued += dayAmount
    totalAccrued += dayAmount
  }

  return Number(roundMoney(newPenaltyAccrued).toNumber())
}
