import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { generateSync } from 'otplib'
import {
  AdminPermission,
  MembershipStatus,
  UserRole,
} from '@/generated/prisma/enums'

const mockSessionHolder = {
  session: null as { user: { id: string; role: UserRole; email: string; sid?: string } } | null,
}

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => mockSessionHolder.session),
}))

vi.mock('@/models/members/actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/models/members/actions')>()
  return {
    ...actual,
    getSessionHelper: vi.fn(async () => mockSessionHolder.session),
  }
})

import { prisma } from '@/lib/prisma'
import { encryptMfaSecret } from '@/lib/authz/crypto'
import { generateTotpSecret } from '@/lib/authz/mfa'
import { requireAuthenticatedSession } from '@/lib/authz/guards'
import { MAX_SESSION_CHALLENGE_FAILURES } from '@/lib/authz/sessions'
import { STEP_UP_WINDOW_MINUTES } from '@/lib/authz/step-up'
import {
  initiateMfaSetupAction,
  resetMfaAction,
  submitStepUpAction,
  verifyMfaChallengeAction,
} from '@/models/auth/mfaActions'
import { getProfileChangeRequestsAction } from '@/models/admin/profile-change-actions'
import {
  getMyProfileChangeHistoryAction,
  requestBankDetailsChangeAction,
} from '@/models/members/profile-change-actions'
import { setBankProviderForTesting } from '@/lib/banking/paystack.provider'
import { AuditAction } from '@/lib/services/audit.service'
import bcrypt from 'bcryptjs'

const TEST_32_BYTE_KEY = Buffer.alloc(32, 7).toString('base64')

describe('P1-07 follow-up: MFA-verified sessions, challenge and step-up', () => {
  const timestamp = Date.now()
  const prefix = `test-mfa-enf-${timestamp}`
  const MEMBER_PASSWORD = 'Member-Passw0rd-123'

  const staffSecret = generateTotpSecret()
  const memberSecret = generateTotpSecret()

  let ownerId: string
  let adminId: string
  let mfaMemberId: string
  let plainMemberId: string
  let mfaMemberBankId: string

  /** A TOTP code for the time step `offset` steps from now (within the ±60s tolerance). */
  const totp = (secret: string, offset = 0) =>
    generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + offset * 30 })

  const newSession = async (
    userId: string,
    opts: { mfaVerified?: boolean; stepUpMinutesAgo?: number } = {},
  ) =>
    prisma.userSession.create({
      data: {
        userId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        idleExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
        mfaVerifiedAt: opts.mfaVerified ? new Date() : null,
        stepUpAt:
          typeof opts.stepUpMinutesAgo === 'number'
            ? new Date(Date.now() - opts.stepUpMinutesAgo * 60 * 1000)
            : null,
      },
    })

  const signInAs = (id: string, role: UserRole, sid?: string) => {
    mockSessionHolder.session = { user: { id, role, email: `${id}@x`, ...(sid ? { sid } : {}) } }
  }

  beforeEach(() => {
    process.env.MFA_ENCRYPTION_KEY = TEST_32_BYTE_KEY
    delete process.env.MOCK_SESSION_USER
    setBankProviderForTesting({
      listBanks: async () => [{ name: 'Guaranty Trust Bank', code: '058' }],
      resolveAccount: async (code, num) => ({ accountName: 'MFA MEMBER', accountNumber: num, bankCode: code }),
    })
  })

  afterAll(async () => {
    setBankProviderForTesting(null)
    const users = await prisma.user.findMany({
      where: { email: { startsWith: prefix } },
      select: { id: true },
    })
    const ids = users.map((u) => u.id)
    await prisma.profileChangeRequest.deleteMany({ where: { userId: { in: ids } } })
    await prisma.auditEvent.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { affectedUserId: { in: ids } }] },
    })
    await prisma.userSession.deleteMany({ where: { userId: { in: ids } } })
    await prisma.adminPermissionGrant.deleteMany({ where: { adminUserId: { in: ids } } })
    await prisma.bankAccount.deleteMany({ where: { userId: { in: ids } } })
    await prisma.membership.deleteMany({ where: { userId: { in: ids } } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
  })

  it('0. setup', async () => {
    process.env.MFA_ENCRYPTION_KEY = TEST_32_BYTE_KEY
    const owner = await prisma.user.create({
      data: {
        email: `${prefix}-owner@test.com`,
        name: 'Enf Owner',
        role: UserRole.OWNER,
        mfaEnabled: true,
        mfaSecret: encryptMfaSecret(staffSecret),
      },
    })
    ownerId = owner.id

    const admin = await prisma.user.create({
      data: {
        email: `${prefix}-admin@test.com`,
        name: 'Enf Admin',
        role: UserRole.ADMIN,
        mfaEnabled: true,
        mfaSecret: encryptMfaSecret(staffSecret),
      },
    })
    adminId = admin.id
    await prisma.adminPermissionGrant.createMany({
      data: [
        { adminUserId: adminId, permission: AdminPermission.PROFILE_CHANGES_REVIEW, grantedById: ownerId },
        { adminUserId: adminId, permission: AdminPermission.MEMBERS_APPROVE, grantedById: ownerId },
      ],
    })

    const mfaMember = await prisma.user.create({
      data: {
        email: `${prefix}-mfa-member@test.com`,
        name: 'Mfa Member',
        role: UserRole.USER,
        mfaEnabled: true,
        mfaSecret: encryptMfaSecret(memberSecret),
        passwordHash: await bcrypt.hash(MEMBER_PASSWORD, 4),
        hasSetPassword: true,
        membership: { create: { status: MembershipStatus.APPROVED, membershipNumber: `ENF-${timestamp}` } },
      },
    })
    mfaMemberId = mfaMember.id
    const bank = await prisma.bankAccount.create({
      data: {
        userId: mfaMemberId,
        bankCode: '058',
        bankName: 'Guaranty Trust Bank',
        accountNumber: `11${String(timestamp).slice(-8)}`,
        accountName: 'MFA MEMBER',
        isPrimary: true,
        isVerified: true,
      },
    })
    mfaMemberBankId = bank.id

    const plain = await prisma.user.create({
      data: {
        email: `${prefix}-plain-member@test.com`,
        name: 'Plain Member',
        role: UserRole.USER,
        passwordHash: await bcrypt.hash(MEMBER_PASSWORD, 4),
        hasSetPassword: true,
      },
    })
    plainMemberId = plain.id
  })

  it('1. a password-only session of an MFA user cannot use protected actions (staff and members)', async () => {
    const adminSession = await newSession(adminId)
    signInAs(adminId, UserRole.ADMIN, adminSession.id)
    const adminRes = await getProfileChangeRequestsAction()
    expect(adminRes.success).toBe(false)
    expect(adminRes.code).toBe('MFA_CHALLENGE_REQUIRED')

    const memberSession = await newSession(mfaMemberId)
    signInAs(mfaMemberId, UserRole.USER, memberSession.id)
    const memberRes = await getMyProfileChangeHistoryAction()
    expect(memberRes.success).toBe(false)
    expect(memberRes.code).toBe('MFA_CHALLENGE_REQUIRED')

    // Step-up cannot be used to skip the challenge either
    const stepUp = await submitStepUpAction({ mfaCode: totp(memberSecret) })
    expect(stepUp.success).toBe(false)
    expect(stepUp.code).toBe('MFA_CHALLENGE_REQUIRED')
    const after = await prisma.userSession.findUnique({ where: { id: memberSession.id } })
    expect(after?.mfaVerifiedAt).toBeNull()
  })

  it('2. passing the challenge verifies only the caller\'s own session; client-supplied ids are ignored', async () => {
    const mine = await newSession(adminId)
    const other = await newSession(ownerId)

    signInAs(adminId, UserRole.ADMIN, mine.id)
    const res = await verifyMfaChallengeAction({
      code: totp(staffSecret, 1),
      // Old API fields: must have no effect.
      userId: ownerId,
      sessionId: other.id,
    } as unknown as { code: string })
    expect(res.success).toBe(true)

    const mineAfter = await prisma.userSession.findUnique({ where: { id: mine.id } })
    const otherAfter = await prisma.userSession.findUnique({ where: { id: other.id } })
    expect(mineAfter?.mfaVerifiedAt).not.toBeNull()
    expect(otherAfter?.mfaVerifiedAt).toBeNull()

    // Now the admin can work
    expect((await getProfileChangeRequestsAction()).success).toBe(true)

    const passed = await prisma.auditEvent.findFirst({
      where: { action: AuditAction.AUTH_MFA_CHALLENGE_PASSED, entityId: mine.id },
    })
    expect(passed).not.toBeNull()
  })

  it('3. a code that was already used cannot pass another challenge (replay)', async () => {
    const s1 = await newSession(ownerId)
    signInAs(ownerId, UserRole.OWNER, s1.id)
    const code = totp(staffSecret, 2)
    // staffSecret is shared by owner and admin in this test, but replay state is per user:
    expect((await verifyMfaChallengeAction({ code })).success).toBe(true)

    const s2 = await newSession(ownerId)
    signInAs(ownerId, UserRole.OWNER, s2.id)
    const replay = await verifyMfaChallengeAction({ code })
    expect(replay.success).toBe(false)
    expect(replay.code).toBe('INVALID_CREDENTIALS')
  })

  it(`4. ${MAX_SESSION_CHALLENGE_FAILURES} wrong codes revoke the session`, async () => {
    const s = await newSession(mfaMemberId)
    signInAs(mfaMemberId, UserRole.USER, s.id)

    let last: Awaited<ReturnType<typeof verifyMfaChallengeAction>> | undefined
    for (let i = 0; i < MAX_SESSION_CHALLENGE_FAILURES; i++) {
      last = await verifyMfaChallengeAction({ code: '000000' })
      expect(last.success).toBe(false)
    }
    expect(last?.code).toBe('SESSION_REVOKED')

    const revoked = await prisma.userSession.findUnique({ where: { id: s.id } })
    expect(revoked?.revokedAt).not.toBeNull()

    // A correct code no longer helps: the session is gone
    const late = await verifyMfaChallengeAction({ code: totp(memberSecret, 1) })
    expect(late.success).toBe(false)
    expect(late.code).toBe('UNAUTHENTICATED')
  })

  it('5. a session row that belongs to another user is rejected', async () => {
    const ownersSession = await newSession(ownerId, { mfaVerified: true })
    signInAs(adminId, UserRole.ADMIN, ownersSession.id)
    const res = await getProfileChangeRequestsAction()
    expect(res.success).toBe(false)
    expect(res.code).toBe('UNAUTHENTICATED')
  })

  it('6. outside tests, a token without a database session id is rejected', async () => {
    signInAs(adminId, UserRole.ADMIN) // no sid
    vi.stubEnv('NODE_ENV', 'development')
    try {
      await expect(requireAuthenticatedSession()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('7. step-up: MFA users must use an MFA code; it is per session and expires', async () => {
    const s = await newSession(mfaMemberId, { mfaVerified: true })
    const otherSession = await newSession(mfaMemberId, { mfaVerified: true })
    signInAs(mfaMemberId, UserRole.USER, s.id)

    // Password is not accepted when MFA is enabled
    const byPassword = await submitStepUpAction({ password: MEMBER_PASSWORD })
    expect(byPassword.success).toBe(false)

    expect((await submitStepUpAction({ mfaCode: totp(memberSecret, 2) })).success).toBe(true)
    const after = await prisma.userSession.findUnique({ where: { id: s.id } })
    expect(after?.stepUpAt).not.toBeNull()

    // The bank-details change request (MFA member) now goes through on this session...
    const req = await requestBankDetailsChangeAction(mfaMemberBankId, {
      bankCode: '058',
      accountNumber: `22${String(timestamp).slice(-8)}`,
    })
    expect(req.success).toBe(true)

    // ...but not on another session of the same user
    signInAs(mfaMemberId, UserRole.USER, otherSession.id)
    const elsewhere = await requestBankDetailsChangeAction(mfaMemberBankId, {
      bankCode: '058',
      accountNumber: `33${String(timestamp).slice(-8)}`,
    })
    expect(elsewhere.success).toBe(false)
    expect(elsewhere.code).toBe('STEP_UP_REQUIRED')

    // An expired step-up does not count
    const stale = await newSession(mfaMemberId, {
      mfaVerified: true,
      stepUpMinutesAgo: STEP_UP_WINDOW_MINUTES + 1,
    })
    signInAs(mfaMemberId, UserRole.USER, stale.id)
    const expired = await requestBankDetailsChangeAction(mfaMemberBankId, {
      bankCode: '058',
      accountNumber: `44${String(timestamp).slice(-8)}`,
    })
    expect(expired.code).toBe('STEP_UP_REQUIRED')
  })

  it('8. step-up for a member without MFA uses the password', async () => {
    const s = await newSession(plainMemberId)
    signInAs(plainMemberId, UserRole.USER, s.id)
    expect((await submitStepUpAction({ password: 'wrong-password' })).success).toBe(false)
    expect((await submitStepUpAction({ password: MEMBER_PASSWORD })).success).toBe(true)
    const after = await prisma.userSession.findUnique({ where: { id: s.id } })
    expect(after?.stepUpAt).not.toBeNull()
    expect(after?.mfaVerifiedAt).toBeNull() // step-up never sets MFA verification
    expect(after?.challengeFailures).toBe(0)
  })

  it('9. MFA reset needs step-up and cannot target yourself; replacing your own authenticator needs step-up', async () => {
    const s = await newSession(adminId, { mfaVerified: true })
    signInAs(adminId, UserRole.ADMIN, s.id)

    const noStepUp = await resetMfaAction(mfaMemberId)
    expect(noStepUp.success).toBe(false)
    expect(noStepUp.code).toBe('STEP_UP_REQUIRED')

    const self = await resetMfaAction(adminId)
    expect(self.success).toBe(false)
    expect(self.code).toBe('FORBIDDEN')

    const replace = await initiateMfaSetupAction()
    expect(replace.success).toBe(false)
    expect(replace.code).toBe('STEP_UP_REQUIRED')

    await prisma.userSession.update({ where: { id: s.id }, data: { stepUpAt: new Date() } })
    expect((await initiateMfaSetupAction()).success).toBe(true)
    const reset = await resetMfaAction(mfaMemberId)
    expect(reset.success).toBe(true)
    const member = await prisma.user.findUnique({ where: { id: mfaMemberId } })
    expect(member?.mfaEnabled).toBe(false)
    expect(member?.mfaLastTotpStep).toBeNull()
  })
})
