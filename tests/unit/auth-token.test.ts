import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOKEN_TTL_MS,
  evaluateTokenRecord,
  generateOpaqueToken,
  hashClientIp,
  hashOpaqueToken,
  TokenError,
} from '@/lib/authz/tokens'
import { PasswordSetupTokenPurpose } from '@/generated/prisma/enums'

function listProductionSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const results: string[] = []

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (
        ['node_modules', '.next', 'generated', 'tests', 'prisma', 'scratch', '.git'].includes(
          entry.name,
        )
      ) {
        continue
      }
      results.push(...listProductionSourceFiles(fullPath))
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      results.push(fullPath)
    }
  }

  return results
}

describe('auth token cryptographic and policy primitives (P1-02)', () => {
  it('generates opaque tokens with 256-bit entropy and deterministic SHA-256 hashes', () => {
    const first = generateOpaqueToken()
    const second = generateOpaqueToken()

    expect(first.rawToken).not.toBe(second.rawToken)
    expect(first.tokenHash).not.toBe(second.tokenHash)
    expect(first.rawToken.length).toBeGreaterThanOrEqual(42)
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(hashOpaqueToken(first.rawToken)).toBe(first.tokenHash)
  })

  it('hashes client IP addresses deterministically without storing raw IPs', () => {
    const ipHash = hashClientIp('192.0.2.10')
    expect(ipHash).toMatch(/^[a-f0-9]{64}$/)
    expect(ipHash).not.toContain('192.0.2.10')
    expect(hashClientIp(null)).toBeNull()
    expect(hashClientIp('   ')).toBeNull()
  })

  it('defaults token TTL to 24 hours', () => {
    expect(DEFAULT_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000)
  })

  it('accepts a valid, unused, unexpired token matching user and purpose', () => {
    const now = new Date('2026-10-20T12:00:00.000Z')
    const record = {
      id: 'tok-1',
      userId: 'user-1',
      tokenHash: 'a'.repeat(64),
      purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
      expiresAt: new Date(now.getTime() + DEFAULT_TOKEN_TTL_MS),
      usedAt: null,
    }

    const result = evaluateTokenRecord(record, {
      now,
      expectedPurpose: PasswordSetupTokenPurpose.SET_PASSWORD,
      expectedUserId: 'user-1',
      userHasSetPassword: false,
    })

    expect(result).toEqual(record)
  })

  it('rejects missing, expired, already-used, wrong-purpose, and wrong-user tokens', () => {
    const now = new Date('2026-10-20T12:00:00.000Z')
    const baseRecord = {
      id: 'tok-1',
      userId: 'user-1',
      tokenHash: 'a'.repeat(64),
      purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
      expiresAt: new Date(now.getTime() + 60_000),
      usedAt: null as Date | null,
    }

    expect(() => evaluateTokenRecord(null, { now })).toThrowError(TokenError)

    expect(() =>
      evaluateTokenRecord(
        { ...baseRecord, expiresAt: new Date(now.getTime() - 1) },
        { now },
      ),
    ).toThrow(/no longer valid/)

    expect(() =>
      evaluateTokenRecord(
        { ...baseRecord, usedAt: new Date(now.getTime() - 10_000) },
        { now },
      ),
    ).toThrow(/no longer valid/)

    expect(() =>
      evaluateTokenRecord(baseRecord, {
        now,
        expectedPurpose: PasswordSetupTokenPurpose.RESET_PASSWORD,
      }),
    ).toThrow(/no longer valid/)

    expect(() =>
      evaluateTokenRecord(baseRecord, {
        now,
        expectedUserId: 'user-2',
      }),
    ).toThrow(/no longer valid/)
  })

  it('rejects SET_PASSWORD tokens when the user already has a password set', () => {
    const now = new Date('2026-10-20T12:00:00.000Z')
    const record = {
      id: 'tok-1',
      userId: 'user-1',
      tokenHash: 'a'.repeat(64),
      purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
      expiresAt: new Date(now.getTime() + 60_000),
      usedAt: null,
    }

    try {
      evaluateTokenRecord(record, {
        now,
        expectedPurpose: PasswordSetupTokenPurpose.SET_PASSWORD,
        userHasSetPassword: true,
      })
      expect.fail('Expected TokenError')
    } catch (error) {
      expect(error).toBeInstanceOf(TokenError)
      expect((error as TokenError).code).toBe('ACCOUNT_NOT_ELIGIBLE')
    }
  })

  it('forbids hardcoded default passwords and Math.random() secret generation in production code', () => {
    const rootDir = path.resolve(__dirname, '../..')
    const files = listProductionSourceFiles(rootDir)
    const forbiddenLiteral = ['CrystalKairos', '2026!'].join('')

    const violations: string[] = []

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8')
      const rel = path.relative(rootDir, file)

      if (content.includes(forbiddenLiteral)) {
        violations.push(`${rel}: contains hardcoded default password`)
      }

      if (content.includes('Math.random(')) {
        violations.push(`${rel}: uses Math.random() instead of crypto.randomBytes`)
      }
    }

    expect(violations).toEqual([])
  })
})
