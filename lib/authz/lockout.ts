import { prisma } from '@/lib/prisma'
import { hashSha256 } from '@/lib/authz/crypto'
import { UserRole } from '@/generated/prisma/enums'
import { recordAuditEvent, AuditAction, AuditOutcome } from '@/lib/services/audit.service'

export const LOCKOUT_CONFIG = {
  maxFailures: 5,
  windowMinutes: 15,
  initialLockoutMinutes: 15,
  maxLockoutMinutes: 24 * 60, // 24 hours
  maxIpFailuresPerHour: 20,
}

export interface LockoutStatus {
  isLocked: boolean
  lockedUntil?: Date
  remainingMinutes?: number
}

export function calculateLockoutExpiry(currentLockoutCount: number, now = new Date()): Date {
  // Lockout duration doubles on repeated lockouts: 15m, 30m, 60m, 120m, ... up to 24h
  const multiplier = Math.pow(2, Math.max(0, currentLockoutCount - 1))
  const durationMinutes = Math.min(
    LOCKOUT_CONFIG.initialLockoutMinutes * multiplier,
    LOCKOUT_CONFIG.maxLockoutMinutes,
  )
  return new Date(now.getTime() + durationMinutes * 60 * 1000)
}

/**
 * Checks if an account or IP is currently locked out.
 */
export async function checkLockout(
  email: string,
  clientIp = '127.0.0.1',
  db: typeof prisma = prisma,
): Promise<LockoutStatus> {
  const ipHash = hashSha256(clientIp)
  const now = new Date()

  // 1. Check user record if exists
  const user = await db.user.findFirst({
    where: { email: email.trim().toLowerCase() },
    select: { id: true, lockedUntil: true, lockoutCount: true },
  })

  if (user?.lockedUntil && user.lockedUntil > now) {
    const diffMs = user.lockedUntil.getTime() - now.getTime()
    return {
      isLocked: true,
      lockedUntil: user.lockedUntil,
      remainingMinutes: Math.ceil(diffMs / (60 * 1000)),
    }
  }

  // 2. Check IP throttling (e.g. 20 failed attempts in the past hour)
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)
  const recentIpFailures = await db.loginAttempt.count({
    where: {
      ipHash,
      succeeded: false,
      createdAt: { gte: oneHourAgo },
    },
  })

  if (recentIpFailures >= LOCKOUT_CONFIG.maxIpFailuresPerHour) {
    return {
      isLocked: true,
      lockedUntil: new Date(now.getTime() + 15 * 60 * 1000),
      remainingMinutes: 15,
    }
  }

  return { isLocked: false }
}

/**
 * Records a login attempt and applies account lockout if consecutive failures cross the threshold.
 */
export async function recordLoginAttempt(params: {
  email: string
  clientIp?: string
  succeeded: boolean
  userId?: string
  db?: typeof prisma
}): Promise<{ newlyLocked: boolean; lockedUntil?: Date }> {
  const db = params.db ?? prisma
  const emailNorm = params.email.trim().toLowerCase()
  const emailHash = hashSha256(emailNorm)
  const ipHash = hashSha256(params.clientIp ?? '127.0.0.1')
  const now = new Date()

  let resolvedUserId = params.userId
  if (!resolvedUserId) {
    const u = await db.user.findFirst({
      where: { email: emailNorm },
      select: { id: true },
    })
    resolvedUserId = u?.id
  }

  // Record attempt in login_attempts table
  await db.loginAttempt.create({
    data: {
      userId: resolvedUserId ?? null,
      emailHash,
      ipHash,
      succeeded: params.succeeded,
      createdAt: now,
    },
  })

  if (params.succeeded) {
    // Clear lockout on success
    if (resolvedUserId) {
      await db.user.update({
        where: { id: resolvedUserId },
        data: {
          lockedUntil: null,
          lockoutCount: 0,
        },
      })
    }
    await recordAuditEvent(
      {
        actorId: resolvedUserId ?? null,
        affectedUserId: resolvedUserId ?? null,
        action: AuditAction.AUTH_SIGN_IN_SUCCESS,
        entityType: 'User',
        entityId: resolvedUserId ?? null,
        outcome: AuditOutcome.SUCCESS,
        ipHash,
        metadata: { email: emailNorm },
      },
      db as any,
    ).catch(() => {})
    return { newlyLocked: false }
  }

  // Count recent failures for this account within the window
  const windowStart = new Date(now.getTime() - LOCKOUT_CONFIG.windowMinutes * 60 * 1000)
  const recentFailures = await db.loginAttempt.count({
    where: {
      emailHash,
      succeeded: false,
      createdAt: { gte: windowStart },
    },
  })

  if (recentFailures >= LOCKOUT_CONFIG.maxFailures && resolvedUserId) {
    const user = await db.user.findUnique({
      where: { id: resolvedUserId },
      select: { lockoutCount: true },
    })

    const nextLockoutCount = (user?.lockoutCount ?? 0) + 1
    const lockedUntil = calculateLockoutExpiry(nextLockoutCount, now)

    await db.user.update({
      where: { id: resolvedUserId },
      data: {
        lockedUntil,
        lockoutCount: nextLockoutCount,
      },
    })

    await recordAuditEvent(
      {
        actorId: resolvedUserId,
        affectedUserId: resolvedUserId,
        action: AuditAction.AUTH_LOCKOUT,
        entityType: 'User',
        entityId: resolvedUserId,
        outcome: AuditOutcome.BLOCKED,
        ipHash,
        metadata: {
          email: emailNorm,
          lockoutCount: nextLockoutCount,
          lockedUntil: lockedUntil.toISOString(),
        },
      },
      db as any,
    ).catch(() => {})

    return { newlyLocked: true, lockedUntil }
  }

  await recordAuditEvent(
    {
      actorId: resolvedUserId ?? null,
      affectedUserId: resolvedUserId ?? null,
      action: AuditAction.AUTH_SIGN_IN_FAILURE,
      entityType: 'User',
      entityId: resolvedUserId ?? null,
      outcome: AuditOutcome.FAILURE,
      ipHash,
      metadata: { email: emailNorm },
    },
    db as any,
  ).catch(() => {})

  return { newlyLocked: false }
}

/**
 * Unlocks an account.
 * Permissions:
 * - Admin with MEMBERS_APPROVE or OWNER can unlock USER accounts.
 * - Only OWNER can unlock staff (ADMIN / OWNER) accounts.
 */
export async function unlockUserAccount(params: {
  targetUserId: string
  operatorRole: UserRole
  operatorHasMembersApprove: boolean
  db?: typeof prisma
}): Promise<void> {
  const db = params.db ?? prisma

  const target = await db.user.findUnique({
    where: { id: params.targetUserId },
    select: { id: true, role: true },
  })

  if (!target) {
    throw new Error('User not found')
  }

  const isStaff = target.role === UserRole.OWNER || target.role === UserRole.ADMIN

  if (isStaff && params.operatorRole !== UserRole.OWNER) {
    throw new Error('Only the cooperative owner can unlock administrative staff accounts.')
  }

  if (
    !isStaff &&
    params.operatorRole !== UserRole.OWNER &&
    !params.operatorHasMembersApprove
  ) {
    throw new Error('Insufficient permissions to unlock member account.')
  }

  await db.user.update({
    where: { id: target.id },
    data: {
      lockedUntil: null,
      lockoutCount: 0,
    },
  })
}
