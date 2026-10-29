import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { MembershipStatus, UserDeactivationReason, UserRole } from '@/generated/prisma/enums'

const mockSessionState = vi.hoisted(() => ({
  session: null as {
    user?: {
      id: string
      email: string
      name: string
      role: UserRole
      sessionVersion?: number
    }
  } | null,
}))

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => mockSessionState.session),
}))

import { prisma } from '@/lib/prisma'
import {
  calculateProfileCompleteness,
  assertUserActive,
  assertStaffNotMember,
  assertProductEligibility,
  normalizePhoneNumber,
} from '@/lib/domain/eligibility'
import {
  addBankAccountAction,
  deactivateUserAction,
  reactivateUserAction,
  createSocietyBankAccountAction,
  recordPrivacyConsentAction,
} from '@/models/members/actions'
import { checkDatabaseInvariants } from '@/scripts/check-invariants'
import { hash } from 'bcryptjs'

describe('Member Lifecycle, Profile State, Bank Settings and Soft Deactivation (PR P2-01)', () => {
  const timestamp = Date.now()
  const testEmailPrefix = `test-p201-${timestamp}`

  beforeEach(async () => {
    // Clear any test session mock
    delete process.env.MOCK_SESSION_USER
  })

  afterAll(async () => {
    const testUsers = await prisma.user.findMany({
      where: { email: { startsWith: testEmailPrefix } },
      select: { id: true },
    })
    const ids = testUsers.map((u) => u.id)
    await prisma.societyBankAccount.deleteMany({
      where: { accountNumber: '2019283746' },
    })
    if (ids.length > 0) {
      await prisma.privacyConsent.deleteMany({ where: { userId: { in: ids } } })
      await prisma.bankAccount.deleteMany({ where: { userId: { in: ids } } })
      await prisma.membership.deleteMany({ where: { userId: { in: ids } } })
      await prisma.userInfo.deleteMany({ where: { userId: { in: ids } } })
      await prisma.societyBankAccount.deleteMany({ where: { createdById: { in: ids } } })
      await prisma.user.updateMany({
        where: { deactivatedById: { in: ids } },
        data: { deactivatedById: null },
      })
      await prisma.user.deleteMany({ where: { id: { in: ids } } })
    }
  })

  it('calculates profile completeness independently of membership status (§1.1)', () => {
    // 1. Completely empty profile
    const emptyProfile = calculateProfileCompleteness({})
    expect(emptyProfile.isComplete).toBe(false)
    expect(emptyProfile.completionPercentage).toBe(0)
    expect(emptyProfile.missingSections).toEqual([
      'Personal Details',
      'Bank Account',
      'Next of Kin',
    ])

    // 2. Personal info only
    const partialProfile = calculateProfileCompleteness({
      userInfo: {
        address: '10 Marina, Lagos',
        dateOfBirth: new Date('1992-05-10'),
        gender: 'FEMALE',
        occupation: 'Analyst',
        phoneNumber: '+2348011112222',
      },
    })
    expect(partialProfile.isComplete).toBe(false)
    expect(partialProfile.completionPercentage).toBe(33)
    expect(partialProfile.hasPersonalInfo).toBe(true)
    expect(partialProfile.missingSections).toContain('Bank Account')
    expect(partialProfile.missingSections).toContain('Next of Kin')

    // 3. Complete profile
    const completeProfile = calculateProfileCompleteness({
      userInfo: {
        address: '10 Marina, Lagos',
        dateOfBirth: new Date('1992-05-10'),
        gender: 'FEMALE',
        occupation: 'Analyst',
        phoneNumber: '+2348011112222',
      },
      bankAccounts: [
        {
          bankName: 'Zenith Bank',
          accountNumber: '1020304050',
          accountName: 'Test Member',
        },
      ],
      nextOfKin: {
        name: 'Jane Doe',
        phoneNumber: '+2348099998888',
        relationship: 'SPOUSE',
      },
    })
    expect(completeProfile.isComplete).toBe(true)
    expect(completeProfile.completionPercentage).toBe(100)
    expect(completeProfile.missingSections).toHaveLength(0)
  })

  it(
    'allows a user with incomplete profile and MembershipStatus.PENDING to sign in while deactivated users are blocked (§1.1, P2-01)',
    async () => {
    // Create an active member with PENDING membership and set password
    const pendingEmail = `${testEmailPrefix}-pending@example.com`
    const pendingPasswordHash = await hash('SecurePass123!', 10)

    const pendingUser = await prisma.user.create({
      data: {
        email: pendingEmail,
        name: 'Pending Member',
        passwordHash: pendingPasswordHash,
        hasSetPassword: true,
        isActive: true,
        role: UserRole.USER,
        membership: {
          create: {
            status: MembershipStatus.PENDING,
          },
        },
      },
      include: { membership: true },
    })

    // Active assertion passes
    expect(() => assertUserActive(pendingUser)).not.toThrow()
    expect(pendingUser.isActive).toBe(true)
    expect(pendingUser.membership?.status).toBe(MembershipStatus.PENDING)

    // Deactivated user is blocked
    const deactivatedEmail = `${testEmailPrefix}-deactivated@example.com`
    const deactivatedUser = await prisma.user.create({
      data: {
        email: deactivatedEmail,
        name: 'Deactivated Member',
        passwordHash: pendingPasswordHash,
        hasSetPassword: true,
        isActive: false,
        deactivationReason: UserDeactivationReason.ADMIN_ACTION,
        deactivatedAt: new Date(),
        role: UserRole.USER,
      },
    })

    expect(() => assertUserActive(deactivatedUser)).toThrowError(/deactivated/)
  }, 20000)

  it('enforces that staff users (OWNER, ADMIN) are never members and cannot participate in products (D-15)', () => {
    const ownerUser = {
      id: 'owner-1',
      role: UserRole.OWNER,
      isActive: true,
      membership: { status: MembershipStatus.APPROVED },
    }

    // Must violate staff-not-member invariant
    expect(() => assertStaffNotMember(ownerUser)).toThrowError(/Staff accounts \(OWNER\/ADMIN\) cannot hold membership/)

    // Must block product eligibility for staff
    expect(() =>
      assertProductEligibility({
        user: ownerUser,
        profile: {
          userInfo: {
            address: '10 Marina',
            dateOfBirth: new Date(),
            gender: 'MALE',
            occupation: 'Admin',
            phoneNumber: '+2348000000000',
          },
          bankAccounts: [{ accountNumber: '1234567890', bankName: 'GTB' }],
          nextOfKin: { name: 'Kin', phoneNumber: '+2348000000001', relationship: 'SPOUSE' },
        },
        productType: 'LOAN',
      }),
    ).toThrowError(/Staff users \(OWNER\) cannot subscribe to or participate in LOAN/)
  })

  it('soft-deactivation and reactivation workflow preserves all financial and audit rows (§4.6, P2-01)', async () => {
    // 1. Fetch system owner to act as deactivator (preserves single OWNER invariant)
    const owner = await prisma.user.findFirstOrThrow({
      where: { role: UserRole.OWNER },
    })

    const auditAccNumber = '311' + String(Date.now()).slice(-7)
    // 2. Create a member with bank accounts and financial records
    const member = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-member@example.com`,
        name: 'Member Under Audit',
        role: UserRole.USER,
        hasSetPassword: true,
        isActive: true,
        bankAccounts: {
          create: {
            bankName: 'First Bank',
            accountNumber: auditAccNumber,
            accountName: 'Member Under Audit',
            isPrimary: true,
          },
        },
      },
      include: { bankAccounts: true },
    })

    mockSessionState.session = {
      user: {
        id: owner.id,
        email: owner.email,
        name: owner.name,
        role: UserRole.OWNER,
        sessionVersion: 0,
      },
    }
    process.env.MOCK_SESSION_USER = JSON.stringify(mockSessionState.session)

    // 3. Deactivate user via action
    const deactResult = await deactivateUserAction({
      userId: member.id,
      reason: UserDeactivationReason.ADMIN_ACTION,
    })
    expect(deactResult.success).toBe(true)

    // Verify soft-deactivation in database
    const refreshed = await prisma.user.findUniqueOrThrow({
      where: { id: member.id },
      include: { bankAccounts: true },
    })
    expect(refreshed.isActive).toBe(false)
    expect(refreshed.deactivationReason).toBe(UserDeactivationReason.ADMIN_ACTION)
    expect(refreshed.deactivatedAt).not.toBeNull()
    expect(refreshed.deactivatedById).toBe(owner.id)

    // Financial rows must NOT be deleted
    expect(refreshed.bankAccounts).toHaveLength(1)
    expect(refreshed.bankAccounts[0].accountNumber).toBe(auditAccNumber)

    // 4. Reactivate user via action
    const reactResult = await reactivateUserAction({
      userId: member.id,
    })
    expect(reactResult.success).toBe(true)

    const reactivated = await prisma.user.findUniqueOrThrow({
      where: { id: member.id },
    })
    expect(reactivated.isActive).toBe(true)
    expect(reactivated.deactivationReason).toBeNull()
    expect(reactivated.deactivatedAt).toBeNull()
  })

  it('enforces unique bank account across active members with an owner-override path (A-22)', async () => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { role: UserRole.OWNER },
    })

    const sharedAccNumber = '058' + String(Date.now()).slice(-7)

    const memberA = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-member-a@example.com`,
        name: 'Member A',
        role: UserRole.USER,
        hasSetPassword: true,
        isActive: true,
        bankAccounts: {
          create: {
            bankCode: '058',
            bankName: 'GTBank',
            accountNumber: sharedAccNumber,
            accountName: 'Member A Account',
          },
        },
      },
    })

    const memberB = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-member-b@example.com`,
        name: 'Member B',
        role: UserRole.USER,
        hasSetPassword: true,
        isActive: true,
      },
    })

    // Member B attempting to add Member A's bank account without override -> blocked
    mockSessionState.session = {
      user: {
        id: memberB.id,
        email: memberB.email,
        name: memberB.name,
        role: UserRole.USER,
        sessionVersion: 0,
      },
    }
    process.env.MOCK_SESSION_USER = JSON.stringify(mockSessionState.session)

    const blockedResult = await addBankAccountAction(memberB.id, {
      bankCode: '058',
      bankName: 'GTBank',
      accountNumber: sharedAccNumber,
      accountName: 'Member B Joint Account',
    })
    expect(blockedResult.success).toBe(false)
    expect(blockedResult.error).toContain('already registered by another member')

    // Owner override with recorded reason -> allowed
    mockSessionState.session = {
      user: {
        id: owner.id,
        email: owner.email,
        name: owner.name,
        role: UserRole.OWNER,
        sessionVersion: 0,
      },
    }
    process.env.MOCK_SESSION_USER = JSON.stringify(mockSessionState.session)

    const overrideResult = await addBankAccountAction(memberB.id, {
      bankCode: '058',
      bankName: 'GTBank',
      accountNumber: sharedAccNumber,
      accountName: 'Member B Joint Account',
      isOverride: true,
      overrideReason: 'Confirmed legitimate spousal joint account with Member A',
    })
    expect(overrideResult.success).toBe(true)
    expect(overrideResult.data?.accountNumber).toBe(sharedAccNumber)

    // Remove Member B's shared bank account so that subsequent invariant checks reflect single accounts
    if (overrideResult.data?.id) {
      await prisma.bankAccount.delete({
        where: { id: overrideResult.data.id },
      })
    }
  })

  it('manages society receiving bank accounts distinctly from member accounts (P2-01)', async () => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { role: UserRole.OWNER },
    })

    mockSessionState.session = {
      user: {
        id: owner.id,
        email: owner.email,
        name: owner.name,
        role: UserRole.OWNER,
        sessionVersion: 0,
      },
    }
    process.env.MOCK_SESSION_USER = JSON.stringify(mockSessionState.session)

    const societyAccount = await createSocietyBankAccountAction({
      bankCode: '011',
      bankName: 'First Bank of Nigeria',
      accountNumber: '2019283746',
      accountName: 'Crystal Kairos Cooperative Society Ltd',
      isActive: true,
    })

    expect(societyAccount.success).toBe(true)
    expect(societyAccount.data?.accountName).toBe('Crystal Kairos Cooperative Society Ltd')
    expect(societyAccount.data?.isActive).toBe(true)

    // Ensure society bank accounts are stored in dedicated table, not mixed with member BankAccount
    const societyDbRecord = await prisma.societyBankAccount.findUnique({
      where: { id: societyAccount.data!.id },
    })
    expect(societyDbRecord).not.toBeNull()
    expect(societyDbRecord?.createdById).toBe(owner.id)
  })

  it('records technical baseline privacy consent (D-21, §1.10)', async () => {
    const user = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-consent@example.com`,
        name: 'Consent Member',
        role: UserRole.USER,
        hasSetPassword: true,
      },
    })

    mockSessionState.session = {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: UserRole.USER,
        sessionVersion: 0,
      },
    }
    process.env.MOCK_SESSION_USER = JSON.stringify(mockSessionState.session)

    const consentResult = await recordPrivacyConsentAction({
      userId: user.id,
      noticeVersion: 'v1.0-rev2',
      ipHash: 'sha256-mock-ip-hash',
      userAgent: 'Mozilla/5.0 Test Suite',
    })

    expect(consentResult.success).toBe(true)
    expect(consentResult.data?.noticeVersion).toBe('v1.0-rev2')

    const dbConsent = await prisma.privacyConsent.findUnique({
      where: {
        userId_noticeVersion: {
          userId: user.id,
          noticeVersion: 'v1.0-rev2',
        },
      },
    })
    expect(dbConsent).not.toBeNull()
    expect(dbConsent?.ipHash).toBe('sha256-mock-ip-hash')
  })

  it('normalises phone numbers to E.164 and validates format', () => {
    expect(normalizePhoneNumber('08012345678')).toBe('+2348012345678')
    expect(normalizePhoneNumber('+2348012345678')).toBe('+2348012345678')
    expect(normalizePhoneNumber(' 0812-345-6789 ')).toBe('+2348123456789')
    expect(() => normalizePhoneNumber('12345')).toThrowError(/invalid/i)
    expect(() => normalizePhoneNumber('')).toThrowError(/required/i)
  })

  it('verifies that the database invariant check script passes with 0 violations', async () => {
    const checkResult = await checkDatabaseInvariants()
    expect(checkResult.passed).toBe(true)
    expect(checkResult.violations).toHaveLength(0)
  })
})
