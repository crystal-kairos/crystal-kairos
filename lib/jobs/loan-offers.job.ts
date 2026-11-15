import { prisma } from '@/lib/prisma'
import { LoanStatus } from '@/generated/prisma/enums'
import { expireLoanOffer } from '@/lib/services/loans.service'

/**
 * Expires loan offers (APPROVED / AWAITING_RECONSENT) whose acceptance window
 * passed, releasing their guarantee reservations (§2.7: "a declined or expired
 * offer releases any reservation").
 *
 * Pure job function for P4-04's registry: idempotent (each loan moves at most
 * once, via a conditional transition), catch-up by date (anything expired
 * before `now` is handled, however long the scheduler was down), chunked.
 */
export async function runLoanOfferExpiryJob(params: { now?: Date; batchSize?: number } = {}) {
  const now = params.now ?? new Date()
  const batchSize = params.batchSize ?? 100
  let expired = 0
  let cursor: string | undefined

  for (;;) {
    const due = await prisma.loan.findMany({
      where: {
        status: { in: [LoanStatus.APPROVED, LoanStatus.AWAITING_RECONSENT] },
        offerExpiresAt: { lt: now },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    })
    if (due.length === 0) break
    for (const { id } of due) {
      try {
        const done = await prisma.$transaction((tx) => expireLoanOffer(tx, id, now))
        if (done) expired++
      } catch (error) {
        // The member accepted (or staff acted) at the same moment: nothing to expire.
        if ((error as { code?: string })?.code !== 'STALE_STATE') throw error
      }
    }
    cursor = due[due.length - 1].id
  }
  return { expired }
}
