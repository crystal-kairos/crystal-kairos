import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { Prisma } from '@/generated/prisma/client'
import { AdminPermission, UserDeactivationReason, UserRole } from '@/generated/prisma/enums'

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
  recordAuditEvent,
  queryAuditEvents,
  queryMemberAuditEvents,
  AuditAction,
  AuditOutcome,
  sanitizeAuditMetadata,
} from '@/lib/services/audit.service'
import { getMemberById } from '@/models/members/query'
import { deactivateUserAction, reactivateUserAction } from '@/models/members/actions'
import { setAdminPermissionsAction } from '@/models/admin/actions'

describe('PR P2-06 Integration Tests: Immutable Audit Events & Access Controls', () => {
  const timestamp = Date.now()
  const testEmailPrefix = `test-audit-${timestamp}`

  let ownerUser: { id: string; email: string }
  let adminUser: { id: string; email: string }
  let memberA: { id: string; email: string }
  let memberB: { id: string; email: string }

  beforeEach(() => {
    delete process.env.MOCK_SESSION_USER
  })

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({
      where: {
        OR: [
          { actor: { email: { contains: '-audit-' } } },
          { affectedUser: { email: { contains: '-audit-' } } },
        ],
      },
    })
    await prisma.userSession.deleteMany({
      where: { user: { email: { contains: '-audit-' } } },
    })
    await prisma.nextOfKin.deleteMany({
      where: { user: { email: { contains: '-audit-' } } },
    })
    await prisma.bankAccount.deleteMany({
      where: { user: { email: { contains: '-audit-' } } },
    })
    await prisma.membership.deleteMany({
      where: { user: { email: { contains: '-audit-' } } },
    })
    await prisma.adminPermissionGrant.deleteMany({
      where: {
        OR: [
          { admin: { email: { contains: '-audit-' } } },
          { grantedBy: { email: { contains: '-audit-' } } },
        ],
      },
    })
    await prisma.user.deleteMany({
      where: { email: { contains: '-audit-' } },
    })
  })

  it('sets up test actors and permissions', async () => {
    // 1. Fetch system owner
    const existingOwner = await prisma.user.findFirst({
      where: { role: UserRole.OWNER },
      select: { id: true, email: true },
    })
    expect(existingOwner).not.toBeNull()
    ownerUser = existingOwner!

    // 2. Create staff admin with MFA enabled
    adminUser = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-admin@example.com`,
        name: 'Audit Test Admin',
        role: UserRole.ADMIN,
        hasSetPassword: true,
        mfaEnabled: true,
        isActive: true,
      },
      select: { id: true, email: true },
    })

    // Grant AUDIT_READ, MEMBERS_APPROVE, MEMBERS_READ, STAFF_MANAGE
    await prisma.adminPermissionGrant.createMany({
      data: [
        { adminUserId: adminUser.id, permission: AdminPermission.AUDIT_READ, grantedById: ownerUser.id },
        { adminUserId: adminUser.id, permission: AdminPermission.MEMBERS_APPROVE, grantedById: ownerUser.id },
        { adminUserId: adminUser.id, permission: AdminPermission.MEMBERS_READ, grantedById: ownerUser.id },
        { adminUserId: adminUser.id, permission: AdminPermission.STAFF_MANAGE, grantedById: ownerUser.id },
      ],
    })

    // 3. Create Member A with bank account and next of kin
    memberA = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-member-a@example.com`,
        name: 'Audit Member A',
        role: UserRole.USER,
        hasSetPassword: true,
        isActive: true,
        bankAccounts: {
          create: {
            accountNumber: '9988776655',
            bankName: 'Access Bank',
            accountName: 'Audit Member A',
            bankCode: '044',
            isPrimary: true,
            isVerified: true,
          },
        },
        nextOfKin: {
          create: {
            name: 'Audit Nok A',
            phoneNumber: '08012345678',
            relationship: 'SPOUSE',
            occupation: 'Engineer',
            address: 'Lagos, Nigeria',
            bankName: 'Access Bank',
            accountNumber: '1122334455',
            accountName: 'Audit Nok A',
          },
        },
      },
      select: { id: true, email: true },
    })

    // 4. Create Member B
    memberB = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-member-b@example.com`,
        name: 'Audit Member B',
        role: UserRole.USER,
        hasSetPassword: true,
        isActive: true,
      },
      select: { id: true, email: true },
    })

    expect(adminUser.id).toBeDefined()
    expect(memberA.id).toBeDefined()
    expect(memberB.id).toBeDefined()
  })

  it('records administrative permission grants and lifecycle mutations', async () => {
    // 1. Owner grants new permission to Admin
    mockSessionState.session = {
      user: {
        id: ownerUser.id,
        email: ownerUser.email,
        name: 'System Owner',
        role: UserRole.OWNER,
      },
    }

    const grantRes = await setAdminPermissionsAction(adminUser.id, [
      AdminPermission.AUDIT_READ,
      AdminPermission.MEMBERS_APPROVE,
      AdminPermission.MEMBERS_READ,
      AdminPermission.STAFF_MANAGE,
      AdminPermission.LOANS_READ,
    ])
    expect(grantRes.success).toBe(true)

    // Verify audit event exists
    const grantEvent = await prisma.auditEvent.findFirst({
      where: {
        action: AuditAction.ADMIN_PERMISSION_GRANTED,
        affectedUserId: adminUser.id,
      },
    })
    expect(grantEvent).not.toBeNull()
    expect(grantEvent?.actorId).toBe(ownerUser.id)
    expect(grantEvent?.outcome).toBe(AuditOutcome.SUCCESS)

    // 2. Admin deactivates Member A
    mockSessionState.session = {
      user: {
        id: adminUser.id,
        email: adminUser.email,
        name: 'Audit Admin',
        role: UserRole.ADMIN,
      },
    }

    const deactRes = await deactivateUserAction({
      userId: memberA.id,
      reason: UserDeactivationReason.ADMIN_ACTION,
      notes: 'Investigating anomalous login',
    })
    expect(deactRes.success).toBe(true)

    const deactEvent = await prisma.auditEvent.findFirst({
      where: {
        action: AuditAction.MEMBER_DEACTIVATED,
        affectedUserId: memberA.id,
      },
    })
    expect(deactEvent).not.toBeNull()
    expect(deactEvent?.actorId).toBe(adminUser.id)

    // 3. Admin reactivates Member A
    const reactRes = await reactivateUserAction({ userId: memberA.id })
    expect(reactRes.success).toBe(true)

    const reactEvent = await prisma.auditEvent.findFirst({
      where: {
        action: AuditAction.MEMBER_REACTIVATED,
        affectedUserId: memberA.id,
      },
    })
    expect(reactEvent).not.toBeNull()
  })

  it('guarantees transaction atomicity: audit event rolls back if transaction fails', async () => {
    const errorMsg = 'Simulated Database Failure During Financial Mutation'

    try {
      await prisma.$transaction(async (tx) => {
        await recordAuditEvent(
          {
            actorId: adminUser.id,
            action: 'TRANSACTION_ROLLBACK_TEST',
            entityType: 'TestEntity',
            entityId: 'test-123',
            outcome: AuditOutcome.SUCCESS,
          },
          tx,
        )

        // Intentionally throw to trigger transaction rollback
        throw new Error(errorMsg)
      })
    } catch (err: any) {
      expect(err.message).toBe(errorMsg)
    }

    // Verify the audit event was NOT committed to the database
    const rolledBackEvent = await prisma.auditEvent.findFirst({
      where: {
        action: 'TRANSACTION_ROLLBACK_TEST',
        entityId: 'test-123',
      },
    })
    expect(rolledBackEvent).toBeNull()
  })

  it('enforces strict member data isolation (§P2-06, §1.1)', async () => {
    // Manually create specific audit events for Member A and Member B
    await recordAuditEvent({
      actorId: memberA.id,
      affectedUserId: memberA.id,
      action: AuditAction.SAVINGS_PLAN_CREATED,
      entityType: 'Savings',
      entityId: 'savings-a-1',
      outcome: AuditOutcome.SUCCESS,
    })

    await recordAuditEvent({
      actorId: memberB.id,
      affectedUserId: memberB.id,
      action: AuditAction.SAVINGS_PLAN_CREATED,
      entityType: 'Savings',
      entityId: 'savings-b-1',
      outcome: AuditOutcome.SUCCESS,
    })

    // Query activity as Member A
    const memberAQuery = await queryMemberAuditEvents({ memberId: memberA.id })
    expect(memberAQuery.total).toBeGreaterThanOrEqual(1)

    // Assert: none of Member B's entity IDs or events appear in Member A's query
    const memberAEntityIds = memberAQuery.events.map((e) => e.entityId)
    expect(memberAEntityIds).toContain('savings-a-1')
    expect(memberAEntityIds).not.toContain('savings-b-1')

    // Query activity as Member B
    const memberBQuery = await queryMemberAuditEvents({ memberId: memberB.id })
    const memberBEntityIds = memberBQuery.events.map((e) => e.entityId)
    expect(memberBEntityIds).toContain('savings-b-1')
    expect(memberBEntityIds).not.toContain('savings-a-1')
  })

  it('logs staff access when viewing member banking and next-of-kin details (P2-06, §2.1)', async () => {
    mockSessionState.session = {
      user: {
        id: adminUser.id,
        email: adminUser.email,
        name: 'Audit Admin',
        role: UserRole.ADMIN,
      },
    }

    // Staff views Member A details
    const memberRes = await getMemberById(memberA.id)
    expect(memberRes.success).toBe(true)
    expect(memberRes.data?.bankAccounts.length).toBeGreaterThan(0)
    expect(memberRes.data?.nextOfKin).not.toBeNull()

    // Verify staff inspection audit events were logged
    const bankViewEvent = await prisma.auditEvent.findFirst({
      where: {
        actorId: adminUser.id,
        affectedUserId: memberA.id,
        action: AuditAction.STAFF_MEMBER_BANK_VIEWED,
      },
    })
    expect(bankViewEvent).not.toBeNull()
    expect(bankViewEvent?.entityType).toBe('User')
    expect(bankViewEvent?.entityId).toBe(memberA.id)

    const nokViewEvent = await prisma.auditEvent.findFirst({
      where: {
        actorId: adminUser.id,
        affectedUserId: memberA.id,
        action: AuditAction.STAFF_MEMBER_NOK_VIEWED,
      },
    })
    expect(nokViewEvent).not.toBeNull()
  })

  it('supports admin query with filters, safe pagination, and single operator detection', async () => {
    // Create a single-operator dual control override event
    await recordAuditEvent({
      actorId: adminUser.id,
      actorRole: UserRole.ADMIN,
      action: AuditAction.SINGLE_OPERATOR_OVERRIDE,
      entityType: 'Transaction',
      entityId: 'tx-dual-override-1',
      outcome: AuditOutcome.SUCCESS,
      isSingleOperator: true,
      metadata: { overrideReason: 'Solo operator permitted by bylaws for amounts under threshold' },
    })

    // Query audit events with pagination
    const result = await queryAuditEvents({
      action: AuditAction.SINGLE_OPERATOR_OVERRIDE,
      page: 1,
      pageSize: 10,
    })

    expect(result.total).toBeGreaterThanOrEqual(1)
    const overrideEvt = result.events.find((e) => e.entityId === 'tx-dual-override-1')
    expect(overrideEvt).toBeDefined()
    expect(overrideEvt?.isSingleOperator).toBe(true)
    expect(overrideEvt?.actor?.email).toBe(adminUser.email)
  })
})
