import { UserRole } from '../generated/prisma/enums'
import { prisma } from '../lib/prisma'

export interface InvariantCheckResult {
  valid: boolean
  violations: string[]
}

/**
 * Checks database invariants required by the Crystal Kairos security & domain specification:
 * - D-15: No user with role OWNER or ADMIN may hold Membership, Savings, Loan, EAjoMember, or EAjo records.
 * - At most one user may hold role OWNER.
 */
export async function checkSystemInvariants(
  db: typeof prisma = prisma,
): Promise<InvariantCheckResult> {
  const violations: string[] = []

  const staffUsers = await db.user.findMany({
    where: {
      role: {
        in: [UserRole.OWNER, UserRole.ADMIN],
      },
    },
    select: {
      id: true,
      email: true,
      role: true,
      membership: { select: { id: true } },
      savings: { select: { id: true }, take: 1 },
      loans: { select: { id: true }, take: 1 },
      eAjoMembers: { select: { id: true }, take: 1 },
      eAjo: { select: { id: true }, take: 1 },
    },
  })

  const ownerCount = staffUsers.filter((u) => u.role === UserRole.OWNER).length
  if (ownerCount > 1) {
    violations.push(
      `Multiple OWNER accounts found (${ownerCount}). At most one OWNER is permitted.`,
    )
  }

  for (const staff of staffUsers) {
    if (staff.membership) {
      violations.push(
        `D-15 violation: Staff user ${staff.email} (${staff.role}) has a Membership record (${staff.membership.id}).`,
      )
    }
    if (staff.savings.length > 0) {
      violations.push(
        `D-15 violation: Staff user ${staff.email} (${staff.role}) has Savings record(s).`,
      )
    }
    if (staff.loans.length > 0) {
      violations.push(
        `D-15 violation: Staff user ${staff.email} (${staff.role}) has Loan record(s).`,
      )
    }
    if (staff.eAjoMembers.length > 0 || staff.eAjo.length > 0) {
      violations.push(
        `D-15 violation: Staff user ${staff.email} (${staff.role}) has E-Ajo record(s).`,
      )
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  }
}

async function main() {
  const result = await checkSystemInvariants()
  if (!result.valid) {
    console.error('Invariant check failed:')
    for (const v of result.violations) {
      console.error(`  - ${v}`)
    }
    process.exit(1)
  }
  console.log('All system invariants passed.')
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/check-invariants.ts')

if (isDirectExecution) {
  main().catch((error) => {
    console.error(
      'Invariant check error:',
      error instanceof Error ? error.message : error,
    )
    process.exit(1)
  })
}
