/**
 * Monthly savings interest accrual (P3-03, §2.5, D-17, A-07). Posts, for every month end and
 * maturity date on/before `asOf`, the linear accrual of each interest-bearing lot
 * (Dr SAVINGS_INTEREST_EXPENSE / Cr SAVINGS_INTEREST_PAYABLE). Safe to run daily: dates already
 * posted are skipped (unique lot+date, journal idempotency key) and missed months are back-filled.
 * Only calculates and posts accruals; it never moves money between member accounts.
 */
import { prisma } from '@/lib/prisma'
import { SavingsStatus } from '@/generated/prisma/enums'
import { lockMembers } from '@/lib/db/concurrency'
import { lagosToday } from '@/lib/domain/dates'
import { accrueSavingsPlanInterest } from '@/lib/services/savings.service'
import type { SavingsJobOptions } from '@/lib/jobs/savings-expiry.job'

export async function runSavingsAccrualJob(options: SavingsJobOptions = {}) {
  const db = options.db ?? prisma
  const asOf = options.asOf ?? lagosToday()
  const plans = await db.savings.findMany({
    where: { status: { in: [SavingsStatus.ACTIVE, SavingsStatus.MATURED] }, startDate: { not: null } },
    select: { id: true, userId: true },
  })
  let postings = 0
  for (const p of plans) {
    const res = await db.$transaction(async (tx) => {
      await lockMembers(tx, [p.userId])
      return accrueSavingsPlanInterest(tx, p.id, asOf)
    })
    postings += res.postings
  }
  return { asOf, plans: plans.length, postings }
}
