/**
 * Date and calendar boundary domain primitives (§2.6, D-14).
 * All schedule calculations use Africa/Lagos (UTC+1, permanent, no DST).
 * Schedules are anchored to when the agreement/plan started and never chain from prior due dates.
 */

export const LAGOS_TIMEZONE = 'Africa/Lagos'

/**
 * Returns the current date in Lagos as an ISO date string (YYYY-MM-DD).
 */
export function lagosToday(): string {
  return toLagosDateString(new Date())
}

/**
 * Converts any Date instance or ISO timestamp to a Lagos-calendar YYYY-MM-DD date string.
 */
export function toLagosDateString(instant: Date | string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: LAGOS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return formatter.format(d)
}

/**
 * Parses a Date or date string into a normalized Date object representing UTC midnight of that calendar day.
 * This prevents local timezone offset drift when saving to PostgreSQL @db.Date.
 */
export function parseDateOnly(dateInput: string | Date): Date {
  const str =
    typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)
      ? dateInput
      : toLagosDateString(dateInput)
  const [year, month, day] = str.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

/**
 * Returns the number of days in a given calendar month (1-indexed month, 1 = January).
 */
export function daysInMonth(year: number, month1Indexed: number): number {
  return new Date(Date.UTC(year, month1Indexed, 0)).getUTCDate()
}

/**
 * Adds k months to an anchor date, clamping to the last day of the target month (§2.6).
 * Crucially, k is always relative to the original anchor date, preventing drift.
 *
 * Example: anchor 31 Jan -> 28 Feb (29 in leap year), 31 Mar, 30 Apr, 31 May.
 */
export function addMonthsClamped(anchor: Date | string, k: number): Date {
  const anchorStr =
    typeof anchor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(anchor)
      ? anchor
      : toLagosDateString(anchor)
  const [anchorYear, anchorMonth, anchorDay] = anchorStr.split('-').map(Number)

  const totalTargetMonths = anchorYear * 12 + (anchorMonth - 1) + k
  const targetYear = Math.floor(totalTargetMonths / 12)
  const targetMonth = (totalTargetMonths % 12) + 1 // 1-indexed

  const maxDays = daysInMonth(targetYear, targetMonth)
  const clampedDay = Math.min(anchorDay, maxDays)

  return new Date(Date.UTC(targetYear, targetMonth - 1, clampedDay))
}

/**
 * Adds an integer number of calendar days to a date.
 */
export function addDays(date: Date | string, days: number): Date {
  const base = parseDateOnly(date)
  base.setUTCDate(base.getUTCDate() + days)
  return base
}

/**
 * Computes calendar difference in days (d2 - d1).
 */
export function diffDays(d1: Date | string, d2: Date | string): number {
  const utc1 = parseDateOnly(d1).getTime()
  const utc2 = parseDateOnly(d2).getTime()
  return Math.round((utc2 - utc1) / (1000 * 60 * 60 * 24))
}

/**
 * Checks whether d1 is strictly before d2 in calendar dates.
 */
export function isBefore(d1: Date | string, d2: Date | string): boolean {
  return parseDateOnly(d1).getTime() < parseDateOnly(d2).getTime()
}

/**
 * Checks whether d1 is the same calendar day or before d2.
 */
export function isSameOrBefore(d1: Date | string, d2: Date | string): boolean {
  return parseDateOnly(d1).getTime() <= parseDateOnly(d2).getTime()
}

/**
 * Formats a Date object to YYYY-MM-DD.
 */
export function formatDateOnly(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// ============================================
// SCHEDULE DUE DATE GENERATORS (§2.6)
// ============================================

/**
 * Generates due dates for loan instalments:
 * Anchor: disbursement value date.
 * Instalment k (1..termMonths) is due at addMonthsClamped(anchor, k).
 */
export function generateLoanDueDates(
  disbursementValueDate: Date | string,
  termMonths: number,
): Date[] {
  if (termMonths <= 0) return []
  const dueDates: Date[] = []
  for (let k = 1; k <= termMonths; k++) {
    dueDates.push(addMonthsClamped(disbursementValueDate, k))
  }
  return dueDates
}

/**
 * Generates due dates for monthly regular savings:
 * Anchor: first confirmed deposit's value date.
 * Period i (1..n) is due at addMonthsClamped(anchor, i - 1), so period 1 is due on the start date.
 */
export function generateMonthlySavingsDueDates(
  startDate: Date | string,
  durationMonths: number,
): Date[] {
  if (durationMonths <= 0) return []
  const dueDates: Date[] = []
  for (let i = 1; i <= durationMonths; i++) {
    dueDates.push(addMonthsClamped(startDate, i - 1))
  }
  return dueDates
}

/**
 * Generates due dates for weekly regular savings:
 * Anchor: first confirmed deposit's value date.
 * Maturity date: addMonthsClamped(anchor, durationMonths).
 * Periods i = 1, 2, ... are due at anchor + 7(i - 1) days WHILE strictly before maturity date.
 */
export function generateWeeklySavingsDueDates(
  startDate: Date | string,
  durationMonths: number,
): Date[] {
  if (durationMonths <= 0) return []
  const maturityDate = addMonthsClamped(startDate, durationMonths)
  const dueDates: Date[] = []
  let i = 1

  while (true) {
    const candidate = addDays(startDate, 7 * (i - 1))
    if (!isBefore(candidate, maturityDate)) {
      break
    }
    dueDates.push(candidate)
    i++
  }

  return dueDates
}

/**
 * Generates due dates for daily regular savings:
 * Anchor: first confirmed deposit's value date.
 * Maturity date: addMonthsClamped(anchor, durationMonths).
 * Periods i = 1, 2, ... are due at anchor + (i - 1) days WHILE strictly before maturity date.
 */
export function generateDailySavingsDueDates(
  startDate: Date | string,
  durationMonths: number,
): Date[] {
  if (durationMonths <= 0) return []
  const maturityDate = addMonthsClamped(startDate, durationMonths)
  const dueDates: Date[] = []
  let i = 1

  while (true) {
    const candidate = addDays(startDate, i - 1)
    if (!isBefore(candidate, maturityDate)) {
      break
    }
    dueDates.push(candidate)
    i++
  }

  return dueDates
}

/**
 * Generates due dates for E-Ajo contribution periods:
 * Anchor: group activation start date.
 * Period k (1..totalSlots) is due at addMonthsClamped(start, k - 1).
 */
export function generateEAjoDueDates(
  groupStartDate: Date | string,
  totalSlots: number,
): Date[] {
  if (totalSlots <= 0) return []
  const dueDates: Date[] = []
  for (let k = 1; k <= totalSlots; k++) {
    dueDates.push(addMonthsClamped(groupStartDate, k - 1))
  }
  return dueDates
}
