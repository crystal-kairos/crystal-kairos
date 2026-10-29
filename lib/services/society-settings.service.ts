import { prisma } from '@/lib/prisma'
import { recordAuditEvent, AuditAction, AuditOutcome } from '@/lib/services/audit.service'

export interface SocietySettingsMap {
  finalNoticeDays: number
  maxBackdateDays: number
  savingsFirstDepositWindowDays: number
  loanApplicationFee: number
  ownSavingsLienMode: 'FULL' | 'REQUIRED_PORTION'
  minWalletWithdrawal: number
  dualControlThreshold: number
  reversalOwnerThreshold: number
  sessionMaxAgeHours: number
  sessionIdleMinutes: number
  maxConsecutiveFailedLogins: number
  lockoutDurationMinutes: number
}

export const DEFAULT_SOCIETY_SETTINGS: SocietySettingsMap = {
  finalNoticeDays: 7,
  maxBackdateDays: 30,
  savingsFirstDepositWindowDays: 14,
  loanApplicationFee: 0,
  ownSavingsLienMode: 'FULL',
  minWalletWithdrawal: 1000,
  dualControlThreshold: 500000,
  reversalOwnerThreshold: 100000,
  sessionMaxAgeHours: 24,
  sessionIdleMinutes: 30,
  maxConsecutiveFailedLogins: 5,
  lockoutDurationMinutes: 15,
}

/**
 * Gets a typed society setting, falling back to system defaults.
 */
export async function getSocietySetting<K extends keyof SocietySettingsMap>(
  key: K,
  fallback?: SocietySettingsMap[K]
): Promise<SocietySettingsMap[K]> {
  try {
    const record = await prisma.societySetting.findUnique({
      where: { key: key as string },
    })

    if (!record || record.value === null || record.value === undefined) {
      return (fallback ?? DEFAULT_SOCIETY_SETTINGS[key]) as SocietySettingsMap[K]
    }

    // JSON value can be raw scalar or wrapped
    const val = record.value as any
    if (typeof val === 'object' && val !== null && 'value' in val) {
      return val.value as SocietySettingsMap[K]
    }
    return val as SocietySettingsMap[K]
  } catch (error) {
    return (fallback ?? DEFAULT_SOCIETY_SETTINGS[key]) as SocietySettingsMap[K]
  }
}

/**
 * Sets a typed society setting with updater audit tracking.
 */
export async function setSocietySetting<K extends keyof SocietySettingsMap>(
  key: K,
  value: SocietySettingsMap[K],
  updatedById?: string
): Promise<void> {
  const existing = await prisma.societySetting.findUnique({
    where: { key: key as string },
  })

  await prisma.societySetting.upsert({
    where: { key: key as string },
    create: {
      key: key as string,
      value: value as any,
      updatedBy: updatedById,
    },
    update: {
      value: value as any,
      updatedBy: updatedById,
    },
  })

  await recordAuditEvent({
    actorId: updatedById ?? null,
    action: AuditAction.SETTING_CHANGED,
    entityType: 'SocietySetting',
    entityId: key as string,
    outcome: AuditOutcome.SUCCESS,
    beforeState: existing ? { key, value: existing.value } : null,
    afterState: { key, value },
    metadata: { key, updatedById },
  }).catch(() => {})
}
