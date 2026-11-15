import crypto from 'node:crypto'
import { generateSecret, generateURI, verifySync } from 'otplib'
import QRCode from 'qrcode'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import { decryptMfaSecret, encryptMfaSecret, hashSha256 } from '@/lib/authz/crypto'
import { getOptionalEnv } from '@/lib/env'
import { AppError } from '@/lib/errors/app-error'
import { recordAuditEvent, AuditAction, AuditOutcome } from '@/lib/services/audit.service'

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

function resolveEpochTolerance(explicit?: number): number {
  if (typeof explicit === 'number') return explicit
  const configured = Number(getOptionalEnv('MFA_EPOCH_TOLERANCE_SECONDS', '60'))
  return Number.isFinite(configured) ? configured : 60
}

/**
 * Verifies a TOTP code and returns the matched time step.
 * Pass `afterTimeStep` (the last accepted step) to reject replayed codes.
 */
export function verifyTotpTokenWithStep(params: {
  token: string
  secret: string
  epochTolerance?: number
  afterTimeStep?: number | null
}): { valid: boolean; timeStep?: number } {
  const trimmed = params.token.trim().replace(/\s+/g, '')
  if (!/^\d{6}$/.test(trimmed)) {
    return { valid: false }
  }

  const result = verifySync({
    token: trimmed,
    secret: params.secret,
    epochTolerance: resolveEpochTolerance(params.epochTolerance),
    ...(typeof params.afterTimeStep === 'number' ? { afterTimeStep: params.afterTimeStep } : {}),
  })
  if (!result.valid) return { valid: false }
  const timeStep = (result as { timeStep?: number }).timeStep
  return { valid: true, timeStep }
}

export function verifyTotpToken(params: {
  token: string
  secret: string
  epochTolerance?: number
}): boolean {
  return verifyTotpTokenWithStep(params).valid
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
 * Verifies a 6-digit TOTP code OR an unused backup code for the user.
 *
 * Both paths are single-use (P1-07):
 * - a TOTP code is accepted only for a time step later than the last accepted one,
 *   recorded with a conditional update so two concurrent uses cannot both succeed;
 * - a backup code is marked used with a conditional update on the previous code list.
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
      mfaLastTotpStep: true,
    },
  })

  if (!user || !user.mfaEnabled || !user.mfaSecret) {
    return { success: false }
  }

  const cleanInput = tokenOrBackupCode.trim()

  // 1. TOTP code
  if (/^\d{6}$/.test(cleanInput.replace(/\s+/g, ''))) {
    const rawSecret = decryptMfaSecret(user.mfaSecret)
    const result = verifyTotpTokenWithStep({
      token: cleanInput,
      secret: rawSecret,
      afterTimeStep: user.mfaLastTotpStep,
    })
    if (result.valid && typeof result.timeStep === 'number') {
      const claimed = await db.user.updateMany({
        where: {
          id: user.id,
          OR: [{ mfaLastTotpStep: null }, { mfaLastTotpStep: { lt: result.timeStep } }],
        },
        data: { mfaLastTotpStep: result.timeStep },
      })
      if (claimed.count === 1) {
        return { success: true, method: 'totp' }
      }
    }
    return { success: false }
  }

  // 2. Backup codes (case-insensitive, ignoring hyphens/spaces)
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

    // Only succeeds if nobody changed the code list since we read it.
    const claimed = await db.user.updateMany({
      where: {
        id: user.id,
        mfaBackupCodes: { equals: user.mfaBackupCodes as Prisma.InputJsonValue },
      },
      data: {
        mfaBackupCodes: updatedCodes as unknown as Prisma.InputJsonValue,
      },
    })

    if (claimed.count === 1) {
      return { success: true, method: 'backup_code' }
    }
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

  const verification = verifyTotpTokenWithStep({ token: params.token, secret: params.secret })
  if (!verification.valid) {
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
      mfaLastTotpStep: verification.timeStep ?? null,
    },
  })

  await recordAuditEvent(
    {
      actorId: params.userId,
      affectedUserId: params.userId,
      action: AuditAction.AUTH_MFA_ENROLLED,
      entityType: 'User',
      entityId: params.userId,
      outcome: AuditOutcome.SUCCESS,
      metadata: { mfaEnabled: true, backupCodesCount: 10 },
    },
    db as any,
  ).catch(() => {})

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
      mfaLastTotpStep: null,
      mfaResetAt: new Date(),
      sessionVersion: { increment: 1 },
    },
  })

  await recordAuditEvent(
    {
      actorId: _resetByUserId ?? userId,
      affectedUserId: userId,
      action: AuditAction.AUTH_MFA_RESET,
      entityType: 'User',
      entityId: userId,
      outcome: AuditOutcome.SUCCESS,
      metadata: { mfaEnabled: false, resetByUserId: _resetByUserId ?? userId },
    },
    db as any,
  ).catch(() => {})
}
