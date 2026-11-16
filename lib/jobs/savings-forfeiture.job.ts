/**
 * Regular-savings lateness (P3-03, §2.5, §2.6): marks unpaid periods OVERDUE after their due
 * date and forfeits the interest of a period still unpaid at the end of day +7 (value dates,
 * review shield A-11). Idempotent and catch-up safe. P3-06 wires this into recalculateLateness().
 */
import { prisma } from '@/lib/prisma'
import { PaymentPeriodStatus, SavingsStatus, SavingsType } from '@/generated/prisma/enums'
import { lockMembers } from '@/lib/db/concurrency'
import { addDays, lagosToday, parseDateOnly } from '@/lib/domain/dates'
import {
  recalculateSavingsPeriodForfeiture,
  refreshSavingsPeriodStatus,
} from '@/lib/services/savings.service'
import type { SavingsJobOptions } from '@/lib/jobs/savings-expiry.job'

export async function runSavingsForfeitureJob(options: SavingsJobOptions = {}) {
  const db = options.db ?? prisma
  const asOf = options.asOf ?? lagosToday()
  const periods = await db.savingsPeriod.findMany({
    where: {
      dueDate: { lt: parseDateOnly(asOf) },
      status: { notIn: [PaymentPeriodStatus.COMPLETED, PaymentPeriodStatus.WAIVED] },
      savings: {
        savingsType: SavingsType.REGULAR,
        status: { in: [SavingsStatus.ACTIVE, SavingsStatus.MATURED] },
      },
    },
    select: { id: true, dueDate: true, savings: { select: { userId: true } } },
    orderBy: { dueDate: 'asc' },
  })
  const forfeitBoundary = addDays(asOf, -8)
  let forfeited = 0
  for (const p of periods) {
    await db.$transaction(async (tx) => {
      await lockMembers(tx, [p.savings.userId])
      if (p.dueDate.getTime() <= forfeitBoundary.getTime()) {
        const state = await recalculateSavingsPeriodForfeiture(tx, p.id, asOf)
        if (state === 'FORFEITED') forfeited += 1
      }
      await refreshSavingsPeriodStatus(tx, p.id, asOf)
    })
  }
  return { asOf, examined: periods.length, forfeited }
}
