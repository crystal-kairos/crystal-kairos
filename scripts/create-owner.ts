import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { hash } from 'bcryptjs'
import { prisma } from '../lib/prisma'
import { UserRole } from '../generated/prisma/enums'

export interface BootstrapOwnerInput {
  name: string
  email: string
  password: string
}

export async function bootstrapInitialOwner(
  params: BootstrapOwnerInput,
  db: typeof prisma = prisma,
) {
  const trimmedName = params.name.trim()
  const trimmedEmail = params.email.trim().toLowerCase()
  const password = params.password

  if (!trimmedName) {
    throw new Error('Owner name is required.')
  }

  if (!trimmedEmail || !trimmedEmail.includes('@')) {
    throw new Error('A valid owner email address is required.')
  }

  if (!password || password.trim().length < 10) {
    throw new Error('Owner password must be at least 10 characters long.')
  }

  if (password.trim().toLowerCase() === trimmedEmail) {
    throw new Error('Owner password must not match the email address.')
  }

  const existingOwnerCount = await db.user.count({
    where: { role: UserRole.OWNER },
  })

  if (existingOwnerCount > 0) {
    throw new Error(
      'An OWNER account already exists. Refusing to create a second owner via bootstrap.',
    )
  }

  const existingEmail = await db.user.findUnique({
    where: { email: trimmedEmail },
    select: { id: true },
  })

  if (existingEmail) {
    throw new Error('A user with this email address already exists.')
  }

  const passwordHash = await hash(password, 12)

  return db.user.create({
    data: {
      name: trimmedName,
      email: trimmedEmail,
      role: UserRole.OWNER,
      passwordHash,
      hasSetPassword: true,
      mfaEnabled: true,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
    },
  })
}

async function main() {
  const rl = readline.createInterface({ input, output })
  try {
    const name =
      process.env.BOOTSTRAP_OWNER_NAME ||
      (await rl.question('Owner full name: '))
    const email =
      process.env.BOOTSTRAP_OWNER_EMAIL ||
      (await rl.question('Owner email address: '))
    const password =
      process.env.BOOTSTRAP_OWNER_PASSWORD ||
      (await rl.question('Owner password (min 10 chars): '))

    const created = await bootstrapInitialOwner({ name, email, password })
    console.log(
      `Successfully created initial OWNER account: ${created.name} <${created.email}> (${created.id})`,
    )
  } finally {
    rl.close()
    await prisma.$disconnect()
  }
}

if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].endsWith('create-owner.ts')
) {
  main().catch((error) => {
    console.error(
      'Failed to bootstrap owner:',
      error instanceof Error ? error.message : error,
    )
    process.exit(1)
  })
}
