import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import {
  AdminPermission,
  MembershipStatus,
  ProfileChangeStatus,
  ProfileChangeType,
  Relationship,
  UserRole,
} from '@/generated/prisma/enums'

const mockSessionHolder = {
  session: null as { user: { id: string; role: UserRole; email: string } } | null,
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
  deleteBankAccountAction,
  resolveAccountNameAction,
  setPrimaryBankAccountAction,
  updateNextOfKinAction,
} from '@/models/members/actions'
import {
  requestNextOfKinChangeAction,
  requestPrimaryBankAccountChangeAction,
  requestBankDetailsChangeAction,
  getMemberPendingProfileChangesAction,
  getMyProfileChangeHistoryAction,
  cancelProfileChangeRequestAction,
} from '@/models/members/profile-change-actions'
import { setBankProviderForTesting } from '@/lib/banking/paystack.provider'
import {
  approveProfileChangeRequestAction,
  rejectProfileChangeRequestAction,
  getProfileChangeRequestsAction,
} from '@/models/admin/profile-change-actions'
import { AuditAction } from '@/lib/services/audit.service'

describe('PR P3-02B — Require Admin Approval for Sensitive Profile Changes', () => {
  const timestamp = Date.now()
  const testEmailPrefix = `test-p302b-${timestamp}`

  const user1Email = `${testEmailPrefix}-user1@test.com`
  const user2Email = `${testEmailPrefix}-user2@test.com`
  const adminEmail = `${testEmailPrefix}-admin@test.com`
  const ownerEmail = `${testEmailPrefix}-owner@test.com`

  let user1Id: string
  let user2Id: string
  let adminId: string
  let ownerId: string

  let admin2Id: string
  let bankAccount1Id: string
  let bankAccount2Id: string

  // Per-run 10-digit account numbers so leftovers from other runs never trigger A-22.
  const runDigits = String(timestamp).slice(-6)
  const acct = (prefix: string, tail: string) => `${prefix}${runDigits}${tail}`
  const ACC_MEMBER1_SECOND = acct('99', '77')
  const ACC_MEMBER1_NEW_DETAILS = acct('77', '11')
  const ACC_MEMBER1_RACE = acct('77', '22')
  const ACC_MEMBER2_FIRST = acct('66', '22')
  const ACC_MEMBER2_SECOND = acct('66', '33')
  const ACC_MISMATCH = acct('55', '11')

  const RESOLVED_NAMES: Record<string, string> = {
    [ACC_MEMBER2_FIRST]: 'MEMBER TWO',
    [ACC_MEMBER2_SECOND]: 'MEMBER TWO',
    [ACC_MISMATCH]: 'TOTALLY DIFFERENT PERSON',
  }

  const nokInput = (name: string) => ({
    name,
    phoneNumber: '08077778888',
    relationship: Relationship.SIBLING,
    occupation: 'Architect',
    address: '77 Broad Street',
    bankName: 'UBA',
    accountNumber: '1029384756',
    accountName: `${name} Account`,
  })

  // Note: each action reads the mocked session when it starts, so in the concurrency tests
  // a session set immediately before an action call is the one that action uses.
  const asUser = (id: string, role: UserRole, email: string) => {
    mockSessionHolder.session = { user: { id, role, email } }
  }

  beforeEach(async () => {
    delete process.env.MOCK_SESSION_USER
    setBankProviderForTesting({
      listBanks: async () => [
        { name: 'Guaranty Trust Bank', code: '058' },
        { name: 'Access Bank', code: '044' },
        { name: 'Zenith Bank', code: '057' },
      ],
      resolveAccount: async (code, num) => ({
        accountName: RESOLVED_NAMES[num] ?? 'MEMBER ONE',
        accountNumber: num,
        bankCode: code,
      }),
    })
  })

  afterAll(async () => {
    setBankProviderForTesting(null)
    // Cleanup test users and records
    const testUsers = await prisma.user.findMany({
      where: { email: { startsWith: testEmailPrefix } },
      select: { id: true },
    })
    const ids = testUsers.map((u) => u.id)

    if (ids.length > 0) {
      await prisma.profileChangeRequest.deleteMany({
        where: { OR: [{ userId: { in: ids } }, { reviewedById: { in: ids } }] },
      })
      await prisma.auditEvent.deleteMany({
        where: { OR: [{ actorId: { in: ids } }, { affectedUserId: { in: ids } }] },
      })
      await prisma.adminPermissionGrant.deleteMany({
        where: { adminUserId: { in: ids } },
      })
      await prisma.bankAccount.deleteMany({ where: { userId: { in: ids } } })
      await prisma.nextOfKin.deleteMany({ where: { userId: { in: ids } } })
      await prisma.membership.deleteMany({ where: { userId: { in: ids } } })
      await prisma.userInfo.deleteMany({ where: { userId: { in: ids } } })
      await prisma.user.deleteMany({ where: { id: { in: ids } } })
    }
  })

  it('0. Setup test users (2 Members, 1 Staff Admin with PROFILE_CHANGES_REVIEW, 1 Owner)', async () => {
    // User 1
    const u1 = await prisma.user.create({
      data: {
        email: user1Email,
        name: 'Member One',
        role: UserRole.USER,
        isActive: true,
      },
    })
    user1Id = u1.id

    await prisma.membership.create({
      data: {
        userId: user1Id,
        membershipNumber: `M1-${timestamp}`,
        status: MembershipStatus.APPROVED,
      },
    })

    // User 2
    const u2 = await prisma.user.create({
      data: {
        email: user2Email,
        name: 'Member Two',
        role: UserRole.USER,
        isActive: true,
      },
    })
    user2Id = u2.id

    await prisma.membership.create({
      data: {
        userId: user2Id,
        membershipNumber: `M2-${timestamp}`,
        status: MembershipStatus.APPROVED,
      },
    })

    // Owner
    const owner = await prisma.user.create({
      data: {
        email: ownerEmail,
        name: 'Society Owner',
        role: UserRole.OWNER,
        isActive: true,
        mfaEnabled: true,
      },
    })
    ownerId = owner.id

    // Admin with PROFILE_CHANGES_REVIEW
    const admin = await prisma.user.create({
      data: {
        email: adminEmail,
        name: 'Staff Reviewer',
        role: UserRole.ADMIN,
        isActive: true,
        mfaEnabled: true,
      },
    })
    adminId = admin.id

    await prisma.adminPermissionGrant.createMany({
      data: [
        {
          adminUserId: adminId,
          permission: AdminPermission.PROFILE_CHANGES_REVIEW,
          grantedById: ownerId,
        },
        {
          adminUserId: adminId,
          permission: AdminPermission.MEMBERS_READ,
          grantedById: ownerId,
        },
      ],
    })

    // Seed initial Next of Kin for User 1
    await prisma.nextOfKin.create({
      data: {
        userId: user1Id,
        name: 'Uncle Bob',
        phoneNumber: '08011112222',
        relationship: Relationship.OTHER,
        occupation: 'Trader',
        address: '10 Old Road, Lagos',
        bankName: 'GTBank',
        accountNumber: '0123456789',
        accountName: 'Bob Uncle',
      },
    })

    // Seed initial primary bank account for User 1
    const acc1 = await prisma.bankAccount.create({
      data: {
        userId: user1Id,
        bankName: 'GTBank',
        bankCode: '058',
        accountNumber: '1111222233',
        accountName: 'Member One',
        isPrimary: true,
        isVerified: true,
      },
    })
    bankAccount1Id = acc1.id

    expect(user1Id).toBeDefined()
    expect(adminId).toBeDefined()
    expect(bankAccount1Id).toBeDefined()
  })

  it('1. Member submits Next of Kin change; active DB value remains UNCHANGED while pending', async () => {
    mockSessionHolder.session = {
      user: { id: user1Id, role: UserRole.USER, email: user1Email },
    }

    const proposedNok = {
      name: 'Aunt Alice',
      phoneNumber: '08099998888',
      relationship: Relationship.SIBLING,
      occupation: 'Lecturer',
      address: '45 University Way, Ibadan',
      bankName: 'Zenith Bank',
      accountNumber: '2222333344',
      accountName: 'Alice Aunt',
    }

    const res = await requestNextOfKinChangeAction(user1Id, proposedNok)
    expect(res.success).toBe(true)
    expect(res.data?.status).toBe(ProfileChangeStatus.PENDING)
    expect(res.data?.changeType).toBe(ProfileChangeType.NEXT_OF_KIN)

    // Active Next of Kin in DB MUST STILL BE Uncle Bob!
    const activeNok = await prisma.nextOfKin.findUnique({
      where: { userId: user1Id },
    })
    expect(activeNok?.name).toBe('Uncle Bob')
    expect(activeNok?.phoneNumber).toBe('08011112222')
  })

  it('2. Admin rejects Next of Kin change; active value is preserved and rejection reason is recorded', async () => {
    // Find the pending request
    const pending = await prisma.profileChangeRequest.findFirst({
      where: { userId: user1Id, status: ProfileChangeStatus.PENDING },
    })
    expect(pending).toBeDefined()

    // Staff admin session
    mockSessionHolder.session = {
      user: { id: adminId, role: UserRole.ADMIN, email: adminEmail },
    }

    const rejectRes = await rejectProfileChangeRequestAction(
      pending!.id,
      'Contact number could not be verified by cooperative secretary.',
    )
    expect(rejectRes.success).toBe(true)

    // Verify request status in DB
    const updatedRequest = await prisma.profileChangeRequest.findUnique({
      where: { id: pending!.id },
    })
    expect(updatedRequest?.status).toBe(ProfileChangeStatus.REJECTED)
    expect(updatedRequest?.reviewedById).toBe(adminId)
    expect(updatedRequest?.rejectionReason).toContain('could not be verified')

    // Active Next of Kin MUST STILL BE Uncle Bob!
    const activeNok = await prisma.nextOfKin.findUnique({
      where: { userId: user1Id },
    })
    expect(activeNok?.name).toBe('Uncle Bob')
  })

  it('3. Member submits new Next of Kin change; Admin approves it; DB is updated in transaction', async () => {
    // Member session
    mockSessionHolder.session = {
      user: { id: user1Id, role: UserRole.USER, email: user1Email },
    }

    const newNok = {
      name: 'Aunt Alice Updated',
      phoneNumber: '08055556666',
      relationship: Relationship.SIBLING,
      occupation: 'Senior Lecturer',
      address: '45 University Way, Ibadan',
      bankName: 'Zenith Bank',
      accountNumber: '2222333344',
      accountName: 'Alice Aunt Updated',
    }

    const subRes = await requestNextOfKinChangeAction(user1Id, newNok)
    expect(subRes.success).toBe(true)
    const requestId = subRes.data!.id

    // Staff admin session
    mockSessionHolder.session = {
      user: { id: adminId, role: UserRole.ADMIN, email: adminEmail },
    }

    const approveRes = await approveProfileChangeRequestAction(requestId)
    expect(approveRes.success).toBe(true)

    // Verify request record
    const approvedRequest = await prisma.profileChangeRequest.findUnique({
      where: { id: requestId },
    })
    expect(approvedRequest?.status).toBe(ProfileChangeStatus.APPROVED)
    expect(approvedRequest?.reviewedById).toBe(adminId)

    // Verify active Next of Kin in DB is now updated to Aunt Alice Updated!
    const activeNok = await prisma.nextOfKin.findUnique({
      where: { userId: user1Id },
    })
    expect(activeNok?.name).toBe('Aunt Alice Updated')
    expect(activeNok?.phoneNumber).toBe('08055556666')
    expect(activeNok?.bankName).toBe('Zenith Bank')
  })

  it('4. Adding a second verified bank account creates it with isPrimary: false', async () => {
    // Member session
    mockSessionHolder.session = {
      user: { id: user1Id, role: UserRole.USER, email: user1Email },
    }

    const addRes = await addBankAccountAction(user1Id, {
      bankName: 'Access Bank',
      bankCode: '044',
      accountNumber: ACC_MEMBER1_SECOND,
      accountName: 'Member One',
    })

    expect(addRes.success).toBe(true)
    bankAccount2Id = addRes.data!.id

    const acc2 = await prisma.bankAccount.findUnique({
      where: { id: bankAccount2Id },
    })
    expect(acc2?.isPrimary).toBe(false)

    // Original account must still be primary
    const acc1 = await prisma.bankAccount.findUnique({
      where: { id: bankAccount1Id },
    })
    expect(acc1?.isPrimary).toBe(true)
  })

  it('5. Member requests to make Account 2 primary; active primary remains Account 1 while pending', async () => {
    mockSessionHolder.session = {
      user: { id: user1Id, role: UserRole.USER, email: user1Email },
    }

    const reqRes = await requestPrimaryBankAccountChangeAction(bankAccount2Id)
    expect(reqRes.success).toBe(true)
    expect(reqRes.data?.status).toBe(ProfileChangeStatus.PENDING)
    expect(reqRes.data?.changeType).toBe(ProfileChangeType.PRIMARY_BANK)

    // Active primary in DB MUST still be Account 1
    const acc1 = await prisma.bankAccount.findUnique({
      where: { id: bankAccount1Id },
    })
    const acc2 = await prisma.bankAccount.findUnique({
      where: { id: bankAccount2Id },
    })
    expect(acc1?.isPrimary).toBe(true)
    expect(acc2?.isPrimary).toBe(false)
  })

  it('6. Admin approves primary bank request; Account 2 becomes primary and Account 1 becomes non-primary (Invariant maintained)', async () => {
    const pending = await prisma.profileChangeRequest.findFirst({
      where: {
        userId: user1Id,
        changeType: ProfileChangeType.PRIMARY_BANK,
        status: ProfileChangeStatus.PENDING,
      },
    })
    expect(pending).toBeDefined()

    // Staff admin session
    mockSessionHolder.session = {
      user: { id: adminId, role: UserRole.ADMIN, email: adminEmail },
    }

    const approveRes = await approveProfileChangeRequestAction(pending!.id)
    expect(approveRes.success).toBe(true)

    // Verify DB states: Account 2 is now primary, Account 1 is non-primary
    const acc1 = await prisma.bankAccount.findUnique({
      where: { id: bankAccount1Id },
    })
    const acc2 = await prisma.bankAccount.findUnique({
      where: { id: bankAccount2Id },
    })
    expect(acc2?.isPrimary).toBe(true)
    expect(acc1?.isPrimary).toBe(false)

    // Invariant check: exactly one primary account
    const primaryCount = await prisma.bankAccount.count({
      where: { userId: user1Id, isPrimary: true },
    })
    expect(primaryCount).toBe(1)
  })

  it('7. Staff cannot submit profile changes, and requests about staff accounts cannot be reviewed (D-15)', async () => {
    // A staff user has no member record, so the member submission path refuses them.
    asUser(adminId, UserRole.ADMIN, adminEmail)
    const staffSubmit = await requestNextOfKinChangeAction(adminId, nokInput('Staff Kin'))
    expect(staffSubmit.success).toBe(false)

    // Defence in depth: even a request row for a staff account (inserted directly) is never applied,
    // neither by the staff user themself nor by the owner.
    const staffReq = await prisma.profileChangeRequest.create({
      data: {
        userId: adminId,
        changeType: ProfileChangeType.NEXT_OF_KIN,
        proposedValue: nokInput('Staff Kin'),
      },
    })
    try {
      const selfApprove = await approveProfileChangeRequestAction(staffReq.id)
      expect(selfApprove.success).toBe(false)
      expect(selfApprove.error).toContain('Separation of duties')

      asUser(ownerId, UserRole.OWNER, ownerEmail)
      const ownerApprove = await approveProfileChangeRequestAction(staffReq.id)
      expect(ownerApprove.success).toBe(false)
      expect(ownerApprove.code).toBe('STAFF_CANNOT_BE_MEMBER')

      const staffNok = await prisma.nextOfKin.findUnique({ where: { userId: adminId } })
      expect(staffNok).toBeNull()
    } finally {
      await prisma.profileChangeRequest.delete({ where: { id: staffReq.id } })
    }
  })

  it('8. Unauthorised user cannot approve or review change requests', async () => {
    asUser(user1Id, UserRole.USER, user1Email)
    const subRes = await requestNextOfKinChangeAction(user1Id, nokInput('Brother Ben'))
    expect(subRes.success).toBe(true)
    const reqId = subRes.data!.id

    // User 2 (a member, no staff permissions) tries to approve and reject
    asUser(user2Id, UserRole.USER, user2Email)
    expect((await approveProfileChangeRequestAction(reqId)).success).toBe(false)
    expect((await rejectProfileChangeRequestAction(reqId, 'Malicious reject')).success).toBe(false)

    // A member cannot submit on behalf of another member
    const forged = await requestNextOfKinChangeAction(user1Id, nokInput('Forged Kin'))
    expect(forged.success).toBe(false)
  })

  it('9. Idempotency: Cannot approve or reject a request that is not PENDING', async () => {
    asUser(adminId, UserRole.ADMIN, adminEmail)
    const pending = await prisma.profileChangeRequest.findFirst({
      where: { userId: user1Id, status: ProfileChangeStatus.PENDING },
    })
    expect(pending).toBeDefined()

    expect((await approveProfileChangeRequestAction(pending!.id)).success).toBe(true)

    const secondApprove = await approveProfileChangeRequestAction(pending!.id)
    expect(secondApprove.success).toBe(false)
    expect(secondApprove.error).toContain('Only PENDING requests can be reviewed')

    const rejectAfterApprove = await rejectProfileChangeRequestAction(pending!.id, 'Too late to reject')
    expect(rejectAfterApprove.success).toBe(false)
    expect(rejectAfterApprove.error).toContain('Only PENDING requests can be reviewed')

    // Rejection reason is mandatory
    asUser(user1Id, UserRole.USER, user1Email)
    const another = await requestNextOfKinChangeAction(user1Id, nokInput('Cousin Cal'))
    asUser(adminId, UserRole.ADMIN, adminEmail)
    const noReason = await rejectProfileChangeRequestAction(another.data!.id, '  ')
    expect(noReason.success).toBe(false)
    expect(noReason.code).toBe('VALIDATION_ERROR')
    expect((await rejectProfileChangeRequestAction(another.data!.id, 'Not verifiable')).success).toBe(true)
  })

  it('10. Member can cancel their own pending request, but cannot cancel other members requests', async () => {
    asUser(user1Id, UserRole.USER, user1Email)
    const reqRes = await requestPrimaryBankAccountChangeAction(bankAccount1Id)
    expect(reqRes.success).toBe(true)
    const reqId = reqRes.data!.id

    asUser(user2Id, UserRole.USER, user2Email)
    const badCancel = await cancelProfileChangeRequestAction(reqId)
    expect(badCancel.success).toBe(false)
    expect(badCancel.code).toBe('NOT_FOUND')

    asUser(user1Id, UserRole.USER, user1Email)
    expect((await cancelProfileChangeRequestAction(reqId)).success).toBe(true)
    const again = await cancelProfileChangeRequestAction(reqId)
    expect(again.success).toBe(false)
    expect(again.code).toBe('STALE_STATE')

    const cancelledReq = await prisma.profileChangeRequest.findUnique({ where: { id: reqId } })
    expect(cancelledReq?.status).toBe(ProfileChangeStatus.CANCELLED)
  })

  it('11. Audit events use distinct actions, name the affected member and carry no member email', async () => {
    const auditLogs = await prisma.auditEvent.findMany({
      where: { entityType: 'ProfileChangeRequest', affectedUserId: user1Id },
    })
    const actions = auditLogs.map((l) => l.action)
    expect(actions).toContain(AuditAction.PROFILE_CHANGE_SUBMITTED)
    expect(actions).toContain(AuditAction.PROFILE_CHANGE_APPROVED)
    expect(actions).toContain(AuditAction.PROFILE_CHANGE_REJECTED)
    expect(actions).toContain(AuditAction.PROFILE_CHANGE_CANCELLED)
    for (const log of auditLogs) {
      expect(JSON.stringify(log.metadata ?? {})).not.toContain('@test.com')
    }
  })

  it('12. BANK_DETAILS: member requests new details, nothing changes until approval, approval applies resolved values', async () => {
    asUser(user1Id, UserRole.USER, user1Email)
    const before = await prisma.bankAccount.findUnique({ where: { id: bankAccount1Id } })

    const res = await requestBankDetailsChangeAction(bankAccount1Id, {
      bankCode: '057',
      accountNumber: ACC_MEMBER1_NEW_DETAILS,
    })
    expect(res.success).toBe(true)
    expect(res.data?.changeType).toBe(ProfileChangeType.BANK_DETAILS)
    // Full account numbers never leave the server in the response
    expect(JSON.stringify(res.data)).not.toContain(ACC_MEMBER1_NEW_DETAILS)
    expect(JSON.stringify(res.data)).not.toContain(before!.accountNumber)

    const pendingAcc = await prisma.bankAccount.findUnique({ where: { id: bankAccount1Id } })
    expect(pendingAcc?.accountNumber).toBe(before!.accountNumber)

    asUser(adminId, UserRole.ADMIN, adminEmail)
    expect((await approveProfileChangeRequestAction(res.data!.id)).success).toBe(true)

    const after = await prisma.bankAccount.findUnique({ where: { id: bankAccount1Id } })
    expect(after?.bankCode).toBe('057')
    expect(after?.bankName).toBe('Zenith Bank')
    expect(after?.accountNumber).toBe(ACC_MEMBER1_NEW_DETAILS)
    expect(after?.accountName).toBe('MEMBER ONE')
    expect(after?.isPrimary).toBe(before!.isPrimary)

    // History keeps the previous number on the request row (not in list views)
    const stored = await prisma.profileChangeRequest.findUnique({ where: { id: res.data!.id } })
    expect((stored?.previousValue as { accountNumber?: string } | null)?.accountNumber).toBe(before!.accountNumber)
  })

  it('13. BANK_DETAILS: invalid input, unchanged details and A-22 conflicts are refused (also at approval time)', async () => {
    asUser(user2Id, UserRole.USER, user2Email)
    const u2Add = await addBankAccountAction(user2Id, {
      bankCode: '058',
      bankName: 'GTBank',
      accountNumber: ACC_MEMBER2_FIRST,
    })
    expect(u2Add.success).toBe(true)

    asUser(user1Id, UserRole.USER, user1Email)
    const invalid = await requestBankDetailsChangeAction(bankAccount1Id, { bankCode: '057', accountNumber: '12ab' })
    expect(invalid.success).toBe(false)
    expect(invalid.code).toBe('VALIDATION_ERROR')

    const same = await requestBankDetailsChangeAction(bankAccount1Id, {
      bankCode: '057',
      accountNumber: ACC_MEMBER1_NEW_DETAILS,
    })
    expect(same.success).toBe(false)

    const conflict = await requestBankDetailsChangeAction(bankAccount1Id, {
      bankCode: '058',
      accountNumber: ACC_MEMBER2_FIRST,
    })
    expect(conflict.success).toBe(false)
    expect(conflict.error).toContain('already registered by another member')

    // Submitted while free...
    const raced = await requestBankDetailsChangeAction(bankAccount1Id, {
      bankCode: '058',
      accountNumber: ACC_MEMBER1_RACE,
    })
    expect(raced.success).toBe(true)

    // ...then another member registers the same account before review.
    await prisma.bankAccount.create({
      data: {
        userId: user2Id,
        bankCode: '058',
        bankName: 'Guaranty Trust Bank',
        accountNumber: ACC_MEMBER1_RACE,
        accountName: 'MEMBER TWO',
        isVerified: true,
      },
    })

    asUser(adminId, UserRole.ADMIN, adminEmail)
    const approve = await approveProfileChangeRequestAction(raced.data!.id)
    expect(approve.success).toBe(false)
    expect(approve.error).toContain('registered by another member')

    // The failed approval rolled back: request still PENDING, account untouched
    const stillPending = await prisma.profileChangeRequest.findUnique({ where: { id: raced.data!.id } })
    expect(stillPending?.status).toBe(ProfileChangeStatus.PENDING)
    const acc = await prisma.bankAccount.findUnique({ where: { id: bankAccount1Id } })
    expect(acc?.accountNumber).toBe(ACC_MEMBER1_NEW_DETAILS)

    expect((await rejectProfileChangeRequestAction(raced.data!.id, 'Account now belongs to another member')).success).toBe(true)
  })

  it('14. Concurrency: simultaneous approve and reject of one request — exactly one wins', async () => {
    asUser(user1Id, UserRole.USER, user1Email)
    const sub = await requestNextOfKinChangeAction(user1Id, nokInput('Race Kin'))
    expect(sub.success).toBe(true)
    const nokBefore = await prisma.nextOfKin.findUnique({ where: { userId: user1Id } })

    // Several approvals (admin) and rejections (owner) fire at the same time.
    const attempts = Array.from({ length: 4 }, () => [
      (async () => {
        asUser(adminId, UserRole.ADMIN, adminEmail)
        return { kind: 'approve' as const, res: await approveProfileChangeRequestAction(sub.data!.id) }
      })(),
      (async () => {
        asUser(ownerId, UserRole.OWNER, ownerEmail)
        return {
          kind: 'reject' as const,
          res: await rejectProfileChangeRequestAction(sub.data!.id, 'Owner rejects in parallel'),
        }
      })(),
    ]).flat()
    const outcomes = await Promise.all(attempts)

    const winners = outcomes.filter((o) => o.res.success)
    expect(winners).toHaveLength(1)
    const approveRes = { success: winners[0].kind === 'approve' }

    const finalReq = await prisma.profileChangeRequest.findUnique({ where: { id: sub.data!.id } })
    const nokAfter = await prisma.nextOfKin.findUnique({ where: { userId: user1Id } })
    if (approveRes.success) {
      expect(finalReq?.status).toBe(ProfileChangeStatus.APPROVED)
      expect(nokAfter?.name).toBe('Race Kin')
    } else {
      expect(finalReq?.status).toBe(ProfileChangeStatus.REJECTED)
      expect(nokAfter?.name).toBe(nokBefore?.name)
    }
  })

  it('14b. Concurrency: a decision based on a stale PENDING read cannot overwrite an earlier decision', async () => {
    // Deterministic version of the race: the second reviewer's pre-check saw PENDING,
    // but the first reviewer committed before the second reached its transaction.
    asUser(user1Id, UserRole.USER, user1Email)
    const sub = await requestNextOfKinChangeAction(user1Id, nokInput('Stale Read Kin'))
    expect(sub.success).toBe(true)

    const staleSnapshot = await prisma.profileChangeRequest.findUnique({
      where: { id: sub.data!.id },
      select: {
        id: true,
        userId: true,
        changeType: true,
        status: true,
        proposedValue: true,
        user: { select: { role: true } },
      },
    })
    expect(staleSnapshot?.status).toBe(ProfileChangeStatus.PENDING)

    asUser(adminId, UserRole.ADMIN, adminEmail)
    expect((await approveProfileChangeRequestAction(sub.data!.id)).success).toBe(true)

    // The owner's reject now runs with the stale PENDING pre-read.
    const spy = vi
      .spyOn(prisma.profileChangeRequest, 'findUnique')
      .mockResolvedValueOnce(staleSnapshot as never)
    asUser(ownerId, UserRole.OWNER, ownerEmail)
    const lateReject = await rejectProfileChangeRequestAction(sub.data!.id, 'Late stale reject')
    spy.mockRestore()

    expect(lateReject.success).toBe(false)
    expect(lateReject.code).toBe('STALE_STATE')

    const finalReq = await prisma.profileChangeRequest.findUnique({ where: { id: sub.data!.id } })
    expect(finalReq?.status).toBe(ProfileChangeStatus.APPROVED)
    expect(finalReq?.rejectionReason).toBeNull()
    expect(finalReq?.reviewedById).toBe(adminId)
  })

  it('15. Concurrency: duplicate simultaneous submissions create only one PENDING request', async () => {
    asUser(user1Id, UserRole.USER, user1Email)
    const results = await Promise.all([
      requestPrimaryBankAccountChangeAction(bankAccount1Id),
      requestPrimaryBankAccountChangeAction(bankAccount1Id),
      requestPrimaryBankAccountChangeAction(bankAccount1Id),
    ])
    expect(results.filter((r) => r.success)).toHaveLength(1)

    const pendingCount = await prisma.profileChangeRequest.count({
      where: {
        userId: user1Id,
        changeType: ProfileChangeType.PRIMARY_BANK,
        status: ProfileChangeStatus.PENDING,
      },
    })
    expect(pendingCount).toBe(1)
  })

  it('16. Concurrency: approval racing a staff primary switch still leaves exactly one primary account', async () => {
    const pending = await prisma.profileChangeRequest.findFirst({
      where: {
        userId: user1Id,
        changeType: ProfileChangeType.PRIMARY_BANK,
        status: ProfileChangeStatus.PENDING,
      },
    })
    expect(pending).toBeDefined()

    const approveP = (async () => {
      asUser(adminId, UserRole.ADMIN, adminEmail)
      return approveProfileChangeRequestAction(pending!.id) // -> account 1
    })()
    const directP = (async () => {
      asUser(ownerId, UserRole.OWNER, ownerEmail)
      return setPrimaryBankAccountAction(user1Id, bankAccount2Id) // -> account 2
    })()
    const [a, b] = await Promise.all([approveP, directP])
    expect(a.success).toBe(true)
    expect(b.success).toBe(true)

    const primaryCount = await prisma.bankAccount.count({ where: { userId: user1Id, isPrimary: true } })
    expect(primaryCount).toBe(1)
  })

  it('17. Delete rules: members cannot remove a primary (even a sole one) or an account with a pending request', async () => {
    asUser(user2Id, UserRole.USER, user2Email)
    const primary = await prisma.bankAccount.findFirst({ where: { userId: user2Id, isPrimary: true } })
    expect(primary).not.toBeNull()

    // Member 2 also has the A-22 test row; remove it so the primary is their only account.
    await prisma.bankAccount.deleteMany({ where: { userId: user2Id, isPrimary: false } })

    const delSole = await deleteBankAccountAction(user2Id, primary!.id)
    expect(delSole.success).toBe(false)
    expect(delSole.error).toContain('Cannot delete primary bank account')

    const second = await addBankAccountAction(user2Id, {
      bankCode: '044',
      bankName: 'Access Bank',
      accountNumber: ACC_MEMBER2_SECOND,
    })
    expect(second.success).toBe(true)
    expect(second.data!.isPrimary).toBe(false)

    const req = await requestPrimaryBankAccountChangeAction(second.data!.id)
    expect(req.success).toBe(true)

    const delPending = await deleteBankAccountAction(user2Id, second.data!.id)
    expect(delPending.success).toBe(false)
    expect(delPending.error).toContain('pending change request')

    expect((await cancelProfileChangeRequestAction(req.data!.id)).success).toBe(true)
    const delOk = await deleteBankAccountAction(user2Id, second.data!.id)
    expect(delOk.success).toBe(true)

    const removedAudit = await prisma.auditEvent.findFirst({
      where: { action: AuditAction.MEMBER_BANK_ACCOUNT_REMOVED, entityId: second.data!.id },
    })
    expect(removedAudit).not.toBeNull()
    expect(JSON.stringify(removedAudit!.beforeState)).not.toContain(ACC_MEMBER2_SECOND)
  })

  it('18. Pending-change lookup requires ownership or PROFILE_CHANGES_REVIEW / MEMBERS_READ, and is redacted', async () => {
    const admin2 = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-admin2@test.com`,
        name: 'Loans Only Admin',
        role: UserRole.ADMIN,
        isActive: true,
        mfaEnabled: true,
      },
    })
    admin2Id = admin2.id
    await prisma.adminPermissionGrant.create({
      data: { adminUserId: admin2Id, permission: AdminPermission.LOANS_READ, grantedById: ownerId },
    })

    asUser(user1Id, UserRole.USER, user1Email)
    await requestNextOfKinChangeAction(user1Id, nokInput('Lookup Kin'))

    asUser(admin2Id, UserRole.ADMIN, `${testEmailPrefix}-admin2@test.com`)
    expect((await getMemberPendingProfileChangesAction(user1Id)).success).toBe(false)

    asUser(user2Id, UserRole.USER, user2Email)
    expect((await getMemberPendingProfileChangesAction(user1Id)).success).toBe(false)

    asUser(adminId, UserRole.ADMIN, adminEmail)
    const allowed = await getMemberPendingProfileChangesAction(user1Id)
    expect(allowed.success).toBe(true)
    const nokReq = allowed.data!.find((r) => r.changeType === ProfileChangeType.NEXT_OF_KIN)
    expect((nokReq?.proposedValue as { accountNumber?: string } | null)?.accountNumber).toBeUndefined()
    expect((nokReq?.proposedValue as { accountNumberMasked?: string } | null)?.accountNumberMasked).toBe('******4756')

    const queue = await getProfileChangeRequestsAction({ status: ProfileChangeStatus.PENDING, limit: 100 })
    expect(queue.success).toBe(true)
    expect(JSON.stringify(queue.data!.requests)).not.toContain('1029384756')
  })

  it('19. Members see their own history, including rejection reasons, without full account numbers', async () => {
    asUser(user1Id, UserRole.USER, user1Email)
    const history = await getMyProfileChangeHistoryAction(50)
    expect(history.success).toBe(true)
    const statuses = history.data!.map((r) => r.status)
    expect(statuses).toContain(ProfileChangeStatus.REJECTED)
    expect(statuses).toContain(ProfileChangeStatus.APPROVED)
    expect(history.data!.some((r) => r.rejectionReason)).toBe(true)
    expect(JSON.stringify(history.data)).not.toContain(ACC_MEMBER1_NEW_DETAILS)

    // Staff are not members and have no history endpoint
    asUser(adminId, UserRole.ADMIN, adminEmail)
    expect((await getMyProfileChangeHistoryAction()).success).toBe(false)
  })

  it('20. Adding a bank account stores the server-resolved name; a name mismatch blocks members but not staff', async () => {
    asUser(user1Id, UserRole.USER, user1Email)
    const blocked = await addBankAccountAction(user1Id, {
      bankCode: '058',
      bankName: 'GTBank',
      accountNumber: ACC_MISMATCH,
      accountName: 'Member One', // forged by the browser; must be ignored
    })
    expect(blocked.success).toBe(false)
    expect(blocked.code).toBe('NAME_MISMATCH')

    asUser(adminId, UserRole.ADMIN, adminEmail)
    const staffAdd = await addBankAccountAction(user1Id, {
      bankCode: '058',
      bankName: 'GTBank',
      accountNumber: ACC_MISMATCH,
      accountName: 'Member One',
    })
    expect(staffAdd.success).toBe(true)
    expect(staffAdd.data!.accountName).toBe('TOTALLY DIFFERENT PERSON')
    expect(staffAdd.data!.isPrimary).toBe(false)

    const audit = await prisma.auditEvent.findFirst({
      where: { action: AuditAction.MEMBER_BANK_ACCOUNT_ADDED, entityId: staffAdd.data!.id },
    })
    expect((audit?.metadata as { nameMatch?: boolean } | null)?.nameMatch).toBe(false)
  })

  it('21. Members cannot resolve accounts against another member profile; staff direct NOK edits are audited', async () => {
    asUser(user2Id, UserRole.USER, user2Email)
    const res = await resolveAccountNameAction('058', ACC_MISMATCH, user1Id)
    expect(res.success).toBe(false)

    asUser(user1Id, UserRole.USER, user1Email)
    const memberDirect = await updateNextOfKinAction(user1Id, nokInput('Direct Kin'))
    expect(memberDirect.success).toBe(false)
    expect(memberDirect.code).toBe('FORBIDDEN')

    asUser(adminId, UserRole.ADMIN, adminEmail)
    const staffDirect = await updateNextOfKinAction(user1Id, nokInput('Staff Set Kin'))
    expect(staffDirect.success).toBe(true)
    const audit = await prisma.auditEvent.findFirst({
      where: { action: AuditAction.MEMBER_NEXT_OF_KIN_SET, affectedUserId: user1Id, actorId: adminId },
    })
    expect(audit).not.toBeNull()
  })
})
