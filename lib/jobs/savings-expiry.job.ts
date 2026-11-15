/**
 * Savings first-deposit expiry (P3-03, A-05). A PENDING plan with no receipt in review after
 * `savingsFirstDepositWindowDays` (default 14) is CANCELLED. Idempotent and catch-up safe:
 * it can run any number of times on any date. The scheduler/registry is P4-04.
 */
import { prisma } from '@/lib/prisma'
import { SavingsStatus } from '@/generated/prisma/enums'
import { lockMembers } from '@/lib/db/concurrency'
import { lagosToday } from '@/lib/domain/dates'
import { getSocietySetting } from '@/lib/services/society-settings.service'
import { expirePendingSavingsPlan, type SavingsNotice } from '@/lib/services/savings.service'
import { deliverSavingsNotices, type SavingsNotifier } from '@/lib/services/savings-notifications'

export interface SavingsJobOptions {
  asOf?: string // Lagos calendar date YYYY-MM-DD
  db?: typeof prisma
  notify?: SavingsNotifier
}

export async function runSavingsExpiryJob(options: SavingsJobOptions = {}) {
  const db = options.db ?? prisma
  const asOf = options.asOf ?? lagosToday()
  // ASSUMPTION A-05: 14-day window, configurable.
  const windowDays = await getSocietySetting('savingsFirstDepositWindowDays')
  const candidates = await db.savings.findMany({
    where: { status: SavingsStatus.PENDING },
    select: { id: true, userId: true },
  })
  const notices: SavingsNotice[] = []
  for (const c of candidates) {
    const notice = await db.$transaction(async (tx) => {
      await lockMembers(tx, [c.userId])
      return expirePendingSavingsPlan(tx, c.id, { asOf, windowDays })
    })
    if (notice) notices.push(notice)
  }
  await deliverSavingsNotices(notices, options.notify)
  return { asOf, examined: candidates.length, cancelled: notices.length }
}
