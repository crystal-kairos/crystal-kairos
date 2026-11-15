import { prisma } from '@/lib/prisma'
import { EAjoMemberStatus, EAjoPayoutStatus } from '@/generated/prisma/enums'
import { lockMembers } from '@/lib/db/concurrency'
import { lagosToday } from '@/lib/domain/dates'
import { refreshEAjoParticipant } from '@/lib/services/eajo.service'

/**
 * E-ajo payout-eligibility job (PR P3-05, §2.8 rule 4, A-09).
 *
 * Pure job function: idempotent and catch-up safe (it only derives state from the participant's
 * periods for `today`), callable from tests and — from P4-04 — from the scheduler registry.
 * Payment confirmation already re-evaluates eligibility immediately; this job catches the
 * date-driven change (the payout month being reached) and reverts ELIGIBLE → NOT_ELIGIBLE if a
 * reversal or new penalty undid the conditions.
 */
export async function runPayoutEligibilityJob(
  options: { today?: string; groupId?: string; db?: typeof prisma } = {},
) {
  const db = options.db ?? prisma
  const today = options.today ?? lagosToday()

  const candidates = await db.eAjoMember.findMany({
    where: {
      status: EAjoMemberStatus.ACTIVE,
      ...(options.groupId ? { groupId: options.groupId } : {}),
      payout: { status: { in: [EAjoPayoutStatus.NOT_ELIGIBLE, EAjoPayoutStatus.ELIGIBLE, EAjoPayoutStatus.PAID] } },
    },
    select: { id: true, userId: true },
    orderBy: { createdAt: 'asc' },
  })

  let becameEligible = 0
  let becameNotEligible = 0
  let completed = 0
  for (const c of candidates) {
    const res = await db.$transaction(async (tx) => {
      await lockMembers(tx, [c.userId])
      return refreshEAjoParticipant(tx, c.id, { today })
    })
    if (res.eligibilityChanged) {
      if (res.payoutStatus === EAjoPayoutStatus.ELIGIBLE) becameEligible++
      else becameNotEligible++
    }
    if (res.completed) completed++
  }

  return { today, checked: candidates.length, becameEligible, becameNotEligible, completed }
}
