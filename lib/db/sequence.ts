import { Prisma } from '@/generated/prisma/client'

/**
 * Serialises generation of "highest existing + 1" reference numbers
 * (PAY-, DSB-, …; see nextSequenceAfter) across concurrent transactions.
 *
 * Call it inside the transaction, immediately before reading the highest
 * existing number for `prefix`; the transaction-scoped advisory lock is held
 * until commit, so a second writer reads the number the first one inserted.
 * Every in-transaction writer of the same prefix must call it.
 */
export async function lockSequence(tx: Prisma.TransactionClient, prefix: string): Promise<void> {
  if (typeof (tx as { $executeRaw?: unknown }).$executeRaw !== 'function') return
  const key = `sequence:${prefix}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}
