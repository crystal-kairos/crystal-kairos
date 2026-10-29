import { Prisma } from '@/generated/prisma/client'
import { PenaltyCapType } from '@/generated/prisma/enums'
import {
  parseDateOnly,
  toLagosDateString,
  addDays,
  diffDays,
  isBefore,
} from '@/lib/domain/dates'
import { roundMoney } from '@/lib/domain/money'

const ZERO = new Prisma.Decimal(0)

export interface PenaltyTimeline {
  dueDate: string
  graceWindowEnd: string // Day +7
  firstPenaltyDate: string // Day +8
  recoveryEligibilityDate: string // Day +15
}

/**
 * Derives calendar milestone dates for an overdue obligation (§2.6, Appendix C2).
 * Due date is Day 0.
 * Days +1 to +7 are grace.
 * Day +8 is first penalty day.
 * Day +15 is recovery case eligibility.
 */
export function getPenaltyTimeline(dueDateInput: Date | string): PenaltyTimeline {
  const due = parseDateOnly(dueDateInput)
  const graceEnd = addDays(due, 7)
  const firstPenalty = addDays(due, 8)
  const recoveryEligible = addDays(due, 15)

  return {
    dueDate: toLagosDateString(due),
    graceWindowEnd: toLagosDateString(graceEnd),
    firstPenaltyDate: toLagosDateString(firstPenalty),
    recoveryEligibilityDate: toLagosDateString(recoveryEligible),
  }
}

/**
 * Calculates the total monetary cap for penalties based on cap type and cap value (§2.2, §2.3).
 */
export function calculatePenaltyCap(
  base: Prisma.Decimal | number | string,
  capType: PenaltyCapType,
  capValueInput: Prisma.Decimal | number | string
): Prisma.Decimal {
  const baseDec = new Prisma.Decimal(base)
  const capVal = new Prisma.Decimal(capValueInput)

  if (capType === PenaltyCapType.PERCENT_OF_PRINCIPAL) {
    return roundMoney(baseDec.mul(capVal).div(100))
  }
  return roundMoney(capVal)
}

export interface DailyAccrualResult {
  dailyPenalty: Prisma.Decimal
  cap: Prisma.Decimal
  accrualAmount: Prisma.Decimal
  remainingCap: Prisma.Decimal
}

/**
 * Computes single-day penalty accrual subject to cumulative net cap (§2.2, §2.3).
 *
 * dailyPenalty = base * dailyPercent / 100
 * accrual(d)   = min(dailyPenalty, max(0, cap - penaltiesAssessedNet))
 */
export function calculateDailyPenaltyAccrual(params: {
  base: Prisma.Decimal | number | string
  latePenaltyDailyPercent: Prisma.Decimal | number | string
  penaltyCapType: PenaltyCapType
  penaltyCapValue: Prisma.Decimal | number | string
  penaltiesAssessedNet: Prisma.Decimal | number | string
}): DailyAccrualResult {
  const baseDec = new Prisma.Decimal(params.base)
  const dailyPct = new Prisma.Decimal(params.latePenaltyDailyPercent)
  const assessedNet = new Prisma.Decimal(params.penaltiesAssessedNet)

  const dailyPenalty = roundMoney(baseDec.mul(dailyPct).div(100))
  const cap = calculatePenaltyCap(baseDec, params.penaltyCapType, params.penaltyCapValue)

  const remainingBefore = cap.minus(assessedNet)
  const availableRoom = remainingBefore.gt(0) ? remainingBefore : ZERO

  const accrualAmount = roundMoney(Prisma.Decimal.min(dailyPenalty, availableRoom))
  const remainingCap = roundMoney(Prisma.Decimal.max(ZERO, availableRoom.minus(accrualAmount)))

  return {
    dailyPenalty,
    cap,
    accrualAmount,
    remainingCap,
  }
}

/**
 * Derives all dates that require penalty accrual in catch-up mode (§2.2, §P4-04).
 * Returns array of Lagos date strings (YYYY-MM-DD).
 *
 * Rules:
 * - date must be >= dueDate + 8 (first penalty date)
 * - date must be <= evaluationDate (e.g. today in Lagos)
 * - date must be > lastAccruedDate (if previously accrued)
 * - if paidValueDate is provided, the obligation was only overdue at the end of dates strictly before paidValueDate (date < paidValueDate)
 */
export function deriveUnaccruedPenaltyDates(params: {
  dueDate: Date | string
  evaluationDate: Date | string
  lastAccruedDate?: Date | string | null
  paidValueDate?: Date | string | null
}): string[] {
  const due = parseDateOnly(params.dueDate)
  const firstPenaltyDate = addDays(due, 8)
  const evalDate = parseDateOnly(params.evaluationDate)

  // Start date: max(firstPenaltyDate, lastAccruedDate + 1)
  let startDate = firstPenaltyDate
  if (params.lastAccruedDate) {
    const nextAfterLast = addDays(parseDateOnly(params.lastAccruedDate), 1)
    if (isBefore(startDate, nextAfterLast)) {
      startDate = nextAfterLast
    }
  }

  // End date: min(evalDate, paidValueDate ? paidValueDate - 1 : evalDate)
  let endDate = evalDate
  if (params.paidValueDate) {
    const dayBeforePaid = addDays(parseDateOnly(params.paidValueDate), -1)
    if (isBefore(dayBeforePaid, endDate)) {
      endDate = dayBeforePaid
    }
  }

  if (isBefore(endDate, startDate)) {
    return []
  }

  const result: string[] = []
  let cursor = startDate
  while (!isBefore(endDate, cursor)) {
    result.push(toLagosDateString(cursor))
    cursor = addDays(cursor, 1)
  }

  return result
}
