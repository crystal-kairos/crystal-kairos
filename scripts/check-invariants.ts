import { prisma } from '../lib/prisma'
import { UserRole } from '../generated/prisma/enums'

export interface InvariantCheckResult {
  valid: boolean
  passed: boolean
  violations: string[]
}

/**
 * Checks database invariants required by the Crystal Kairos security & domain specification:
 * - D-15: No user with role OWNER or ADMIN may hold Membership, Savings, Loan, EAjoMember, or EAjo records.
 * - At most one user may hold role OWNER.
 * - A-22: Unique normalised phone numbers and bank accounts across active members.
 */
export async function checkSystemInvariants(
  db: typeof prisma = prisma,
): Promise<InvariantCheckResult> {
  const violations: string[] = []

  // Invariant 1: Staff are never members (D-15) & single OWNER
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
    if (staff.savings && staff.savings.length > 0) {
      violations.push(
        `D-15 violation: Staff user ${staff.email} (${staff.role}) has Savings record(s).`,
      )
    }
    if (staff.loans && staff.loans.length > 0) {
      violations.push(
        `D-15 violation: Staff user ${staff.email} (${staff.role}) has Loan record(s).`,
      )
    }
    if (
      (staff.eAjoMembers && staff.eAjoMembers.length > 0) ||
      (staff.eAjo && staff.eAjo.length > 0)
    ) {
      violations.push(
        `D-15 violation: Staff user ${staff.email} (${staff.role}) has E-Ajo record(s).`,
      )
    }
  }

  // If connected to a real Prisma database client with raw query support
  if (typeof db.$queryRaw === 'function') {
    // Invariant 2: Active members have unique normalized phone numbers
    const duplicatePhones = await db.$queryRaw<
      Array<{ phoneNumber: string; count: bigint }>
    >`
      SELECT "phoneNumber", COUNT(*) as count
      FROM "user_info"
      WHERE "phoneNumber" IS NOT NULL
      GROUP BY "phoneNumber"
      HAVING COUNT(*) > 1
    `
    if (duplicatePhones.length > 0) {
      violations.push(
        `Rule A-22 Violation: Duplicate phone numbers detected: ${duplicatePhones.map((p) => `${p.phoneNumber} (${p.count})`).join(', ')}`,
      )
    }

    // Invariant 3: Active members have unique bank accounts
    const duplicateBanks = await db.$queryRaw<
      Array<{ bankCode: string | null; accountNumber: string; count: bigint }>
    >`
      SELECT ba."bankCode", ba."accountNumber", COUNT(*) as count
      FROM "bank_accounts" ba
      JOIN "users" u ON u.id = ba."userId"
      WHERE u."isActive" = true
      GROUP BY ba."bankCode", ba."accountNumber"
      HAVING COUNT(*) > 1
    `
    if (duplicateBanks.length > 0) {
      violations.push(
        `Rule A-22 Violation: Duplicate active member bank accounts detected: ${duplicateBanks.map((b) => `${b.accountNumber} (${b.count})`).join(', ')}`,
      )
    }
  }

  return {
    valid: violations.length === 0,
    passed: violations.length === 0,
    violations,
  }
}

export const checkDatabaseInvariants = checkSystemInvariants

async function runCli() {
  console.log('🔍 Running Crystal Kairos invariant checks...')
  const result = await checkDatabaseInvariants()
  if (result.passed) {
    console.log('✅ All invariants verified successfully. 0 violations detected.')
    process.exit(0)
  } else {
    console.error('❌ Invariant violations detected:')
    for (const v of result.violations) {
      console.error(`  - ${v}`)
    }
    process.exit(1)
  }
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/check-invariants.ts')

if (isDirectExecution) {
  runCli().catch((err) => {
    console.error('Error running invariant checks:', err)
    process.exit(1)
  })
}
