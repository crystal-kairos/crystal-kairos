import { Prisma } from '@/generated/prisma/client'
import { AppError } from '@/lib/errors/app-error'

/**
 * Concurrency primitives (PR P2-02, §2.12):
 * Takes transaction-scoped PostgreSQL advisory locks on one or more member IDs
 * in strictly sorted lexicographical order to prevent concurrent race conditions
 * and deadlocks across borrowers, guarantors, and wallet owners.
 */
export async function lockMembers(
  tx: Prisma.TransactionClient,
  memberIds: string[],
): Promise<void> {
  if (typeof (tx as any)?.$executeRaw !== 'function') {
    return
  }
  const filtered = memberIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
  const uniqueSorted = [...new Set(filtered)].sort()

  for (const id of uniqueSorted) {
    const lockKey = `member:${id}`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
  }
}

/**
 * Atomic state machine transition helper (PR P2-02, §2.12):
 * Atomically updates an entity's status from one or more acceptable source statuses
 * to a target status. If another concurrent process has already transitioned the entity,
 * updateMany returns count === 0 and this function throws STALE_STATE.
 */
export async function transition<T extends { updateMany: (args: any) => Promise<{ count: number }> }>(
  model: T,
  id: string,
  from: string | string[],
  data: object,
  errorMessage = 'This record was already changed. Refresh and try again.',
): Promise<void> {
  const fromArray = Array.isArray(from) ? from : [from]
  const res = await model.updateMany({
    where: {
      id,
      status: { in: fromArray },
    },
    data,
  })

  if (res.count !== 1) {
    throw new AppError('STALE_STATE', errorMessage, { statusCode: 409 })
  }
}

/**
 * Retries a database transaction function if Prisma raises error code P2034
 * (Transaction failed due to a write conflict or a deadlock under Serializable isolation).
 */
export async function runWithSerializableRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delayMs = 50,
): Promise<T> {
  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (error: any) {
      attempt++
      const isPrismaConflict =
        error?.code === 'P2034' ||
        error?.message?.includes('could not serialize access') ||
        error?.message?.includes('deadlock detected')

      if (isPrismaConflict && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt))
        continue
      }
      throw error
    }
  }
}
