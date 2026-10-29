import { describe, it, expect } from 'vitest'
import { Prisma } from '@/generated/prisma/client'
import { PenaltyCapType } from '@/generated/prisma/enums'
import {
  getPenaltyTimeline,
  calculatePenaltyCap,
  calculateDailyPenaltyAccrual,
  deriveUnaccruedPenaltyDates,
} from '@/lib/domain/penalty-calculation'
import { c2PenaltiesAndGraceFixture } from '@/tests/golden/c2-penalties-and-grace.fixture'

describe('PR P2-05: Appendix C2 Penalties, Grace & Boundary Tests', () => {
  const { input, expected } = c2PenaltiesAndGraceFixture

  it('matches Appendix C2 timeline: grace days 1..7, day 8 penalty, day 15 case eligibility', () => {
    const timeline = getPenaltyTimeline(input.instalment1DueDate)

    expect(timeline.dueDate).toBe('2027-02-10')
    expect(timeline.graceWindowEnd).toBe(expected.graceWindowEnd) // 2027-02-17
    expect(timeline.firstPenaltyDate).toBe(expected.firstPenaltyDate) // 2027-02-18
    expect(timeline.recoveryEligibilityDate).toBe(expected.recoveryEligibilityDate) // 2027-02-25
  })

  it('calculates PERCENT_OF_PRINCIPAL cap and stops exactly at ₦30,000 after 20 days', () => {
    const cap = calculatePenaltyCap(
      input.principal,
      PenaltyCapType.PERCENT_OF_PRINCIPAL,
      expected.capPercentOfPrincipal.capPercent
    )
    expect(cap.equals(expected.capPercentOfPrincipal.capAmount)).toBe(true)

    // Simulate day-by-day accrual
    let totalAccrued = new Prisma.Decimal(0)
    for (let day = 1; day <= 25; day++) {
      const res = calculateDailyPenaltyAccrual({
        base: input.principal,
        latePenaltyDailyPercent: input.dailyPenaltyPercent,
        penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
        penaltyCapValue: expected.capPercentOfPrincipal.capPercent,
        penaltiesAssessedNet: totalAccrued,
      })

      if (day <= expected.capPercentOfPrincipal.maxPenaltyDays) {
        expect(res.accrualAmount.equals(input.dailyPenaltyAmount)).toBe(true)
      } else {
        expect(res.accrualAmount.equals(0)).toBe(true)
      }
      totalAccrued = totalAccrued.plus(res.accrualAmount)
    }

    expect(totalAccrued.equals(expected.capPercentOfPrincipal.totalAccrual)).toBe(true)
  })

  it('calculates FIXED_AMOUNT cap (₦20,000) with clamped partial accrual on day 14 (₦500)', () => {
    const cap = calculatePenaltyCap(
      input.principal,
      PenaltyCapType.FIXED_AMOUNT,
      expected.capFixedAmount.capAmount
    )
    expect(cap.equals(expected.capFixedAmount.capAmount)).toBe(true)

    let totalAccrued = new Prisma.Decimal(0)
    for (let day = 1; day <= 15; day++) {
      const res = calculateDailyPenaltyAccrual({
        base: input.principal,
        latePenaltyDailyPercent: input.dailyPenaltyPercent,
        penaltyCapType: PenaltyCapType.FIXED_AMOUNT,
        penaltyCapValue: expected.capFixedAmount.capAmount,
        penaltiesAssessedNet: totalAccrued,
      })

      if (day <= 13) {
        expect(res.accrualAmount.equals(input.dailyPenaltyAmount)).toBe(true)
      } else if (day === 14) {
        expect(res.accrualAmount.equals(expected.capFixedAmount.day14ClampedAccrual)).toBe(true) // 500
      } else {
        expect(res.accrualAmount.equals(0)).toBe(true)
      }
      totalAccrued = totalAccrued.plus(res.accrualAmount)
    }

    expect(totalAccrued.equals(expected.capFixedAmount.totalAccrual)).toBe(true) // 20,000
  })

  it('derives unaccrued penalty dates for payment with value date 20 Feb (2 penalty days = ₦3,000)', () => {
    // Payment with value date 20 Feb 2027
    const penaltyDates = deriveUnaccruedPenaltyDates({
      dueDate: input.instalment1DueDate,
      evaluationDate: '2027-02-22',
      paidValueDate: '2027-02-20',
    })

    // Feb 18 and Feb 19 are overdue at the end of the day; Feb 20 was paid by value date
    expect(penaltyDates).toEqual(['2027-02-18', '2027-02-19'])

    let accrued = new Prisma.Decimal(0)
    for (const d of penaltyDates) {
      const res = calculateDailyPenaltyAccrual({
        base: input.principal,
        latePenaltyDailyPercent: input.dailyPenaltyPercent,
        penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
        penaltyCapValue: expected.capPercentOfPrincipal.capPercent,
        penaltiesAssessedNet: accrued,
      })
      accrued = accrued.plus(res.accrualAmount)
    }

    expect(accrued.equals(expected.paymentAllocationOnFeb20.penaltyAccrued)).toBe(true) // 3000
  })

  it('handles catch-up derive when no days missed or during grace window', () => {
    // During grace window (15 Feb): no penalty days
    const duringGrace = deriveUnaccruedPenaltyDates({
      dueDate: '2027-02-10',
      evaluationDate: '2027-02-15',
    })
    expect(duringGrace).toEqual([])

    // Exactly on grace end (17 Feb): no penalty days
    const graceEnd = deriveUnaccruedPenaltyDates({
      dueDate: '2027-02-10',
      evaluationDate: '2027-02-17',
    })
    expect(graceEnd).toEqual([])

    // On first penalty day (18 Feb): 1 penalty day
    const firstDay = deriveUnaccruedPenaltyDates({
      dueDate: '2027-02-10',
      evaluationDate: '2027-02-18',
    })
    expect(firstDay).toEqual(['2027-02-18'])
  })
})
