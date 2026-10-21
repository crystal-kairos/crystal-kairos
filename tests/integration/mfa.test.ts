import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  createMfaSetupData,
  enrollMfa,
  generateBackupCodes,
  generateTotpSecret,
  resetUserMfa,
  verifyTotpToken,
  verifyUserMfa,
} from '@/lib/authz/mfa'
import { decryptMfaSecret, encryptMfaSecret } from '@/lib/authz/crypto'
import { generateSync } from 'otplib'

const TEST_32_BYTE_KEY = Buffer.alloc(32, 7).toString('base64')

describe('MFA (TOTP RFC 6238) & Encrypted Secrets Integration (P1-07, D-16)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.MFA_ENCRYPTION_KEY = TEST_32_BYTE_KEY
    process.env.MFA_ISSUER_NAME = 'Crystal Kairos'
  })

  it('encrypts and decrypts MFA secrets with AES-256-GCM', () => {
    const rawSecret = generateTotpSecret()
    const encrypted = encryptMfaSecret(rawSecret)

    expect(encrypted).not.toBe(rawSecret)
    expect(encrypted.split(':')).toHaveLength(3)

    const decrypted = decryptMfaSecret(encrypted)
    expect(decrypted).toBe(rawSecret)
  })

  it('fails decryption if wrong MFA_ENCRYPTION_KEY is used', () => {
    const rawSecret = generateTotpSecret()
    const encrypted = encryptMfaSecret(rawSecret)

    // Switch key
    process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
    expect(() => decryptMfaSecret(encrypted)).toThrow()
  })

  it('generates TOTP setup data with valid URI and QR code', async () => {
    const data = await createMfaSetupData('owner@crystalkairos.coop')
    expect(data.secret).toBeDefined()
    expect(data.uri).toContain('otpauth://totp/Crystal%20Kairos:owner%40crystalkairos.coop')
    expect(data.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('enrols MFA with valid TOTP token and produces 10 backup codes', async () => {
    let savedUser: Record<string, unknown> = {
      id: 'staff-mfa-test',
      email: 'staff@crystalkairos.coop',
      mfaEnabled: false,
      mfaSecret: null,
      mfaBackupCodes: null,
    }

    vi.spyOn(prisma.user, 'update').mockImplementation((async (args: {
      data: Record<string, unknown>
    }) => {
      savedUser = { ...savedUser, ...args.data }
      return savedUser
    }) as never)

    const setupData = await createMfaSetupData('staff@crystalkairos.coop')
    const token = generateSync({ secret: setupData.secret })

    const enrolled = await enrollMfa({
      userId: 'staff-mfa-test',
      secret: setupData.secret,
      token,
    })

    expect(enrolled.plaintextBackupCodes).toHaveLength(10)
    expect(savedUser.mfaEnabled).toBe(true)
    expect(savedUser.mfaSecret).not.toBe(setupData.secret) // Encrypted

    // Verify raw secret decrypts cleanly
    const decrypted = decryptMfaSecret(savedUser.mfaSecret as string)
    expect(decrypted).toBe(setupData.secret)
  })

  it('verifies TOTP code and single-use backup code', async () => {
    const { plaintextCodes, hashedCodes } = generateBackupCodes(10)
    const secret = generateTotpSecret()
    const encryptedSecret = encryptMfaSecret(secret)

    let currentBackupCodes = [...hashedCodes]

    vi.spyOn(prisma.user, 'findUnique').mockImplementation((async () => {
      return {
        id: 'user-verify-mfa',
        mfaEnabled: true,
        mfaSecret: encryptedSecret,
        mfaBackupCodes: currentBackupCodes,
      }
    }) as never)

    vi.spyOn(prisma.user, 'update').mockImplementation((async (args: {
      data: { mfaBackupCodes?: unknown }
    }) => {
      if (args.data.mfaBackupCodes) {
        currentBackupCodes = args.data.mfaBackupCodes as typeof hashedCodes
      }
      return {}
    }) as never)

    // 1. Verify valid TOTP
    const currentTotp = generateSync({ secret })
    const totpResult = await verifyUserMfa('user-verify-mfa', currentTotp)
    expect(totpResult.success).toBe(true)
    expect(totpResult.method).toBe('totp')

    // 2. Verify with backup code
    const firstCode = plaintextCodes[0]
    const backupResult = await verifyUserMfa('user-verify-mfa', firstCode)
    expect(backupResult.success).toBe(true)
    expect(backupResult.method).toBe('backup_code')

    // 3. Second attempt with the SAME backup code fails (single-use)
    const reuseResult = await verifyUserMfa('user-verify-mfa', firstCode)
    expect(reuseResult.success).toBe(false)
  })

  it('resets MFA and increments user sessionVersion to revoke existing sessions', async () => {
    let sessionVersion = 1
    let mfaEnabled = true

    vi.spyOn(prisma.user, 'update').mockImplementation((async (args: {
      data: { sessionVersion?: { increment?: number }; mfaEnabled?: boolean }
    }) => {
      if (args.data.sessionVersion?.increment) sessionVersion += args.data.sessionVersion.increment
      if (args.data.mfaEnabled !== undefined) mfaEnabled = args.data.mfaEnabled
      return {}
    }) as never)

    await resetUserMfa('user-reset-test')

    expect(mfaEnabled).toBe(false)
    expect(sessionVersion).toBe(2)
  })

  it('tolerates ±30s and ±60s clock drift between authenticator and server', async () => {
    const secret = generateTotpSecret()
    const nowEpoch = Math.floor(Date.now() / 1000)

    // Code generated 45 seconds ago (previous window)
    const prevToken = generateSync({ secret, epoch: nowEpoch - 45 })
    // Code generated 45 seconds in future (next window)
    const futureToken = generateSync({ secret, epoch: nowEpoch + 45 })

    expect(verifyTotpToken({ token: prevToken, secret })).toBe(true)
    expect(verifyTotpToken({ token: futureToken, secret })).toBe(true)

    // Code generated beyond tolerance (e.g. 5 minutes away) should fail
    const expiredToken = generateSync({ secret, epoch: nowEpoch - 300 })
    expect(verifyTotpToken({ token: expiredToken, secret })).toBe(false)
  })
})
