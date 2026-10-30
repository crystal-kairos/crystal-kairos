import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import {
  AdminPermission,
  MembershipStatus,
  UserRole,
} from '@/generated/prisma/enums'

const mockSessionHolder = {
  session: null as any,
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
import {
  addBankAccountAction,
  setPrimaryBankAccountAction,
  deleteBankAccountAction,
  resolveAccountNameAction,
  getBankListAction,
  createSocietyBankAccountAction,
  getActiveSocietyBankAccountAction,
  getSocietyBankAccountsAction,
  setActiveSocietyBankAccountAction,
  deleteSocietyBankAccountAction,
} from '@/models/members/actions'
import { getMemberById } from '@/models/members/query'
import { setBankProviderForTesting } from '@/lib/banking/paystack.provider'
import { AuditAction } from '@/lib/services/audit.service'

describe('Bank Search/Verification & Society Receiving Accounts (PR P3-02)', () => {
  const timestamp = Date.now()
  const randomSuffix = Math.floor(10000000 + Math.random() * 90000000)
  const testEmailPrefix = `test-p302-${timestamp}`

  const user1Email = `${testEmailPrefix}-user1@test.com`
  const user2Email = `${testEmailPrefix}-user2@test.com`
  const adminEmail = `${testEmailPrefix}-admin@test.com`
  const ownerEmail = `${testEmailPrefix}-owner@test.com`

  let user1Id: string
  let user2Id: string
  let adminId: string
  let ownerId: string

  const testBankCode = '058' // GTBank
  const testAccountNumber1 = String(Math.floor(1000000000 + Math.random() * 9000000000))
  const testAccountNumber2 = String(Math.floor(1000000000 + Math.random() * 9000000000))

  let societyAccount1Id: string
  let societyAccount2Id: string

  beforeEach(async () => {
    delete process.env.MOCK_SESSION_USER
  })

  afterAll(async () => {
    setBankProviderForTesting(null)

    // Cleanup test users and records
    const testUsers = await prisma.user.findMany({
      where: { email: { startsWith: testEmailPrefix } },
      select: { id: true },
    })
    const ids = testUsers.map((u) => u.id)

    if (societyAccount1Id || societyAccount2Id) {
      await prisma.societyBankAccount.deleteMany({
        where: { id: { in: [societyAccount1Id, societyAccount2Id].filter(Boolean) } },
      })
    }

    if (ids.length > 0) {
      await prisma.auditEvent.deleteMany({
        where: { OR: [{ actorId: { in: ids } }, { affectedUserId: { in: ids } }] },
      })
      await prisma.adminPermissionGrant.deleteMany({
        where: { adminUserId: { in: ids } },
      })
      await prisma.bankAccount.deleteMany({ where: { userId: { in: ids } } })
      await prisma.membership.deleteMany({ where: { userId: { in: ids } } })
      await prisma.userInfo.deleteMany({ where: { userId: { in: ids } } })
      await prisma.user.deleteMany({ where: { id: { in: ids } } })
    }
  })

  it('0. Setup test users (2 Members, 1 Staff Admin, 1 Owner)', async () => {
    // User 1
    const u1 = await prisma.user.create({
      data: {
        email: user1Email,
        name: 'Ade Wale Samuel',
        role: UserRole.USER,
        isActive: true,
        membership: {
          create: {
            status: MembershipStatus.APPROVED,
            membershipNumber: `CK-${randomSuffix}`,
          },
        },
      },
    })
    user1Id = u1.id

    // User 2
    const u2 = await prisma.user.create({
      data: {
        email: user2Email,
        name: 'Emeka Chukwu Okafor',
        role: UserRole.USER,
        isActive: true,
        membership: {
          create: {
            status: MembershipStatus.APPROVED,
            membershipNumber: `CK-${randomSuffix + 1}`,
          },
        },
      },
    })
    user2Id = u2.id

    // Owner
    const own = await prisma.user.create({
      data: {
        email: ownerEmail,
        name: 'Cooperative Owner',
        role: UserRole.OWNER,
        isActive: true,
        mfaEnabled: true,
      },
    })
    ownerId = own.id

    // Admin
    const adm = await prisma.user.create({
      data: {
        email: adminEmail,
        name: 'Admin Reviewer',
        role: UserRole.ADMIN,
        isActive: true,
        mfaEnabled: true,
        adminPermissionGrants: {
          create: [
            { permission: AdminPermission.SOCIETY_SETTINGS_MANAGE, grantedById: ownerId },
            { permission: AdminPermission.MEMBERS_READ, grantedById: ownerId },
            { permission: AdminPermission.PROFILE_CHANGES_REVIEW, grantedById: ownerId },
          ],
        },
      },
    })
    adminId = adm.id

    expect(user1Id).toBeDefined()
    expect(user2Id).toBeDefined()
    expect(adminId).toBeDefined()
    expect(ownerId).toBeDefined()
  })

  it('1. Authenticated user can fetch bank list', async () => {
    mockSessionHolder.session = {
      user: { id: user1Id, email: user1Email, name: 'Ade Wale Samuel', role: UserRole.USER },
    }

    const res = await getBankListAction()
    expect(res.success).toBe(true)
    expect(Array.isArray(res.data)).toBe(true)
    expect(res.data!.length).toBeGreaterThan(0)
    expect(res.data![0].name).toBeDefined()
    expect(res.data![0].code).toBeDefined()
  })

  it('2. Account resolver validates account and computes name matching heuristic', async () => {
    mockSessionHolder.session = {
      user: { id: user1Id, email: user1Email, name: 'Ade Wale Samuel', role: UserRole.USER },
    }

    // Custom test mock provider
    setBankProviderForTesting({
      listBanks: async () => [{ name: 'Guaranty Trust Bank', code: testBankCode }],
      resolveAccount: async (code, num) => ({
        accountName: 'ADE WALE SAMUEL',
        accountNumber: num,
        bankCode: code,
      }),
    })

    const res = await resolveAccountNameAction(testBankCode, testAccountNumber1, user1Id)
    expect(res.success).toBe(true)
    expect(res.accountName).toBe('ADE WALE SAMUEL')
    expect(res.accountNumber).toBe(testAccountNumber1)
    expect(res.bankCode).toBe(testBankCode)
    expect(res.nameMatch).toBeDefined()
    expect(res.nameMatch?.isMatch).toBe(true)
  })

  it('3. Enforces primary bank account invariant (first is primary, second is not)', async () => {
    mockSessionHolder.session = {
      user: { id: user1Id, email: user1Email, name: 'Ade Wale Samuel', role: UserRole.USER },
    }

    // Add first account -> must be primary
    const acc1 = await addBankAccountAction(user1Id, {
      bankCode: testBankCode,
      bankName: 'GTBank',
      accountNumber: testAccountNumber1,
      accountName: 'ADE WALE SAMUEL',
    })

    expect(acc1.success).toBe(true)
    expect(acc1.data!.isPrimary).toBe(true)

    // Add second account -> must not be primary
    const acc2 = await addBankAccountAction(user1Id, {
      bankCode: '044',
      bankName: 'Access Bank',
      accountNumber: testAccountNumber2,
      accountName: 'ADE WALE SAMUEL',
    })

    expect(acc2.success).toBe(true)
    expect(acc2.data!.isPrimary).toBe(false)

    // Switch primary account to account 2
    const setPrimaryRes = await setPrimaryBankAccountAction(user1Id, acc2.data!.id)
    expect(setPrimaryRes.success).toBe(true)
    expect(setPrimaryRes.data!.isPrimary).toBe(true)

    const checkAcc1 = await prisma.bankAccount.findUnique({ where: { id: acc1.data!.id } })
    expect(checkAcc1!.isPrimary).toBe(false)

    // Deleting primary account while multiple accounts exist must be blocked
    const deletePrimaryRes = await deleteBankAccountAction(user1Id, acc2.data!.id)
    expect(deletePrimaryRes.success).toBe(false)
    expect(deletePrimaryRes.error).toContain('Cannot delete primary bank account')

    // Deleting non-primary account succeeds
    const deleteSecondaryRes = await deleteBankAccountAction(user1Id, acc1.data!.id)
    expect(deleteSecondaryRes.success).toBe(true)
  })

  it('4. Enforces duplicate active account constraint across members (Rule A-22) with Owner override', async () => {
    // User 1 currently has testAccountNumber2 active
    mockSessionHolder.session = {
      user: { id: user2Id, email: user2Email, name: 'Emeka Chukwu Okafor', role: UserRole.USER },
    }

    // User 2 tries to resolve or add user 1's active bank account -> blocked!
    const resolveConflict = await resolveAccountNameAction('044', testAccountNumber2, user2Id)
    expect(resolveConflict.success).toBe(false)
    expect(resolveConflict.error).toContain('already registered by another member')

    const addConflict = await addBankAccountAction(user2Id, {
      bankCode: '044',
      bankName: 'Access Bank',
      accountNumber: testAccountNumber2,
      accountName: 'EMEKA OKAFOR',
    })
    expect(addConflict.success).toBe(false)
    expect(addConflict.error).toContain('already registered by another member')

    // Non-owner cannot override
    mockSessionHolder.session = {
      user: { id: adminId, email: adminEmail, name: 'Admin Reviewer', role: UserRole.ADMIN },
    }
    const adminOverride = await addBankAccountAction(user2Id, {
      bankCode: '044',
      bankName: 'Access Bank',
      accountNumber: testAccountNumber2,
      accountName: 'EMEKA OKAFOR',
      isOverride: true,
      overrideReason: 'Family joint account',
    })
    expect(adminOverride.success).toBe(false)

    // Owner can override with recorded reason
    mockSessionHolder.session = {
      user: { id: ownerId, email: ownerEmail, name: 'Cooperative Owner', role: UserRole.OWNER },
    }
    const ownerOverride = await addBankAccountAction(user2Id, {
      bankCode: '044',
      bankName: 'Access Bank',
      accountNumber: testAccountNumber2,
      accountName: 'EMEKA OKAFOR',
      isOverride: true,
      overrideReason: 'Verified joint spouse account per board approval',
    })
    expect(ownerOverride.success).toBe(true)
  })

  it('5. Member cannot modify or set another member bank account as primary', async () => {
    mockSessionHolder.session = {
      user: { id: user1Id, email: user1Email, name: 'Ade Wale Samuel', role: UserRole.USER },
    }

    // User 1 attempts to tamper with User 2's bank account
    const user2Account = await prisma.bankAccount.findFirst({ where: { userId: user2Id } })
    expect(user2Account).not.toBeNull()

    const tamperResult = await setPrimaryBankAccountAction(user2Id, user2Account!.id)
    expect(tamperResult.success).toBe(false)
    expect(tamperResult.error).toMatch(/not authorised|Access denied/i)
  })

  it('6. Society receiving account settings: enforce single-active invariant and admin permissions', async () => {
    // Member cannot create society bank account
    mockSessionHolder.session = {
      user: { id: user1Id, email: user1Email, name: 'Ade Wale Samuel', role: UserRole.USER },
    }
    const memberTryCreate = await createSocietyBankAccountAction({
      bankCode: '011',
      bankName: 'First Bank of Nigeria',
      accountNumber: '1111222233',
      accountName: 'Crystal Kairos Cooperative Society',
      isActive: true,
    })
    expect(memberTryCreate.success).toBe(false)

    // Admin with SOCIETY_SETTINGS_MANAGE creates Society Account 1 (Active)
    mockSessionHolder.session = {
      user: { id: adminId, email: adminEmail, name: 'Admin Reviewer', role: UserRole.ADMIN },
    }
    const createRes1 = await createSocietyBankAccountAction({
      bankCode: '011',
      bankName: 'First Bank of Nigeria',
      accountNumber: '1111222233',
      accountName: 'Crystal Kairos Cooperative Society',
      isActive: true,
    })
    expect(createRes1.success).toBe(true)
    societyAccount1Id = createRes1.data!.id
    expect(createRes1.data!.isActive).toBe(true)

    // Admin creates Society Account 2 (Active) -> Account 1 must be deactivated automatically
    const createRes2 = await createSocietyBankAccountAction({
      bankCode: '058',
      bankName: 'Guaranty Trust Bank',
      accountNumber: '4444555566',
      accountName: 'Crystal Kairos Cooperative Society',
      isActive: true,
    })
    expect(createRes2.success).toBe(true)
    societyAccount2Id = createRes2.data!.id
    expect(createRes2.data!.isActive).toBe(true)

    // Verify account 1 was deactivated
    const account1Record = await prisma.societyBankAccount.findUnique({
      where: { id: societyAccount1Id },
    })
    expect(account1Record!.isActive).toBe(false)

    // Fetch active account (any authenticated member can access)
    mockSessionHolder.session = {
      user: { id: user1Id, email: user1Email, name: 'Ade Wale Samuel', role: UserRole.USER },
    }
    const activeRes = await getActiveSocietyBankAccountAction()
    expect(activeRes.success).toBe(true)
    expect(activeRes.data!.id).toBe(societyAccount2Id)
    expect(activeRes.data!.accountNumber).toBe('4444555566')

    // Admin switches active back to Account 1
    mockSessionHolder.session = {
      user: { id: adminId, email: adminEmail, name: 'Admin Reviewer', role: UserRole.ADMIN },
    }
    const switchRes = await setActiveSocietyBankAccountAction(societyAccount1Id)
    expect(switchRes.success).toBe(true)

    const activeAfterSwitch = await getActiveSocietyBankAccountAction()
    expect(activeAfterSwitch.data!.id).toBe(societyAccount1Id)

    // Deleting the active receiving account must be blocked
    const deleteActiveRes = await deleteSocietyBankAccountAction(societyAccount1Id)
    expect(deleteActiveRes.success).toBe(false)
    expect(deleteActiveRes.error).toContain('Cannot delete the active receiving account')

    // Deleting inactive account succeeds
    const deleteInactiveRes = await deleteSocietyBankAccountAction(societyAccount2Id)
    expect(deleteInactiveRes.success).toBe(true)
  })

  it('7. Staff viewing member bank details records immutable audit event (P2-06)', async () => {
    // Admin views User 1 details
    mockSessionHolder.session = {
      user: { id: adminId, email: adminEmail, name: 'Admin Reviewer', role: UserRole.ADMIN },
    }

    const memberDetailsRes = await getMemberById(user1Id)
    expect(memberDetailsRes.success).toBe(true)

    // Verify audit event was logged
    const auditEvent = await prisma.auditEvent.findFirst({
      where: {
        actorId: adminId,
        affectedUserId: user1Id,
        action: AuditAction.STAFF_MEMBER_BANK_VIEWED,
      },
    })

    expect(auditEvent).not.toBeNull()
    expect(auditEvent!.actorRole).toBe(UserRole.ADMIN)
    expect(auditEvent!.affectedUserId).toBe(user1Id)
  })
})
