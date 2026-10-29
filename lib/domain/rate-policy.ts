import { Prisma } from '@/generated/prisma/client'
import { PenaltyCapType } from '@/generated/prisma/enums'
import { parseDateOnly, toLagosDateString, isBefore } from '@/lib/domain/dates'

export interface LoanTermRateInput {
  durationMonths: number
  monthlyInterestPercent: Prisma.Decimal | number | string
  latePenaltyDailyPercent: Prisma.Decimal | number | string
  penaltyCapType: PenaltyCapType
  penaltyCapValue: Prisma.Decimal | number | string
  effectiveFrom: Date | string
  effectiveTo?: Date | string | null
}

export interface ValidatedLoanTermRate {
  durationMonths: number
  monthlyInterestPercent: Prisma.Decimal
  latePenaltyDailyPercent: Prisma.Decimal
  penaltyCapType: PenaltyCapType
  penaltyCapValue: Prisma.Decimal
  effectiveFrom: Date
  effectiveTo: Date | null
}

/**
 * Validates loan term rate input according to D-05 and PR P2-05 rules:
 * - durationMonths must be an integer between 1 and 12
 * - monthlyInterestPercent must be non-negative
 * - latePenaltyDailyPercent must be non-negative
 * - penaltyCapType is required
 * - penaltyCapValue must be strictly greater than 0
 * - effectiveFrom is required
 * - if effectiveTo is provided, effectiveTo must be on or after effectiveFrom
 */
export function validateLoanTermRateInput(input: LoanTermRateInput): ValidatedLoanTermRate {
  if (
    !Number.isInteger(input.durationMonths) ||
    input.durationMonths < 1 ||
    input.durationMonths > 12
  ) {
    throw new Error('durationMonths must be an integer between 1 and 12')
  }

  const monthlyInterest = new Prisma.Decimal(input.monthlyInterestPercent)
  if (monthlyInterest.isNegative()) {
    throw new Error('monthlyInterestPercent cannot be negative')
  }

  const lateDaily = new Prisma.Decimal(input.latePenaltyDailyPercent)
  if (lateDaily.isNegative()) {
    throw new Error('latePenaltyDailyPercent cannot be negative')
  }

  if (
    input.penaltyCapType !== PenaltyCapType.PERCENT_OF_PRINCIPAL &&
    input.penaltyCapType !== PenaltyCapType.FIXED_AMOUNT
  ) {
    throw new Error('penaltyCapType is mandatory and must be PERCENT_OF_PRINCIPAL or FIXED_AMOUNT')
  }

  const capValue = new Prisma.Decimal(input.penaltyCapValue)
  if (capValue.lte(0)) {
    throw new Error('penaltyCapValue must be strictly greater than 0')
  }

  const effFrom = parseDateOnly(input.effectiveFrom)
  const effTo = input.effectiveTo ? parseDateOnly(input.effectiveTo) : null

  if (effTo && isBefore(effTo, effFrom)) {
    throw new Error('effectiveTo cannot precede effectiveFrom')
  }

  return {
    durationMonths: input.durationMonths,
    monthlyInterestPercent: monthlyInterest,
    latePenaltyDailyPercent: lateDaily,
    penaltyCapType: input.penaltyCapType,
    penaltyCapValue: capValue,
    effectiveFrom: effFrom,
    effectiveTo: effTo,
  }
}

/**
 * Validates that a new rate range does not overlap with existing versions for the same duration.
 */
export function assertNoRateOverlap(
  existingRates: Array<{
    id?: string
    durationMonths: number
    effectiveFrom: Date | string
    effectiveTo?: Date | string | null
  }>,
  candidate: {
    id?: string
    durationMonths: number
    effectiveFrom: Date | string
    effectiveTo?: Date | string | null
  }
): void {
  const candFrom = parseDateOnly(candidate.effectiveFrom).getTime()
  const candTo = candidate.effectiveTo ? parseDateOnly(candidate.effectiveTo).getTime() : Infinity

  for (const existing of existingRates) {
    if (existing.id && candidate.id && existing.id === candidate.id) {
      continue
    }
    if (existing.durationMonths !== candidate.durationMonths) {
      continue
    }

    const exFrom = parseDateOnly(existing.effectiveFrom).getTime()
    const exTo = existing.effectiveTo ? parseDateOnly(existing.effectiveTo).getTime() : Infinity

    // Overlap condition: startA <= endB and startB <= endA
    if (candFrom <= exTo && exFrom <= candTo) {
      throw new Error(
        `Rate overlap detected for ${candidate.durationMonths} months between ` +
          `[${toLagosDateString(candidate.effectiveFrom)} .. ${candidate.effectiveTo ? toLagosDateString(candidate.effectiveTo) : 'open'}] ` +
          `and [${toLagosDateString(existing.effectiveFrom)} .. ${existing.effectiveTo ? toLagosDateString(existing.effectiveTo) : 'open'}]`
      )
    }
  }
}

/**
 * Resolves active loan rate for a given duration as of a target date.
 */
export function resolveActiveLoanRate<
  T extends {
    durationMonths: number
    effectiveFrom: Date | string
    effectiveTo?: Date | string | null
    version: number
  }
>(rates: T[], durationMonths: number, asOfDate: Date | string = new Date()): T | null {
  const asOf = parseDateOnly(asOfDate).getTime()

  const matching = rates.filter((r) => {
    if (r.durationMonths !== durationMonths) return false
    const fromTime = parseDateOnly(r.effectiveFrom).getTime()
    const toTime = r.effectiveTo ? parseDateOnly(r.effectiveTo).getTime() : Infinity
    return fromTime <= asOf && asOf <= toTime
  })

  if (matching.length === 0) return null
  // Return the one with the highest version
  matching.sort((a, b) => b.version - a.version)
  return matching[0]
}

/**
 * Formats a list of savings product term rates into the canonical display string (§2.5).
 * e.g. "12.00% (6M) / 24.00% (12M)"
 */
export function formatSavingsProductRatesDisplay(
  rates: Array<{
    durationMonths: number
    ratePercent: Prisma.Decimal | number | string
    isActive?: boolean
  }>
): string {
  const active = rates.filter((r) => r.isActive !== false)
  if (active.length === 0) {
    return 'Flexible Rates'
  }

  active.sort((a, b) => a.durationMonths - b.durationMonths)

  return active
    .map((r) => {
      const pct = new Prisma.Decimal(r.ratePercent).toFixed(2)
      return `${pct}% (${r.durationMonths}M)`
    })
    .join(' / ')
}
