import { Prisma } from '@/generated/prisma/client'
import { roundMoney, toDecimal } from './money'
import { addMonthsClamped, formatDateOnly, parseDateOnly } from './dates'

export const INTEREST_CALCULATION_METHOD =
  'FLAT_MONTHLY_ON_ORIGINAL_PRINCIPAL' as const

export interface GenerateLoanScheduleInput {
  principal: Prisma.Decimal | string | number
  termMonths: number
  monthlyInterestRatePercent: Prisma.Decimal | string | number
  anchorDate: Date | string // Disbursement value date
}

export interface LoanInstalmentScheduleItem {
  instalmentNumber: number
  dueDate: Date
  dueDateStr: string
  principalDue: Prisma.Decimal
  interestDue: Prisma.Decimal
  totalDue: Prisma.Decimal
}

export interface LoanScheduleResult {
  principal: Prisma.Decimal
  termMonths: number
  monthlyInterestRatePercent: Prisma.Decimal
  monthlyInterest: Prisma.Decimal
  totalInterest: Prisma.Decimal
  totalScheduledRepayment: Prisma.Decimal
  interestCalculationMethod: typeof INTEREST_CALCULATION_METHOD
  instalments: LoanInstalmentScheduleItem[]
}

/**
 * Calculates a standard Nigerian cooperative flat-monthly loan schedule (§2.9, D-04, A-01).
 *
 * monthlyInterest        = P * r / 100
 * totalInterest          = monthlyInterest * n
 * totalScheduledRepayment = P + totalInterest
 * instalment k           = principalPortion(k) + interestPortion(k)
 * principalPortion(k)    = round(P / n, 2),  last instalment takes rounding remainder
 * interestPortion(k)     = round(monthlyInterest, 2),  last instalment takes any remainder
 *
 * Due date for instalment k is addMonthsClamped(anchorDate, k).
 */
export function generateLoanSchedule(
  input: GenerateLoanScheduleInput,
): LoanScheduleResult {
  const P = toDecimal(input.principal)
  const n = input.termMonths
  const r = toDecimal(input.monthlyInterestRatePercent)

  if (n <= 0) {
    throw new Error('Loan term months must be greater than zero.')
  }

  if (P.lte(0)) {
    throw new Error('Loan principal must be greater than zero.')
  }

  // Monthly interest = P * r / 100 rounded to 2 decimal places
  const monthlyInterest = roundMoney(P.times(r).dividedBy(100))
  const totalInterest = roundMoney(monthlyInterest.times(n))
  const totalScheduledRepayment = P.plus(totalInterest)

  // Standard regular instalment principal portion
  const standardPrincipal = roundMoney(P.dividedBy(n))

  const instalments: LoanInstalmentScheduleItem[] = []
  let accumulatedPrincipal = new Prisma.Decimal(0)
  let accumulatedInterest = new Prisma.Decimal(0)

  for (let k = 1; k <= n; k++) {
    const dueDate = addMonthsClamped(input.anchorDate, k)
    const dueDateStr = formatDateOnly(dueDate)

    let principalDue: Prisma.Decimal
    let interestDue: Prisma.Decimal

    if (k < n) {
      principalDue = standardPrincipal
      interestDue = monthlyInterest
      accumulatedPrincipal = accumulatedPrincipal.plus(principalDue)
      accumulatedInterest = accumulatedInterest.plus(interestDue)
    } else {
      // Last instalment absorbs the rounding remainders
      principalDue = P.minus(accumulatedPrincipal)
      interestDue = totalInterest.minus(accumulatedInterest)
    }

    const totalDue = principalDue.plus(interestDue)

    instalments.push({
      instalmentNumber: k,
      dueDate,
      dueDateStr,
      principalDue,
      interestDue,
      totalDue,
    })
  }

  return {
    principal: P,
    termMonths: n,
    monthlyInterestRatePercent: r,
    monthlyInterest,
    totalInterest,
    totalScheduledRepayment,
    interestCalculationMethod: INTEREST_CALCULATION_METHOD,
    instalments,
  }
}
