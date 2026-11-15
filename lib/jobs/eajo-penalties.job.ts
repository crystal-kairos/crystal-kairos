import { prisma } from '@/lib/prisma'
import { EAjoMemberStatus } from '@/generated/prisma/enums'
import { lockMembers } from '@/lib/db/concurrency'
import { lagosToday } from '@/lib/domain/dates'
import { accrueEAjoPenaltiesForParticipant, lastCompletedLagosDay } from '@/lib/services/eajo.service'

/**
 * Daily e-ajo late-payment penalty job (PR P3-05, §2.3). Calculation-only automation: it accrues
 * penalties, it never moves money between a member's accounts.
 *
 * Catch-up by date: every missing day from day +8 to `throughDate` (default: yesterday in Lagos)
 * is assessed, so a missed run is back-filled. Safe to re-run: accruals are unique per
 * (period, date) and journal entries are idempotent. P4-04 wraps this in the registry/leases;
 * P3-06 wires it into `recalculateLateness()`.
 */
export async function runEAjoPenaltyJob(
  options: { today?: string; throughDate?: string; groupId?: string; db?: typeof prisma } = {},
) {
  const db = options.db ?? prisma
  const today = options.today ?? lagosToday()
  const throughDate = options.throughDate ?? lastCompletedLagosDay(today)

  const participants = await db.eAjoMember.findMany({
    where: { status: EAjoMemberStatus.ACTIVE, ...(options.groupId ? { groupId: options.groupId } : {}) },
    select: { id: true, userId: true },
    orderBy: { createdAt: 'asc' },
  })

  let accruals = 0
  for (const p of participants) {
    const res = await db.$transaction(async (tx) => {
      await lockMembers(tx, [p.userId])
      return accrueEAjoPenaltiesForParticipant(tx, { eajoMemberId: p.id, throughDate, today })
    })
    accruals += res.accrued
  }
  return { throughDate, participants: participants.length, accruals }
}
