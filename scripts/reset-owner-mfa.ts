import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { prisma } from '../lib/prisma'
import { UserRole } from '../generated/prisma/enums'
import { resetUserMfa } from '../lib/authz/mfa'

export async function resetOwnerMfa(ownerEmail: string, db: typeof prisma = prisma) {
  const normalized = ownerEmail.trim().toLowerCase()
  const user = await db.user.findUnique({
    where: { email: normalized },
    select: { id: true, email: true, name: true, role: true, mfaEnabled: true },
  })

  if (!user) {
    throw new Error(`User with email "${normalized}" not found.`)
  }

  if (user.role !== UserRole.OWNER) {
    throw new Error(`User "${normalized}" is not an OWNER. This script is strictly for owner emergency resets.`)
  }

  await resetUserMfa(user.id, 'CLI_SCRIPT', db)
  return user
}

async function main() {
  const rl = readline.createInterface({ input, output })

  try {
    console.log('--- Crystal Kairos: Emergency Owner MFA Reset ---')
    const email = await rl.question('Enter Owner Email: ')

    if (!email || !email.trim()) {
      console.error('Email is required.')
      process.exit(1)
    }

    const confirm = await rl.question(
      `Are you sure you want to reset MFA for owner ${email.trim()}? (yes/no): `,
    )

    if (confirm.trim().toLowerCase() !== 'yes') {
      console.log('Operation aborted.')
      process.exit(0)
    }

    const owner = await resetOwnerMfa(email)
    console.log(`\nSuccess: MFA has been reset for OWNER "${owner.name}" (${owner.email}).`)
    console.log('All active sessions for this account have been invalidated (sessionVersion bumped).')
    console.log('The owner will be prompted to enrol in MFA upon their next login.\n')
  } catch (error) {
    console.error('\nError resetting owner MFA:', error instanceof Error ? error.message : error)
    process.exit(1)
  } finally {
    rl.close()
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  void main()
}
