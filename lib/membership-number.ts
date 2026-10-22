import { prisma } from '@/lib/prisma'

export const MEMBERSHIP_NUMBER_PREFIX = 'CK-'

/**
 * Formats a numeric sequence into the canonical Crystal Kairos membership number:
 * e.g. 1 -> "CK-000001", 42 -> "CK-000042".
 */
export function formatMembershipNumber(sequence: number): string {
  if (sequence < 1) sequence = 1
  return `${MEMBERSHIP_NUMBER_PREFIX}${String(sequence).padStart(6, '0')}`
}

/**
 * Parses the numeric portion of a canonical membership number ("CK-000042" -> 42).
 * Returns null if the format does not match.
 */
export function parseMembershipNumber(numberString: string): number | null {
  const match = numberString.trim().match(/^CK-(\d+)$/)
  if (!match) return null
  const parsed = parseInt(match[1], 10)
  return isNaN(parsed) ? null : parsed
}

/**
 * Finds the highest assigned CK- membership number in the database and returns
 * the next sequential membership number.
 */
export async function getNextMembershipNumber(
  db: typeof prisma = prisma,
): Promise<string> {
  const latestMember = await db.membership.findFirst({
    where: {
      membershipNumber: {
        startsWith: MEMBERSHIP_NUMBER_PREFIX,
      },
    },
    orderBy: {
      membershipNumber: 'desc',
    },
    select: {
      membershipNumber: true,
    },
  })

  let nextSequence = 1
  if (latestMember?.membershipNumber) {
    const parsed = parseMembershipNumber(latestMember.membershipNumber)
    if (parsed !== null) {
      nextSequence = parsed + 1
    }
  }

  return formatMembershipNumber(nextSequence)
}

/**
 * Assigns a unique membership number using a retry loop in case of race collisions.
 * Calls the provided update or create callback with the candidate membership number.
 * If a unique constraint violation occurs on `membershipNumber`, it retries with the next number.
 */
export async function assignMembershipNumberWithRetry<T>(
  actionFn: (membershipNumber: string) => Promise<T>,
  db: typeof prisma = prisma,
  maxRetries = 5,
): Promise<{ membershipNumber: string; result: T }> {
  let attempts = 0
  let candidate = await getNextMembershipNumber(db)

  while (attempts < maxRetries) {
    try {
      const result = await actionFn(candidate)
      return { membershipNumber: candidate, result }
    } catch (err: unknown) {
      const errorObj = err as { code?: string; meta?: { target?: string[] } }
      // Prisma unique constraint violation code is P2002
      const isTargetMembershipNumber =
        errorObj?.meta?.target &&
        (Array.isArray(errorObj.meta.target)
          ? errorObj.meta.target.includes('membershipNumber')
          : String(errorObj.meta.target).includes('membershipNumber'))

      if (errorObj?.code === 'P2002' || isTargetMembershipNumber) {
        attempts++
        // Try the next number sequentially
        const currentSeq = parseMembershipNumber(candidate) ?? 1
        candidate = formatMembershipNumber(currentSeq + 1)
        continue
      }
      throw err
    }
  }

  throw new Error(
    `Failed to assign unique membership number after ${maxRetries} attempts.`,
  )
}

/**
 * Synchronous / legacy fallback helper.
 * If sequence is given, formats as CK-XXXXXX. Otherwise generates next or initial CK-000001.
 */
export const generateMembershipNumber = (sequence?: number) => {
  if (typeof sequence === 'number') {
    return formatMembershipNumber(sequence)
  }
  return formatMembershipNumber(1)
}
