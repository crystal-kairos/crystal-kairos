import { beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { PasswordSetupTokenPurpose, UserRole } from '@/generated/prisma/enums'

const mockSessionHolder = {
  session: null as { user?: { id: string; email: string; role: UserRole } } | null,
}

vi.mock('@/models/members/actions', () => ({
  getSessionHelper: vi.fn(async () => mockSessionHolder.session),
}))

import {
  consumePasswordSetupTokenAndSetPassword,
  hashOpaqueToken,
  issuePasswordSetupToken,
  MAX_TOKENS_PER_ACCOUNT_WINDOW,
  TokenError,
  verifyPasswordSetupToken,
} from '@/lib/authz/tokens'
import { POST as signUserRoutePost, GET as signUserRouteGet } from '@/app/api/sign-user/route'
import { signUser } from '@/models/auth/query'

interface InMemoryUser {
  id: string
  email: string
  name: string
  role: UserRole
  passwordHash: string | null
  hasSetPassword: boolean
}

interface InMemoryToken {
  id: string
  userId: string
  tokenHash: string
  purpose: PasswordSetupTokenPurpose
  expiresAt: Date
  usedAt: Date | null
  requestedIp: string | null
  createdById: string | null
  createdAt: Date
}

function createInMemoryDb() {
  const users = new Map<string, InMemoryUser>()
  const tokens = new Map<string, InMemoryToken>()
  let seq = 1

  const db = {
    users,
    tokens,
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.id) return users.get(where.id) ?? null
        if (where.email) {
          for (const u of users.values()) {
            if (u.email === where.email) return u
          }
        }
        return null
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string }
          data: Partial<InMemoryUser>
        }) => {
          const existing = users.get(where.id)
          if (!existing) throw new Error('User not found')
          const updated: InMemoryUser = { ...existing, ...data }
          users.set(where.id, updated)
          return updated
        },
      ),
    },
    passwordSetupToken: {
      count: vi.fn(
        async ({
          where,
        }: {
          where: {
            userId?: string
            purpose?: PasswordSetupTokenPurpose
            requestedIp?: string
            createdAt?: { gte: Date }
          }
        }) => {
          let count = 0
          for (const tok of tokens.values()) {
            if (where.userId && tok.userId !== where.userId) continue
            if (where.purpose && tok.purpose !== where.purpose) continue
            if (where.requestedIp && tok.requestedIp !== where.requestedIp) continue
            if (where.createdAt?.gte && tok.createdAt < where.createdAt.gte) continue
            count += 1
          }
          return count
        },
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: Omit<InMemoryToken, 'id' | 'usedAt'> & { usedAt?: Date | null }
        }) => {
          const record: InMemoryToken = {
            id: `token-${seq++}`,
            userId: data.userId,
            tokenHash: data.tokenHash,
            purpose: data.purpose,
            expiresAt: data.expiresAt,
            usedAt: data.usedAt ?? null,
            requestedIp: data.requestedIp ?? null,
            createdById: data.createdById ?? null,
            createdAt: data.createdAt,
          }
          tokens.set(record.id, record)
          return record
        },
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { tokenHash?: string; id?: string } }) => {
          for (const tok of tokens.values()) {
            if (where.tokenHash && tok.tokenHash === where.tokenHash) {
              const user = users.get(tok.userId) ?? null
              return { ...tok, user }
            }
            if (where.id && tok.id === where.id) {
              const user = users.get(tok.userId) ?? null
              return { ...tok, user }
            }
          }
          return null
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: {
            id?: string
            userId?: string
            purpose?: PasswordSetupTokenPurpose
            usedAt?: Date | null
            expiresAt?: { gt: Date }
          }
          data: Partial<InMemoryToken>
        }) => {
          let count = 0
          for (const [id, tok] of tokens.entries()) {
            if (where.id && tok.id !== where.id) continue
            if (where.userId && tok.userId !== where.userId) continue
            if (where.purpose && tok.purpose !== where.purpose) continue
            if (where.usedAt === null && tok.usedAt !== null) continue
            if (where.expiresAt?.gt && tok.expiresAt <= where.expiresAt.gt) continue
            tokens.set(id, { ...tok, ...data })
            count += 1
          }
          return { count }
        },
      ),
    },
    $transaction: vi.fn(async <T>(fn: (tx: typeof db) => Promise<T>): Promise<T> => {
      return fn(db)
    }),
  }

  return db
}

describe('password setup & identity-token issuance integration (P1-02)', () => {
  const fixedNow = new Date('2026-10-20T12:00:00.000Z')
  let memDb: ReturnType<typeof createInMemoryDb>

  beforeEach(() => {
    memDb = createInMemoryDb()
    mockSessionHolder.session = null

    memDb.users.set('member-1', {
      id: 'member-1',
      email: 'member1@crystalkairos.coop',
      name: 'Adaobi Okafor',
      role: UserRole.USER,
      passwordHash: null,
      hasSetPassword: false,
    })

    memDb.users.set('member-active', {
      id: 'member-active',
      email: 'active@crystalkairos.coop',
      name: 'Bola Tinubu',
      role: UserRole.USER,
      passwordHash: '$2a$12$existinghashvalue',
      hasSetPassword: true,
    })
  })

  it('blocks public /api/sign-user POST and GET endpoints from issuing or verifying tokens', async () => {
    const postRes = await signUserRoutePost()
    expect(postRes.status).toBe(403)
    const postBody = await postRes.json()
    expect(postBody.success).toBe(false)
    expect(postBody.token).toBeUndefined()

    const getRes = await signUserRouteGet()
    expect(getRes.status).toBe(403)
    const getBody = await getRes.json()
    expect(getBody.success).toBe(false)
  })

  it('rejects signUser calls from unauthenticated callers or regular members trying to sign another user', async () => {
    // Unauthenticated caller
    mockSessionHolder.session = null
    const anonResult = await signUser('member-1', 'member1@crystalkairos.coop')
    expect(anonResult.success).toBe(false)
    expect(anonResult.token).toBeUndefined()

    // Authenticated regular member attempting to issue a token for another account
    mockSessionHolder.session = {
      user: {
        id: 'member-active',
        email: 'active@crystalkairos.coop',
        role: UserRole.USER,
      },
    }
    const memberResult = await signUser('member-1', 'member1@crystalkairos.coop')
    expect(memberResult.success).toBe(false)
    expect(memberResult.token).toBeUndefined()
  })

  it('stores only SHA-256 token hashes and verifies + consumes a token once, hashing the password', async () => {
    const issued = await issuePasswordSetupToken(
      {
        userId: 'member-1',
        purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
        requestedIp: '203.0.113.42',
        createdById: 'admin-1',
        now: fixedNow,
      },
      memDb as never,
    )

    // Raw token is never stored in DB; only its SHA-256 hash
    const storedRecord = memDb.tokens.get(issued.tokenId)!
    expect(storedRecord.tokenHash).toBe(hashOpaqueToken(issued.rawToken))
    expect(storedRecord.tokenHash).not.toBe(issued.rawToken)
    expect(storedRecord.requestedIp).not.toBe('203.0.113.42')

    const verified = await verifyPasswordSetupToken(
      {
        rawToken: issued.rawToken,
        purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
        now: new Date(fixedNow.getTime() + 60_000),
      },
      memDb as never,
    )
    expect(verified.userId).toBe('member-1')
    expect(verified.userEmail).toBe('member1@crystalkairos.coop')

    const plainPassword = 'StrongCooperativePassword!2026'
    const passwordHash = await bcrypt.hash(plainPassword, 10)

    const consumed = await consumePasswordSetupTokenAndSetPassword(
      {
        rawToken: issued.rawToken,
        email: 'member1@crystalkairos.coop',
        passwordHash,
        purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
        now: new Date(fixedNow.getTime() + 120_000),
      },
      memDb as never,
    )

    expect(consumed.userId).toBe('member-1')

    const updatedUser = memDb.users.get('member-1')!
    expect(updatedUser.hasSetPassword).toBe(true)
    expect(updatedUser.passwordHash).toBe(passwordHash)
    expect(updatedUser.passwordHash).not.toBe(plainPassword)
    expect(await bcrypt.compare(plainPassword, updatedUser.passwordHash!)).toBe(true)

    // Reusing the same token a second time must fail
    await expect(
      consumePasswordSetupTokenAndSetPassword(
        {
          rawToken: issued.rawToken,
          email: 'member1@crystalkairos.coop',
          passwordHash,
          purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
          now: new Date(fixedNow.getTime() + 180_000),
        },
        memDb as never,
      ),
    ).rejects.toThrowError(TokenError)
  })

  it('rejects accounts that already have hasSetPassword=true from issuing or consuming SET_PASSWORD tokens', async () => {
    await expect(
      issuePasswordSetupToken(
        {
          userId: 'member-active',
          purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
          now: fixedNow,
        },
        memDb as never,
      ),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_ELIGIBLE',
    })

    // Even if a token was issued before the account set its password, consuming it after hasSetPassword=true fails
    const issued = await issuePasswordSetupToken(
      {
        userId: 'member-1',
        purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
        now: fixedNow,
      },
      memDb as never,
    )

    memDb.users.get('member-1')!.hasSetPassword = true

    await expect(
      consumePasswordSetupTokenAndSetPassword(
        {
          rawToken: issued.rawToken,
          email: 'member1@crystalkairos.coop',
          passwordHash: '$2a$12$anotherhash',
          purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
          now: new Date(fixedNow.getTime() + 5_000),
        },
        memDb as never,
      ),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_ELIGIBLE',
    })
  })

  it('rejects wrong-email, wrong-purpose, and expired tokens during consumption', async () => {
    const issued = await issuePasswordSetupToken(
      {
        userId: 'member-1',
        purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
        ttlMs: 10_000,
        now: fixedNow,
      },
      memDb as never,
    )

    // Wrong email supplied for valid token
    await expect(
      consumePasswordSetupTokenAndSetPassword(
        {
          rawToken: issued.rawToken,
          email: 'someone-else@crystalkairos.coop',
          passwordHash: '$2a$12$hash',
          purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
          now: new Date(fixedNow.getTime() + 1_000),
        },
        memDb as never,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_OR_EXPIRED_TOKEN',
    })

    // Wrong purpose
    await expect(
      consumePasswordSetupTokenAndSetPassword(
        {
          rawToken: issued.rawToken,
          email: 'member1@crystalkairos.coop',
          passwordHash: '$2a$12$hash',
          purpose: PasswordSetupTokenPurpose.RESET_PASSWORD,
          now: new Date(fixedNow.getTime() + 1_000),
        },
        memDb as never,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_OR_EXPIRED_TOKEN',
    })

    // Expired token
    await expect(
      consumePasswordSetupTokenAndSetPassword(
        {
          rawToken: issued.rawToken,
          email: 'member1@crystalkairos.coop',
          passwordHash: '$2a$12$hash',
          purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
          now: new Date(fixedNow.getTime() + 10_001),
        },
        memDb as never,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_OR_EXPIRED_TOKEN',
    })
  })

  it('enforces per-account rate limiting on token issuance', async () => {
    for (let i = 0; i < MAX_TOKENS_PER_ACCOUNT_WINDOW; i++) {
      await issuePasswordSetupToken(
        {
          userId: 'member-1',
          purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
          now: new Date(fixedNow.getTime() + i * 1_000),
        },
        memDb as never,
      )
    }

    await expect(
      issuePasswordSetupToken(
        {
          userId: 'member-1',
          purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
          now: new Date(fixedNow.getTime() + 10_000),
        },
        memDb as never,
      ),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    })
  })
})
