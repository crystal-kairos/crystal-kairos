import { describe, it, expect } from 'vitest'
import {
  addMonthsClamped,
  addDays,
  diffDays,
  isBefore,
  isSameOrBefore,
  formatDateOnly,
  toLagosDateString,
  parseDateOnly,
  generateLoanDueDates,
  generateMonthlySavingsDueDates,
  generateWeeklySavingsDueDates,
  generateDailySavingsDueDates,
  generateEAjoDueDates,
} from '@/lib/domain/dates'
import { c1LoanScheduleFixture } from '../golden/c1-loan-schedule.fixture'

describe('Dates Domain Primitives (§2.6, D-14)', () => {
  it('correctly clamps Jan 31 across non-leap year (2027) without drift', () => {
    const anchor = '2027-01-31'
    const dueDates = [1, 2, 3, 4, 5, 6].map((k) =>
      formatDateOnly(addMonthsClamped(anchor, k)),
    )

    expect(dueDates).toEqual([
      '2027-02-28', // Feb (non-leap) clamped to 28
      '2027-03-31', // Mar restored to 31 (does not drift to 28!)
      '2027-04-30', // Apr clamped to 30
      '2027-05-31', // May restored to 31
      '2027-06-30', // Jun clamped to 30
      '2027-07-31', // Jul restored to 31
    ])
  })

  it('correctly clamps Jan 31 in a leap year (2028) to Feb 29', () => {
    const anchor = '2028-01-31'
    const feb = formatDateOnly(addMonthsClamped(anchor, 1))
    const mar = formatDateOnly(addMonthsClamped(anchor, 2))
    expect(feb).toBe('2028-02-29')
    expect(mar).toBe('2028-03-31')
  })

  it('handles leap day anchor (2028-02-29) in subsequent months and years', () => {
    const anchor = '2028-02-29'
    const mar = formatDateOnly(addMonthsClamped(anchor, 1))
    const apr = formatDateOnly(addMonthsClamped(anchor, 2))
    const oneYearLater = formatDateOnly(addMonthsClamped(anchor, 12))

    expect(mar).toBe('2028-03-29')
    expect(apr).toBe('2028-04-29')
    expect(oneYearLater).toBe('2029-02-28') // 2029 is not a leap year, clamped to 28
  })

  it('correctly parses Lagos midnight boundaries (UTC vs WAT)', () => {
    // 2026-10-24 23:30:00 UTC is 2026-10-25 00:30:00 in Africa/Lagos (UTC+1)
    const lateUtc = new Date('2026-10-24T23:30:00.000Z')
    expect(toLagosDateString(lateUtc)).toBe('2026-10-25')

    // 2026-10-25 00:30:00 UTC is 2026-10-25 01:30:00 in Africa/Lagos
    const earlyUtc = new Date('2026-10-25T00:30:00.000Z')
    expect(toLagosDateString(earlyUtc)).toBe('2026-10-25')

    // 2026-10-24 22:59:59 UTC is 2026-10-24 23:59:59 in Africa/Lagos
    const beforeMidnightUtc = new Date('2026-10-24T22:59:59.000Z')
    expect(toLagosDateString(beforeMidnightUtc)).toBe('2026-10-24')
  })

  it('generates loan due dates reproducing Appendix C1 golden fixture', () => {
    const dates = generateLoanDueDates(
      c1LoanScheduleFixture.input.disbursementDate,
      c1LoanScheduleFixture.input.termMonths,
    ).map(formatDateOnly)

    const expectedDates = c1LoanScheduleFixture.expected.instalments.map(
      (inst) => inst.dueDate,
    )
    expect(dates).toEqual(expectedDates)
  })

  it('generates monthly regular savings due dates with period 1 starting on start date (§2.6)', () => {
    const start = '2027-03-15'
    const dates = generateMonthlySavingsDueDates(start, 3).map(formatDateOnly)
    expect(dates).toEqual(['2027-03-15', '2027-04-15', '2027-05-15'])
  })

  it('enforces that weekly savings periods are strictly before maturity date (§2.6)', () => {
    // 1-month plan starting 2027-02-01 -> maturity is 2027-03-01 (addMonthsClamped 1 month)
    // Days from 2027-02-01:
    // i=1: 2027-02-01 (day 0)
    // i=2: 2027-02-08 (day 7)
    // i=3: 2027-02-15 (day 14)
    // i=4: 2027-02-22 (day 21)
    // i=5: 2027-03-01 (day 28) -> EQUAL TO MATURITY! MUST BE EXCLUDED!
    const start = '2027-02-01'
    const dates = generateWeeklySavingsDueDates(start, 1).map(formatDateOnly)
    expect(dates).toEqual([
      '2027-02-01',
      '2027-02-08',
      '2027-02-15',
      '2027-02-22',
    ])
    expect(dates).not.toContain('2027-03-01')
  })

  it('enforces that daily savings periods are strictly before maturity date (§2.6)', () => {
    // 1-month plan starting 2027-02-01 -> maturity is 2027-03-01 (28 days in Feb 2027)
    // Must generate exactly 28 days (Feb 1 to Feb 28), excluding Mar 1
    const start = '2027-02-01'
    const dates = generateDailySavingsDueDates(start, 1).map(formatDateOnly)
    expect(dates).toHaveLength(28)
    expect(dates[0]).toBe('2027-02-01')
    expect(dates[27]).toBe('2027-02-28')
    expect(dates).not.toContain('2027-03-01')
  })

  it('generates E-Ajo contribution due dates anchored to group start date', () => {
    const start = '2027-01-15'
    const dates = generateEAjoDueDates(start, 4).map(formatDateOnly)
    expect(dates).toEqual([
      '2027-01-15',
      '2027-02-15',
      '2027-03-15',
      '2027-04-15',
    ])
  })

  it('computes addDays and diffDays correctly', () => {
    const d1 = '2027-01-10'
    const d2 = addDays(d1, 7)
    expect(formatDateOnly(d2)).toBe('2027-01-17')
    expect(diffDays(d1, d2)).toBe(7)
    expect(diffDays(d2, d1)).toBe(-7)
    expect(isBefore(d1, d2)).toBe(true)
    expect(isSameOrBefore(d1, d1)).toBe(true)
  })
})
