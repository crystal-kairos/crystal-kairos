/**
 * Savings maturity (P3-03, A-08): ACTIVE plans whose maturity date is on/before `asOf` become
 * MATURED after their accrual is completed up to maturity. No rollover, no automatic payout.
 * Idempotent and catch-up safe.
 */
import { prisma } from '@/lib/prisma'
import { SavingsStatus } from '@/generated/prisma/enums'
import { lockMembers } from '@/lib/db/concurrency'
import { lagosToday, parseDateOnly } from '@/lib/domain/dates'
import { matureSavingsPlan, type SavingsNotice } from '@/lib/services/savings.service'
import { deliverSavingsNotices } from '@/lib/services/savings-notifications'
import type { SavingsJobOptions } from '@/lib/jobs/savings-expiry.job'

export async function runSavingsMaturityJob(options: SavingsJobOptions = {}) {
  const db = options.db ?? prisma
  const asOf = options.asOf ?? lagosToday()
  const candidates = await db.savings.findMany({
    where: { status: SavingsStatus.ACTIVE, maturityDate: { lte: parseDateOnly(asOf) } },
    select: { id: true, userId: true },
  })
  const notices: SavingsNotice[] = []
  for (const c of candidates) {
    const notice = await db.$transaction(async (tx) => {
      await lockMembers(tx, [c.userId])
      return matureSavingsPlan(tx, c.id, asOf)
    })
    if (notice) notices.push(notice)
  }
  await deliverSavingsNotices(notices, options.notify)
  return { asOf, matured: notices.length }
}
