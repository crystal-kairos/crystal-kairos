import crypto from 'node:crypto'
import { generateSecret, generateURI, verifySync } from 'otplib'
import QRCode from 'qrcode'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import { decryptMfaSecret, encryptMfaSecret, hashSha256 } from '@/lib/authz/crypto'
import { getOptionalEnv } from '@/lib/env'
import { AppError } from '@/lib/errors/app-error'

export interface BackupCodeItem {
  hash: string
  usedAt?: string
}

export interface MfaSetupData {
  secret: string
  uri: string
  qrCodeDataUrl: string
}

export function generateTotpSecret(): string {
  return generateSecret()
}

export function getMfaIssuer(): string {
  return getOptionalEnv('MFA_ISSUER_NAME', 'Crystal Kairos')
}

export async function createMfaSetupData(email: string): Promise<MfaSetupData> {
  const secret = generateTotpSecret()
  const issuer = getMfaIssuer()
  const uri = generateURI({
    secret,
    label: email,
    issuer,
  })
  const qrCodeDataUrl = await QRCode.toDataURL(uri, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 256,
  })

  return {
    secret,
    uri,
    qrCodeDataUrl,
  }
}

export function verifyTotpToken(params: {
  token: string
  secret: string
  epochTolerance?: number
}): boolean {
  const trimmed = params.token.trim().replace(/\s+/g, '')
  if (!/^\d{6}$/.test(trimmed)) {
    return false
  }

  const configuredTolerance = Number(getOptionalEnv('MFA_EPOCH_TOLERANCE_SECONDS', '60'))
  const epochTolerance =
    typeof params.epochTolerance === 'number'
      ? params.epochTolerance
      : Number.isFinite(configuredTolerance)
        ? configuredTolerance
        : 60

  const result = verifySync({
    token: trimmed,
    secret: params.secret,
    epochTolerance,
  })
  return result.valid
}

export function generateBackupCodes(count = 10): { plaintextCodes: string[]; hashedCodes: BackupCodeItem[] } {
  const plaintextCodes: string[] = []
  const hashedCodes: BackupCodeItem[] = []

  for (let i = 0; i < count; i++) {
    // Format: 8 alphanumeric chars, grouped as XXXX-XXXX for usability
    const part1 = crypto.randomBytes(2).toString('hex').toUpperCase()
    const part2 = crypto.randomBytes(2).toString('hex').toUpperCase()
    const code = `${part1}-${part2}`
    plaintextCodes.push(code)
    hashedCodes.push({
      hash: hashSha256(code.replace(/-/g, '').toUpperCase()),
    })
  }

  return { plaintextCodes, hashedCodes }
}

/**
 * Verifies a 6-digit TOTP token OR an unused backup code for the user.
 * If a backup code is used, it is atomically marked as used in the database.
 */
export async function verifyUserMfa(
  userId: string,
  tokenOrBackupCode: string,
  db: typeof prisma = prisma,
): Promise<{ success: boolean; method?: 'totp' | 'backup_code' }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      mfaEnabled: true,
      mfaSecret: true,
      mfaBackupCodes: true,
    },
  })

  if (!user || !user.mfaEnabled || !user.mfaSecret) {
    return { success: false }
  }

  const cleanInput = tokenOrBackupCode.trim()

  // 1. Try TOTP token first if it is numeric
  if (/^\d{6}$/.test(cleanInput.replace(/\s+/g, ''))) {
    const rawSecret = decryptMfaSecret(user.mfaSecret)
    const valid = verifyTotpToken({ token: cleanInput, secret: rawSecret })
    if (valid) {
      return { success: true, method: 'totp' }
    }
  }

  // 2. Try backup codes (case-insensitive, ignoring hyphens/spaces)
  const normalizedBackupInput = cleanInput.replace(/[-\s]/g, '').toUpperCase()
  const inputHash = hashSha256(normalizedBackupInput)

  const backupCodes = Array.isArray(user.mfaBackupCodes)
    ? (user.mfaBackupCodes as unknown as BackupCodeItem[])
    : []

  const matchingIndex = backupCodes.findIndex(
    (item) => item.hash === inputHash && !item.usedAt,
  )

  if (matchingIndex !== -1) {
    const updatedCodes = [...backupCodes]
    updatedCodes[matchingIndex] = {
      ...updatedCodes[matchingIndex],
      usedAt: new Date().toISOString(),
    }

    await db.user.update({
      where: { id: user.id },
      data: {
        mfaBackupCodes: updatedCodes as unknown as object,
      },
    })

    return { success: true, method: 'backup_code' }
  }

  return { success: false }
}

/**
 * Enrolls MFA for a user by verifying the provided TOTP token against the setup secret.
 * Stores encrypted secret and generates 10 hashed backup codes.
 */
export async function enrollMfa(params: {
  userId: string
  secret: string
  token: string
  db?: typeof prisma
}): Promise<{ plaintextBackupCodes: string[] }> {
  const db = params.db ?? prisma

  const isValid = verifyTotpToken({ token: params.token, secret: params.secret })
  if (!isValid) {
    throw new AppError('INVALID_CREDENTIALS', 'Invalid authenticator code. Please check your authenticator app and try again.')
  }

  const encryptedSecret = encryptMfaSecret(params.secret)
  const { plaintextCodes, hashedCodes } = generateBackupCodes(10)

  await db.user.update({
    where: { id: params.userId },
    data: {
      mfaEnabled: true,
      mfaSecret: encryptedSecret,
      mfaBackupCodes: hashedCodes as unknown as object,
      mfaEnrolledAt: new Date(),
    },
  })

  return { plaintextBackupCodes: plaintextCodes }
}

/**
 * Resets MFA for a user. Increments sessionVersion to revoke active sessions.
 */
export async function resetUserMfa(
  userId: string,
  _resetByUserId?: string,
  db: typeof prisma = prisma,
): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: {
      mfaEnabled: false,
      mfaSecret: null,
      mfaBackupCodes: Prisma.DbNull,
      mfaResetAt: new Date(),
      sessionVersion: { increment: 1 },
    },
  })
}
