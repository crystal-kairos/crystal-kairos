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
  updateNextOfKinAction,
} from '@/models/members/actions'
import {
  requestNextOfKinChangeAction,
  requestPrimaryBankAccountChangeAction,
  getMemberPendingProfileChangesAction,
  cancelProfileChangeRequestAction,
} from '@/models/members/profile-change-actions'
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

  let bankAccount1Id: string
  let bankAccount2Id: string

  beforeEach(async () => {
    delete process.env.MOCK_SESSION_USER
  })

  afterAll(async () => {
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
      accountNumber: '9999888877',
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

  it('7. Separation of duties: Admin cannot approve or reject their own change request', async () => {
    // Give Admin user a bank account
    const adminAcc1 = await prisma.bankAccount.create({
      data: {
        userId: adminId,
        bankName: 'Kuda Bank',
        bankCode: '50211',
        accountNumber: '3333444455',
        accountName: 'Staff Reviewer',
        isPrimary: true,
        isVerified: true,
      },
    })
    const adminAcc2 = await prisma.bankAccount.create({
      data: {
        userId: adminId,
        bankName: 'Zenith Bank',
        bankCode: '057',
        accountNumber: '5555666677',
        accountName: 'Staff Reviewer',
        isPrimary: false,
        isVerified: true,
      },
    })

    // Admin has a pending change request
    const adminReq = await prisma.profileChangeRequest.create({
      data: {
        userId: adminId,
        changeType: ProfileChangeType.PRIMARY_BANK,
        previousValue: {
          bankAccountId: adminAcc1.id,
          bankName: adminAcc1.bankName,
          accountNumberMasked: '******4455',
          accountName: adminAcc1.accountName,
          bankCode: adminAcc1.bankCode,
        },
        proposedValue: {
          targetBankAccountId: adminAcc2.id,
          bankName: adminAcc2.bankName,
          accountNumberMasked: '******6677',
          accountName: adminAcc2.accountName,
          bankCode: adminAcc2.bankCode,
        },
        status: ProfileChangeStatus.PENDING,
      },
    })
    const adminRequestId = adminReq.id

    // Admin tries to self-approve
    mockSessionHolder.session = {
      user: { id: adminId, role: UserRole.ADMIN, email: adminEmail },
    }
    const selfApproveRes = await approveProfileChangeRequestAction(adminRequestId)
    expect(selfApproveRes.success).toBe(false)
    expect(selfApproveRes.error).toContain('Separation of duties')

    // Admin tries to self-reject
    const selfRejectRes = await rejectProfileChangeRequestAction(
      adminRequestId,
      'Self reject reason',
    )
    expect(selfRejectRes.success).toBe(false)
    expect(selfRejectRes.error).toContain('Separation of duties')

    // Owner can review and approve the admin's request
    mockSessionHolder.session = {
      user: { id: ownerId, role: UserRole.OWNER, email: ownerEmail },
    }
    const ownerApproveRes = await approveProfileChangeRequestAction(adminRequestId)
    expect(ownerApproveRes.success).toBe(true)

    const updatedAdminAcc2 = await prisma.bankAccount.findUnique({
      where: { id: adminAcc2.id },
    })
    expect(updatedAdminAcc2?.isPrimary).toBe(true)
  })

  it('8. Unauthorised user cannot approve or review change requests', async () => {
    // User 1 submits a request
    mockSessionHolder.session = {
      user: { id: user1Id, role: UserRole.USER, email: user1Email },
    }
    const subRes = await requestNextOfKinChangeAction(user1Id, {
      name: 'Brother Ben',
      phoneNumber: '08077778888',
      relationship: Relationship.SIBLING,
      occupation: 'Architect',
      address: '77 Broad Street',
      bankName: 'UBA',
      accountNumber: '1029384756',
      accountName: 'Ben Brother',
    })
    expect(subRes.success).toBe(true)
    const reqId = subRes.data!.id

    // User 2 (unauthorized member) tries to approve
    mockSessionHolder.session = {
      user: { id: user2Id, role: UserRole.USER, email: user2Email },
    }
    const unauthApprove = await approveProfileChangeRequestAction(reqId)
    expect(unauthApprove.success).toBe(false)

    // User 2 tries to reject
    const unauthReject = await rejectProfileChangeRequestAction(reqId, 'Malicious reject')
    expect(unauthReject.success).toBe(false)
  })

  it('9. Idempotency: Cannot approve or reject a request that is not PENDING', async () => {
    // Staff admin session approves the Brother Ben request
    mockSessionHolder.session = {
      user: { id: adminId, role: UserRole.ADMIN, email: adminEmail },
    }

    const pending = await prisma.profileChangeRequest.findFirst({
      where: { userId: user1Id, status: ProfileChangeStatus.PENDING },
    })
    expect(pending).toBeDefined()

    const firstApprove = await approveProfileChangeRequestAction(pending!.id)
    expect(firstApprove.success).toBe(true)

    // Second approve must fail idempotently
    const secondApprove = await approveProfileChangeRequestAction(pending!.id)
    expect(secondApprove.success).toBe(false)
    expect(secondApprove.error).toContain('Only PENDING requests can be approved')

    // Rejecting already approved must fail
    const rejectAfterApprove = await rejectProfileChangeRequestAction(
      pending!.id,
      'Too late to reject',
    )
    expect(rejectAfterApprove.success).toBe(false)
    expect(rejectAfterApprove.error).toContain('Only PENDING requests can be rejected')
  })

  it('10. Member can cancel their own pending request, but cannot cancel other members requests', async () => {
    // User 1 submits a primary bank request
    mockSessionHolder.session = {
      user: { id: user1Id, role: UserRole.USER, email: user1Email },
    }
    const reqRes = await requestPrimaryBankAccountChangeAction(bankAccount1Id)
    expect(reqRes.success).toBe(true)
    const reqId = reqRes.data!.id

    // User 2 tries to cancel User 1's request -> fails
    mockSessionHolder.session = {
      user: { id: user2Id, role: UserRole.USER, email: user2Email },
    }
    const badCancel = await cancelProfileChangeRequestAction(reqId)
    expect(badCancel.success).toBe(false)
    expect(badCancel.error).toContain('only cancel your own')

    // User 1 cancels own request -> succeeds
    mockSessionHolder.session = {
      user: { id: user1Id, role: UserRole.USER, email: user1Email },
    }
    const goodCancel = await cancelProfileChangeRequestAction(reqId)
    expect(goodCancel.success).toBe(true)

    const cancelledReq = await prisma.profileChangeRequest.findUnique({
      where: { id: reqId },
    })
    expect(cancelledReq?.status).toBe(ProfileChangeStatus.CANCELLED)
  })

  it('11. Audit events are recorded for profile change requests lifecycle', async () => {
    const auditLogs = await prisma.auditEvent.findMany({
      where: {
        entityType: 'ProfileChangeRequest',
        actorId: { in: [user1Id, adminId, ownerId] },
      },
      orderBy: { createdAt: 'desc' },
    })

    expect(auditLogs.length).toBeGreaterThanOrEqual(4)
    const actions = auditLogs.map((l) => l.action)
    expect(actions).toContain(AuditAction.MEMBER_PROFILE_UPDATED)
  })
})
