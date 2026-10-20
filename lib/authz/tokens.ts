import crypto from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { PasswordSetupTokenPurpose } from '@/generated/prisma/enums'

export const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour
export const MAX_TOKENS_PER_ACCOUNT_WINDOW = 5
export const MAX_TOKENS_PER_IP_WINDOW = 20
export const TOKEN_BYTE_LENGTH = 32

export type TokenErrorCode =
  | 'INVALID_OR_EXPIRED_TOKEN'
  | 'ACCOUNT_NOT_ELIGIBLE'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'

export class TokenError extends Error {
  readonly code: TokenErrorCode

  constructor(code: TokenErrorCode, message: string) {
    super(message)
    this.name = 'TokenError'
    this.code = code
  }
}

export function hashOpaqueToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken.trim()).digest('hex')
}

export function hashClientIp(ip: string | null | undefined): string | null {
  if (!ip || !ip.trim()) return null
  return crypto.createHash('sha256').update(`ip:${ip.trim()}`).digest('hex')
}

export function generateOpaqueToken(byteLength = TOKEN_BYTE_LENGTH): {
  rawToken: string
  tokenHash: string
} {
  if (byteLength < 16) {
    throw new Error('Token byte length must be at least 16 bytes.')
  }
  const rawToken = crypto.randomBytes(byteLength).toString('base64url')
  const tokenHash = hashOpaqueToken(rawToken)
  return { rawToken, tokenHash }
}

export interface TokenRecordSnapshot {
  id: string
  userId: string
  tokenHash: string
  purpose: PasswordSetupTokenPurpose | 'SET_PASSWORD' | 'RESET_PASSWORD'
  expiresAt: Date
  usedAt: Date | null
}

export function evaluateTokenRecord(
  record: TokenRecordSnapshot | null | undefined,
  options: {
    now?: Date
    expectedPurpose?: PasswordSetupTokenPurpose | 'SET_PASSWORD' | 'RESET_PASSWORD'
    expectedUserId?: string
    userHasSetPassword?: boolean
  } = {},
): TokenRecordSnapshot {
  const now = options.now ?? new Date()
  const expectedPurpose =
    options.expectedPurpose ?? PasswordSetupTokenPurpose.SET_PASSWORD

  if (!record || record.usedAt !== null || record.expiresAt <= now) {
    throw new TokenError(
      'INVALID_OR_EXPIRED_TOKEN',
      'This setup link is no longer valid.',
    )
  }

  if (record.purpose !== expectedPurpose) {
    throw new TokenError(
      'INVALID_OR_EXPIRED_TOKEN',
      'This setup link is no longer valid.',
    )
  }

  if (options.expectedUserId && record.userId !== options.expectedUserId) {
    throw new TokenError(
      'INVALID_OR_EXPIRED_TOKEN',
      'This setup link is no longer valid.',
    )
  }

  if (
    expectedPurpose === PasswordSetupTokenPurpose.SET_PASSWORD &&
    options.userHasSetPassword === true
  ) {
    throw new TokenError(
      'ACCOUNT_NOT_ELIGIBLE',
      'This account cannot use this setup link.',
    )
  }

  return record
}

export async function issuePasswordSetupToken(
  params: {
    userId: string
    purpose?: PasswordSetupTokenPurpose
    ttlMs?: number
    requestedIp?: string | null
    createdById?: string | null
    now?: Date
  },
  db: typeof prisma = prisma,
): Promise<{ rawToken: string; expiresAt: Date; tokenId: string }> {
  const now = params.now ?? new Date()
  const purpose = params.purpose ?? PasswordSetupTokenPurpose.SET_PASSWORD
  const ttlMs = params.ttlMs ?? DEFAULT_TOKEN_TTL_MS
  const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS)
  const ipHash = hashClientIp(params.requestedIp)

  const user = await db.user.findUnique({
    where: { id: params.userId },
    select: { id: true, hasSetPassword: true },
  })

  if (!user) {
    throw new TokenError(
      'INVALID_OR_EXPIRED_TOKEN',
      'Unable to issue setup token for this account.',
    )
  }

  if (
    purpose === PasswordSetupTokenPurpose.SET_PASSWORD &&
    user.hasSetPassword
  ) {
    throw new TokenError(
      'ACCOUNT_NOT_ELIGIBLE',
      'This account has already configured a password.',
    )
  }

  const recentAccountCount = await db.passwordSetupToken.count({
    where: {
      userId: params.userId,
      purpose,
      createdAt: { gte: windowStart },
    },
  })

  if (recentAccountCount >= MAX_TOKENS_PER_ACCOUNT_WINDOW) {
    throw new TokenError(
      'RATE_LIMITED',
      'Too many setup links requested. Please try again later.',
    )
  }

  if (ipHash) {
    const recentIpCount = await db.passwordSetupToken.count({
      where: {
        requestedIp: ipHash,
        createdAt: { gte: windowStart },
      },
    })

    if (recentIpCount >= MAX_TOKENS_PER_IP_WINDOW) {
      throw new TokenError(
        'RATE_LIMITED',
        'Too many setup links requested. Please try again later.',
      )
    }
  }

  const { rawToken, tokenHash } = generateOpaqueToken()
  const expiresAt = new Date(now.getTime() + ttlMs)

  const record = await db.passwordSetupToken.create({
    data: {
      userId: params.userId,
      tokenHash,
      purpose,
      expiresAt,
      requestedIp: ipHash,
      createdById: params.createdById ?? null,
      createdAt: now,
    },
  })

  return {
    rawToken,
    expiresAt,
    tokenId: record.id,
  }
}

export async function verifyPasswordSetupToken(
  params: {
    rawToken: string
    purpose?: PasswordSetupTokenPurpose
    now?: Date
  },
  db: typeof prisma = prisma,
): Promise<{
  userId: string
  userEmail: string
  tokenId: string
  hasSetPassword: boolean
}> {
  if (!params.rawToken || typeof params.rawToken !== 'string' || !params.rawToken.trim()) {
    throw new TokenError(
      'INVALID_OR_EXPIRED_TOKEN',
      'This setup link is no longer valid.',
    )
  }

  const now = params.now ?? new Date()
  const purpose = params.purpose ?? PasswordSetupTokenPurpose.SET_PASSWORD
  const tokenHash = hashOpaqueToken(params.rawToken)

  const record = await db.passwordSetupToken.findUnique({
    where: { tokenHash },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          hasSetPassword: true,
        },
      },
    },
  })

  if (!record || !record.user) {
    throw new TokenError(
      'INVALID_OR_EXPIRED_TOKEN',
      'This setup link is no longer valid.',
    )
  }

  evaluateTokenRecord(record, {
    now,
    expectedPurpose: purpose,
    expectedUserId: record.user.id,
    userHasSetPassword: record.user.hasSetPassword,
  })

  return {
    userId: record.user.id,
    userEmail: record.user.email,
    tokenId: record.id,
    hasSetPassword: record.user.hasSetPassword,
  }
}

export async function consumePasswordSetupTokenAndSetPassword(
  params: {
    rawToken: string
    email?: string
    passwordHash: string
    purpose?: PasswordSetupTokenPurpose
    now?: Date
  },
  db: typeof prisma = prisma,
): Promise<{ userId: string; email: string }> {
  if (!params.rawToken || typeof params.rawToken !== 'string' || !params.rawToken.trim()) {
    throw new TokenError(
      'INVALID_OR_EXPIRED_TOKEN',
      'This setup link is no longer valid.',
    )
  }

  const now = params.now ?? new Date()
  const purpose = params.purpose ?? PasswordSetupTokenPurpose.SET_PASSWORD
  const tokenHash = hashOpaqueToken(params.rawToken)

  return db.$transaction(async (tx) => {
    const tokenRecord = await tx.passwordSetupToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            hasSetPassword: true,
          },
        },
      },
    })

    if (!tokenRecord || !tokenRecord.user) {
      throw new TokenError(
        'INVALID_OR_EXPIRED_TOKEN',
        'This setup link is no longer valid.',
      )
    }

    const user = tokenRecord.user

    if (
      params.email &&
      user.email.trim().toLowerCase() !== params.email.trim().toLowerCase()
    ) {
      throw new TokenError(
        'INVALID_OR_EXPIRED_TOKEN',
        'This setup link is no longer valid.',
      )
    }

    evaluateTokenRecord(tokenRecord, {
      now,
      expectedPurpose: purpose,
      expectedUserId: user.id,
      userHasSetPassword: user.hasSetPassword,
    })

    // Atomic single-use transition to prevent concurrent replay
    const consumed = await tx.passwordSetupToken.updateMany({
      where: {
        id: tokenRecord.id,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    })

    if (consumed.count !== 1) {
      throw new TokenError(
        'INVALID_OR_EXPIRED_TOKEN',
        'This setup link is no longer valid.',
      )
    }

    // Invalidate any other outstanding tokens of the same purpose for this user
    await tx.passwordSetupToken.updateMany({
      where: {
        userId: user.id,
        purpose,
        usedAt: null,
      },
      data: { usedAt: now },
    })

    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash: params.passwordHash,
        hasSetPassword: true,
      },
    })

    return {
      userId: user.id,
      email: user.email,
    }
  })
}
