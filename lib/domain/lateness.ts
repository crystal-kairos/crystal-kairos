import { Prisma } from '@/generated/prisma/client'
import {
  PaymentComponentType,
  PenaltyCapType,
} from '@/generated/prisma/enums'
import {
  addDays,
  diffDays,
  parseDateOnly,
  toLagosDateString,
} from '@/lib/domain/dates'
import { roundMoney, toDecimal } from '@/lib/domain/money'
import {
  calculateDailyPenaltyAccrual,
  calculatePenaltyCap,
  getPenaltyTimeline,
  PenaltyTimeline,
} from '@/lib/domain/penalty-calculation'
import {
  evaluatePeriodForfeiture,
  SAVINGS_GRACE_DAYS,
} from '@/lib/domain/savings-interest'

const ZERO = new Prisma.Decimal(0)

export const GRACE_PERIOD_DAYS = 7
export const PENALTY_START_OFFSET = 8
export const RECOVERY_ELIGIBLE_DAY_OFFSET = 15

export {
  SAVINGS_GRACE_DAYS,
  getPenaltyTimeline,
  calculatePenaltyCap,
  calculateDailyPenaltyAccrual,
  evaluatePeriodForfeiture,
  type PenaltyTimeline,
}

/**
 * Evaluates whether an obligation or period is protected by the review shield on `evaluationDate`
 * (§2.2 rule 5, §2.10 rule 7, A-11, Appendix C8).
 *
 * A `SUBMITTED` payment submission with `paidOn <= evaluationDate` suppresses daily penalty
 * accrual and regular-savings forfeiture marking while it awaits staff review.
 */
export function isShieldedOnDate(
  shieldPaidOnDates: ReadonlyArray<Date | string>,
  evaluationDate: Date | string,
): boolean {
  if (shieldPaidOnDates.length === 0) return false
  const evalStr = toLagosDateString(parseDateOnly(evaluationDate))
  return shieldPaidOnDates.some(
    (paidOn) => toLagosDateString(parseDateOnly(paidOn)) <= evalStr,
  )
}

export interface ValueDatedAllocationSlice {
  periodId: string | null
  componentType: PaymentComponentType | 'PRINCIPAL' | 'INTEREST' | 'PENALTY' | 'CONTRIBUTION' | 'FEE' | 'WALLET_TOPUP'
  amount: Prisma.Decimal | number | string
  valueDate: Date | string
}

/**
 * Calculates how much of a period/instalment's base obligation (principal + interest for loans,
 * contribution for e-ajo/savings) had been paid by active allocations with `valueDate <= evaluationDate`.
 */
export function getBasePaidByValueDate(
  periodId: string,
  allocations: ReadonlyArray<ValueDatedAllocationSlice>,
  evaluationDate: Date | string,
  inclusive: boolean = true,
): Prisma.Decimal {
  const evalStr = toLagosDateString(parseDateOnly(evaluationDate))
  let paid = ZERO
  for (const alloc of allocations) {
    if (alloc.periodId !== periodId) continue
    if (
      alloc.componentType !== PaymentComponentType.PRINCIPAL &&
      alloc.componentType !== PaymentComponentType.INTEREST &&
      alloc.componentType !== PaymentComponentType.CONTRIBUTION
    ) {
      continue
    }
    const vStr = toLagosDateString(parseDateOnly(alloc.valueDate))
    if (inclusive ? vStr <= evalStr : vStr < evalStr) {
      paid = paid.plus(toDecimal(alloc.amount))
    }
  }
  return roundMoney(paid)
}

export interface LoanInstalmentLatenessInput {
  id: string
  instalmentNumber: number
  dueDate: Date | string
  principalDue: Prisma.Decimal | number | string
  interestDue: Prisma.Decimal | number | string
}

export interface ExistingLoanAccrualSlice {
  id: string
  loanInstalmentId: string
  penaltyDate: Date | string
  amount: Prisma.Decimal | number | string
  reversedAt: Date | null
  journalEntryId: string | null
}

export interface ShieldSubmissionSlice {
  periodId: string | null
  paidOn: Date | string
}

export interface PlannedLoanAccrualReversal {
  accrualId: string
  loanInstalmentId: string
  penaltyDate: string
  amount: Prisma.Decimal
  journalEntryId: string | null
  reason: 'VALUE_DATE_RECALC'
}

export interface PlannedLoanAccrualItem {
  loanInstalmentId: string
  instalmentNumber: number
  penaltyDate: string
  amount: Prisma.Decimal
  isCapped: boolean
}

export interface LoanLatenessPlan {
  toReverse: PlannedLoanAccrualReversal[]
  toAccrue: PlannedLoanAccrualItem[]
  shieldedDates: Array<{ loanInstalmentId: string; penaltyDate: string }>
  finalPenaltiesAssessedNet: Prisma.Decimal
  instalmentAssessedMap: Map<string, Prisma.Decimal>
}

/**
 * Pure value-date recalculation and catch-up planner for a loan across all its instalments
 * (§2.2, A-02, A-11, Appendix C2, Appendix C8).
 *
 * Rules enforced:
 * 1. Base is original disbursed principal (`disbursedPrincipal`) per overdue instalment per day.
 * 2. Cap is loan-wide across all instalments (`PERCENT_OF_PRINCIPAL` or `FIXED_AMOUNT`).
 * 3. Oldest `dueDate` (then `instalmentNumber`) is processed first on each calendar day.
 * 4. An instalment is overdue on day `d >= dueDate + 8` iff `(principalDue + interestDue) - basePaidBy(d) > 0`.
 * 5. Existing active accruals on days where the instalment was settled by `valueDate <= d` (or that now
 *    exceed the loan-wide cap) are marked for reversal with `VALUE_DATE_RECALC`.
 * 6. Missing chargeable days without an active accrual are planned for accrual unless suppressed by a
 *    `SUBMITTED` payment submission with `paidOn <= d`.
 */
export function planLoanPenaltyLateness(params: {
  disbursedPrincipal: Prisma.Decimal | number | string
  dailyRatePercent: Prisma.Decimal | number | string
  capType: PenaltyCapType
  capValue: Prisma.Decimal | number | string
  asOf: Date | string
  instalments: ReadonlyArray<LoanInstalmentLatenessInput>
  activeAllocations: ReadonlyArray<ValueDatedAllocationSlice>
  existingAccruals: ReadonlyArray<ExistingLoanAccrualSlice>
  shieldSubmissions?: ReadonlyArray<ShieldSubmissionSlice>
  reverseAccrualsAfterAsOf?: boolean
}): LoanLatenessPlan {
  const disbursedPrincipal = toDecimal(params.disbursedPrincipal)
  const dailyRatePercent = toDecimal(params.dailyRatePercent)
  const capValue = toDecimal(params.capValue)
  const asOfStr = toLagosDateString(parseDateOnly(params.asOf))
  const shields = params.shieldSubmissions ?? []
  const reverseAfterAsOf = params.reverseAccrualsAfterAsOf ?? false

  const sortedInstalments = [...params.instalments].sort((a, b) => {
    const dueCmp = toLagosDateString(parseDateOnly(a.dueDate)).localeCompare(
      toLagosDateString(parseDateOnly(b.dueDate)),
    )
    if (dueCmp !== 0) return dueCmp
    return a.instalmentNumber - b.instalmentNumber
  })

  const activeAccruals = params.existingAccruals.filter((a) => a.reversedAt === null)
  const activeByKey = new Map<string, ExistingLoanAccrualSlice>()
  for (const acc of activeAccruals) {
    const key = `${acc.loanInstalmentId}:${toLagosDateString(parseDateOnly(acc.penaltyDate))}`
    activeByKey.set(key, acc)
  }

  const toReverse: PlannedLoanAccrualReversal[] = []
  const reversedIds = new Set<string>()

  const instMeta = sortedInstalments.map((inst) => {
    const timeline = getPenaltyTimeline(inst.dueDate)
    const baseDue = roundMoney(toDecimal(inst.principalDue).plus(toDecimal(inst.interestDue)))
    return {
      ...inst,
      dueDateStr: timeline.dueDate,
      firstPenaltyDate: timeline.firstPenaltyDate,
      baseDue,
    }
  })
  const instMetaById = new Map(instMeta.map((m) => [m.id, m]))

  for (const acc of activeAccruals) {
    const dateStr = toLagosDateString(parseDateOnly(acc.penaltyDate))
    const meta = instMetaById.get(acc.loanInstalmentId)
    if (!meta) continue

    const basePaid = getBasePaidByValueDate(meta.id, params.activeAllocations, dateStr, true)
    const baseOutstanding = roundMoney(meta.baseDue.minus(basePaid))
    const settledByValueDate = baseOutstanding.lte(ZERO)
    const beforePenaltyStart = dateStr < meta.firstPenaltyDate
    const afterEvaluationWindow = reverseAfterAsOf && dateStr > asOfStr

    if (settledByValueDate || beforePenaltyStart || afterEvaluationWindow) {
      toReverse.push({
        accrualId: acc.id,
        loanInstalmentId: acc.loanInstalmentId,
        penaltyDate: dateStr,
        amount: roundMoney(toDecimal(acc.amount)),
        journalEntryId: acc.journalEntryId,
        reason: 'VALUE_DATE_RECALC',
      })
      reversedIds.add(acc.id)
    }
  }

  let earliestPenaltyDate: string | null = null
  for (const meta of instMeta) {
    if (!earliestPenaltyDate || meta.firstPenaltyDate < earliestPenaltyDate) {
      earliestPenaltyDate = meta.firstPenaltyDate
    }
  }

  const toAccrue: PlannedLoanAccrualItem[] = []
  const shieldedDates: Array<{ loanInstalmentId: string; penaltyDate: string }> = []
  const instalmentAssessedMap = new Map<string, Prisma.Decimal>()
  for (const meta of instMeta) {
    instalmentAssessedMap.set(meta.id, ZERO)
  }

  let runningAssessedNet = ZERO

  if (earliestPenaltyDate && earliestPenaltyDate <= asOfStr && dailyRatePercent.gt(ZERO)) {
    const totalDays = diffDays(parseDateOnly(earliestPenaltyDate), parseDateOnly(asOfStr))
    for (let offset = 0; offset <= totalDays; offset++) {
      const dateStr = toLagosDateString(addDays(parseDateOnly(earliestPenaltyDate), offset))

      for (const meta of instMeta) {
        if (dateStr < meta.firstPenaltyDate) continue

        const basePaid = getBasePaidByValueDate(meta.id, params.activeAllocations, dateStr, true)
        const baseOutstanding = roundMoney(meta.baseDue.minus(basePaid))
        if (baseOutstanding.lte(ZERO)) {
          continue
        }

        const key = `${meta.id}:${dateStr}`
        const existing = activeByKey.get(key)

        if (existing && !reversedIds.has(existing.id)) {
          const existingAmt = roundMoney(toDecimal(existing.amount))
          const calc = calculateDailyPenaltyAccrual({
            base: disbursedPrincipal,
            latePenaltyDailyPercent: dailyRatePercent,
            penaltyCapType: params.capType,
            penaltyCapValue: capValue,
            penaltiesAssessedNet: runningAssessedNet,
          })
          if (calc.accrualAmount.lte(ZERO)) {
            toReverse.push({
              accrualId: existing.id,
              loanInstalmentId: existing.loanInstalmentId,
              penaltyDate: dateStr,
              amount: existingAmt,
              journalEntryId: existing.journalEntryId,
              reason: 'VALUE_DATE_RECALC',
            })
            reversedIds.add(existing.id)
          } else {
            runningAssessedNet = roundMoney(runningAssessedNet.plus(existingAmt))
            instalmentAssessedMap.set(
              meta.id,
              roundMoney((instalmentAssessedMap.get(meta.id) ?? ZERO).plus(existingAmt)),
            )
          }
          continue
        }

        const matchingShields = shields
          .filter((s) => s.periodId === meta.id || s.periodId === null)
          .map((s) => s.paidOn)

        if (isShieldedOnDate(matchingShields, dateStr)) {
          shieldedDates.push({ loanInstalmentId: meta.id, penaltyDate: dateStr })
          continue
        }

        const calc = calculateDailyPenaltyAccrual({
          base: disbursedPrincipal,
          latePenaltyDailyPercent: dailyRatePercent,
          penaltyCapType: params.capType,
          penaltyCapValue: capValue,
          penaltiesAssessedNet: runningAssessedNet,
        })

        if (calc.accrualAmount.gt(ZERO)) {
          toAccrue.push({
            loanInstalmentId: meta.id,
            instalmentNumber: meta.instalmentNumber,
            penaltyDate: dateStr,
            amount: calc.accrualAmount,
            isCapped: calc.accrualAmount.lt(calc.dailyPenalty),
          })
          runningAssessedNet = roundMoney(runningAssessedNet.plus(calc.accrualAmount))
          instalmentAssessedMap.set(
            meta.id,
            roundMoney((instalmentAssessedMap.get(meta.id) ?? ZERO).plus(calc.accrualAmount)),
          )
        }
      }
    }
  } else {
    for (const acc of activeAccruals) {
      if (reversedIds.has(acc.id)) continue
      const amt = roundMoney(toDecimal(acc.amount))
      runningAssessedNet = roundMoney(runningAssessedNet.plus(amt))
      instalmentAssessedMap.set(
        acc.loanInstalmentId,
        roundMoney((instalmentAssessedMap.get(acc.loanInstalmentId) ?? ZERO).plus(amt)),
      )
    }
  }

  return {
    toReverse,
    toAccrue,
    shieldedDates,
    finalPenaltiesAssessedNet: runningAssessedNet,
    instalmentAssessedMap,
  }
}

export interface EAjoPeriodLatenessInput {
  id: string
  periodNumber: number
  dueDate: Date | string
  contributionDue: Prisma.Decimal | number | string
}

export interface ExistingEAjoAccrualSlice {
  id: string
  eajoContributionPeriodId: string
  penaltyDate: Date | string
  amount: Prisma.Decimal | number | string
  reversedAt: Date | null
  journalEntryId: string | null
}

export interface PlannedEAjoAccrualReversal {
  accrualId: string
  eajoContributionPeriodId: string
  penaltyDate: string
  amount: Prisma.Decimal
  journalEntryId: string | null
  reason: 'VALUE_DATE_RECALC'
}

export interface PlannedEAjoAccrualItem {
  eajoContributionPeriodId: string
  periodNumber: number
  penaltyDate: string
  amount: Prisma.Decimal
  base: Prisma.Decimal
}

export interface EAjoParticipantLatenessPlan {
  toReverse: PlannedEAjoAccrualReversal[]
  toAccrue: PlannedEAjoAccrualItem[]
  shieldedDates: Array<{ eajoContributionPeriodId: string; penaltyDate: string }>
  finalPenaltiesAssessedNet: Prisma.Decimal
  periodAssessedMap: Map<string, Prisma.Decimal>
}

/**
 * Pure value-date recalculation and catch-up planner for an E-Ajo participant across all
 * their contribution periods (§2.3, A-03, OQ-16, A-11, Appendix C8).
 *
 * Matches `lib/domain/eajo-penalty.ts`:
 * - Cap is per participant across all periods (`capBase = c × N` for `PERCENT_OF_PRINCIPAL`).
 * - Daily base is unpaid contribution at the start of day `d` (`contributionDue - paidBeforeStart(d)`),
 *   and day `d` is chargeable only if `contributionDue - paidByEnd(d) > 0`.
 * - Any existing active accrual on a day where `contributionDue - paidByEnd(d) <= 0` (or that exceeds
 *   the participant cap / differs after a backdated partial payment) is reversed with `VALUE_DATE_RECALC`.
 */
export function planEAjoParticipantPenaltyLateness(params: {
  capBase: Prisma.Decimal | number | string
  dailyRatePercent: Prisma.Decimal | number | string
  capType: PenaltyCapType
  capValue: Prisma.Decimal | number | string
  asOf: Date | string
  periods: ReadonlyArray<EAjoPeriodLatenessInput>
  activeAllocations: ReadonlyArray<ValueDatedAllocationSlice>
  existingAccruals: ReadonlyArray<ExistingEAjoAccrualSlice>
  shieldSubmissions?: ReadonlyArray<ShieldSubmissionSlice>
  reverseAccrualsAfterAsOf?: boolean
}): EAjoParticipantLatenessPlan {
  const dailyRatePercent = toDecimal(params.dailyRatePercent)
  const cap = calculatePenaltyCap(params.capBase, params.capType, params.capValue)
  const asOfStr = toLagosDateString(parseDateOnly(params.asOf))
  const shields = params.shieldSubmissions ?? []
  const reverseAfterAsOf = params.reverseAccrualsAfterAsOf ?? false

  const sortedPeriods = [...params.periods].sort((a, b) => {
    const dueCmp = toLagosDateString(parseDateOnly(a.dueDate)).localeCompare(
      toLagosDateString(parseDateOnly(b.dueDate)),
    )
    if (dueCmp !== 0) return dueCmp
    return a.periodNumber - b.periodNumber
  })

  const activeAccruals = params.existingAccruals.filter((a) => a.reversedAt === null)
  const activeByKey = new Map<string, ExistingEAjoAccrualSlice>()
  for (const acc of activeAccruals) {
    const key = `${acc.eajoContributionPeriodId}:${toLagosDateString(parseDateOnly(acc.penaltyDate))}`
    activeByKey.set(key, acc)
  }

  const toReverse: PlannedEAjoAccrualReversal[] = []
  const reversedIds = new Set<string>()

  const periodMeta = sortedPeriods.map((p) => {
    const timeline = getPenaltyTimeline(p.dueDate)
    const dueDec = roundMoney(toDecimal(p.contributionDue))
    return {
      ...p,
      dueDateStr: timeline.dueDate,
      firstPenaltyDate: timeline.firstPenaltyDate,
      dueDec,
    }
  })
  const periodMetaById = new Map(periodMeta.map((m) => [m.id, m]))

  for (const acc of activeAccruals) {
    const dateStr = toLagosDateString(parseDateOnly(acc.penaltyDate))
    const meta = periodMetaById.get(acc.eajoContributionPeriodId)
    if (!meta) continue

    const paidByEnd = getBasePaidByValueDate(meta.id, params.activeAllocations, dateStr, true)
    const unpaidAtEnd = roundMoney(meta.dueDec.minus(paidByEnd))
    const settledByValueDate = unpaidAtEnd.lte(ZERO)
    const beforePenaltyStart = dateStr < meta.firstPenaltyDate
    const afterEvaluationWindow = reverseAfterAsOf && dateStr > asOfStr

    if (settledByValueDate || beforePenaltyStart || afterEvaluationWindow) {
      toReverse.push({
        accrualId: acc.id,
        eajoContributionPeriodId: acc.eajoContributionPeriodId,
        penaltyDate: dateStr,
        amount: roundMoney(toDecimal(acc.amount)),
        journalEntryId: acc.journalEntryId,
        reason: 'VALUE_DATE_RECALC',
      })
      reversedIds.add(acc.id)
    }
  }

  let earliestPenaltyDate: string | null = null
  for (const meta of periodMeta) {
    if (!earliestPenaltyDate || meta.firstPenaltyDate < earliestPenaltyDate) {
      earliestPenaltyDate = meta.firstPenaltyDate
    }
  }

  const toAccrue: PlannedEAjoAccrualItem[] = []
  const shieldedDates: Array<{ eajoContributionPeriodId: string; penaltyDate: string }> = []
  const periodAssessedMap = new Map<string, Prisma.Decimal>()
  for (const meta of periodMeta) {
    periodAssessedMap.set(meta.id, ZERO)
  }

  let runningAssessedNet = ZERO

  if (earliestPenaltyDate && earliestPenaltyDate <= asOfStr && dailyRatePercent.gt(ZERO)) {
    const totalDays = diffDays(parseDateOnly(earliestPenaltyDate), parseDateOnly(asOfStr))
    for (let offset = 0; offset <= totalDays; offset++) {
      const dateStr = toLagosDateString(addDays(parseDateOnly(earliestPenaltyDate), offset))

      for (const meta of periodMeta) {
        if (dateStr < meta.firstPenaltyDate) continue

        const paidByEnd = getBasePaidByValueDate(meta.id, params.activeAllocations, dateStr, true)
        if (meta.dueDec.minus(paidByEnd).lte(ZERO)) continue

        const paidBeforeStart = getBasePaidByValueDate(
          meta.id,
          params.activeAllocations,
          dateStr,
          false,
        )
        const base = roundMoney(Prisma.Decimal.max(ZERO, meta.dueDec.minus(paidBeforeStart)))
        const daily = roundMoney(base.mul(dailyRatePercent).div(100))
        if (daily.lte(ZERO)) continue

        const key = `${meta.id}:${dateStr}`
        const existing = activeByKey.get(key)

        if (existing && !reversedIds.has(existing.id)) {
          const existingAmt = roundMoney(toDecimal(existing.amount))
          const room = roundMoney(Prisma.Decimal.max(ZERO, cap.minus(runningAssessedNet)))
          const expected = roundMoney(Prisma.Decimal.min(daily, room))

          if (expected.lte(ZERO) || !existingAmt.equals(expected)) {
            toReverse.push({
              accrualId: existing.id,
              eajoContributionPeriodId: existing.eajoContributionPeriodId,
              penaltyDate: dateStr,
              amount: existingAmt,
              journalEntryId: existing.journalEntryId,
              reason: 'VALUE_DATE_RECALC',
            })
            reversedIds.add(existing.id)

            const matchingShields = shields
              .filter((s) => s.periodId === meta.id || s.periodId === null)
              .map((s) => s.paidOn)

            if (expected.gt(ZERO) && !isShieldedOnDate(matchingShields, dateStr)) {
              toAccrue.push({
                eajoContributionPeriodId: meta.id,
                periodNumber: meta.periodNumber,
                penaltyDate: dateStr,
                amount: expected,
                base,
              })
              runningAssessedNet = roundMoney(runningAssessedNet.plus(expected))
              periodAssessedMap.set(
                meta.id,
                roundMoney((periodAssessedMap.get(meta.id) ?? ZERO).plus(expected)),
              )
            }
          } else {
            runningAssessedNet = roundMoney(runningAssessedNet.plus(existingAmt))
            periodAssessedMap.set(
              meta.id,
              roundMoney((periodAssessedMap.get(meta.id) ?? ZERO).plus(existingAmt)),
            )
          }
          continue
        }

        const matchingShields = shields
          .filter((s) => s.periodId === meta.id || s.periodId === null)
          .map((s) => s.paidOn)

        if (isShieldedOnDate(matchingShields, dateStr)) {
          shieldedDates.push({ eajoContributionPeriodId: meta.id, penaltyDate: dateStr })
          continue
        }

        const room = roundMoney(Prisma.Decimal.max(ZERO, cap.minus(runningAssessedNet)))
        const amount = roundMoney(Prisma.Decimal.min(daily, room))
        if (amount.gt(ZERO)) {
          toAccrue.push({
            eajoContributionPeriodId: meta.id,
            periodNumber: meta.periodNumber,
            penaltyDate: dateStr,
            amount,
            base,
          })
          runningAssessedNet = roundMoney(runningAssessedNet.plus(amount))
          periodAssessedMap.set(
            meta.id,
            roundMoney((periodAssessedMap.get(meta.id) ?? ZERO).plus(amount)),
          )
        }
      }
    }
  } else {
    for (const acc of activeAccruals) {
      if (reversedIds.has(acc.id)) continue
      const amt = roundMoney(toDecimal(acc.amount))
      runningAssessedNet = roundMoney(runningAssessedNet.plus(amt))
      periodAssessedMap.set(
        acc.eajoContributionPeriodId,
        roundMoney((periodAssessedMap.get(acc.eajoContributionPeriodId) ?? ZERO).plus(amt)),
      )
    }
  }

  return {
    toReverse,
    toAccrue,
    shieldedDates,
    finalPenaltiesAssessedNet: runningAssessedNet,
    periodAssessedMap,
  }
}

export interface RecoveryEligibilityResult {
  isEligible: boolean
  dueDate: string
  graceWindowEnd: string
  firstPenaltyDate: string
  recoveryEligibilityDate: string
  daysPastDue: number
  isShielded: boolean
  outstandingAmount: Prisma.Decimal
}

/**
 * Evaluates whether a loan instalment or e-ajo contribution period is eligible for a recovery case
 * on `asOf` (§2.5, Appendix C8):
 * - `asOf >= dueDate + 15` (`recoveryEligibilityDate`)
 * - `outstandingAmount > 0` by value date
 * - Not shielded by a `SUBMITTED` payment submission with `paidOn <= asOf`
 */
export function evaluateRecoveryEligibility(params: {
  dueDate: Date | string
  outstandingAmount: Prisma.Decimal | number | string
  asOf: Date | string
  shieldPaidOnDates?: ReadonlyArray<Date | string>
}): RecoveryEligibilityResult {
  const milestones = getPenaltyTimeline(params.dueDate)
  const asOfStr = toLagosDateString(parseDateOnly(params.asOf))
  const outstanding = roundMoney(Prisma.Decimal.max(ZERO, toDecimal(params.outstandingAmount)))
  const shielded = isShieldedOnDate(params.shieldPaidOnDates ?? [], asOfStr)
  const daysPastDue = Math.max(
    0,
    diffDays(parseDateOnly(milestones.dueDate), parseDateOnly(asOfStr)),
  )

  const isEligible =
    asOfStr >= milestones.recoveryEligibilityDate &&
    outstanding.gt(ZERO) &&
    !shielded

  return {
    isEligible,
    dueDate: milestones.dueDate,
    graceWindowEnd: milestones.graceWindowEnd,
    firstPenaltyDate: milestones.firstPenaltyDate,
    recoveryEligibilityDate: milestones.recoveryEligibilityDate,
    daysPastDue,
    isShielded: shielded,
    outstandingAmount: outstanding,
  }
}
