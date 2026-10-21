import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminPermission, UserRole } from '@/generated/prisma/enums'

const mockSessionHolder = {
  session: null as {
    user?: {
      id: string
      email: string
      name: string
      role: UserRole
      sessionVersion?: number
    }
  } | null,
}

vi.mock('@/models/members/actions', () => ({
  getSessionHelper: vi.fn(async () => mockSessionHolder.session),
}))

import {
  assertUserHasNoMemberRecords,
  AuthzError,
  enforceDualControl,
  requireOwner,
  requirePermission,
} from '@/lib/authz/guards'
import { bootstrapInitialOwner } from '@/scripts/create-owner'

interface InMemoryUser {
  id: string
  email: string
  name: string
  role: UserRole
  sessionVersion: number
  passwordHash: string | null
  hasSetPassword: boolean
  membership?: { id: string } | null
  savings: { id: string }[]
  loans: { id: string }[]
  eAjoMembers: { id: string }[]
  eAjo: { id: string }[]
}

interface InMemoryGrant {
  id: string
  adminUserId: string
  permission: AdminPermission
  grantedById: string
}

function createInMemoryAuthzDb() {
  const users = new Map<string, InMemoryUser>()
  const grants = new Map<string, InMemoryGrant>()
  let seq = 1

  const db = {
    users,
    grants,
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { id?: string; email?: string } }) => {
          if (where.id) return users.get(where.id) ?? null
          if (where.email) {
            for (const u of users.values()) {
              if (u.email === where.email) return u
            }
          }
          return null
        },
      ),
      findMany: vi.fn(
        async ({ where }: { where?: { role?: UserRole } } = {}) => {
          const list: InMemoryUser[] = []
          for (const u of users.values()) {
            if (where?.role && u.role !== where.role) continue
            list.push(u)
          }
          return list
        },
      ),
      count: vi.fn(
        async ({ where }: { where?: { role?: UserRole } } = {}) => {
          let count = 0
          for (const u of users.values()) {
            if (where?.role && u.role !== where.role) continue
            count += 1
          }
          return count
        },
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            name: string
            email: string
            role: UserRole
            passwordHash: string | null
            hasSetPassword: boolean
          }
        }) => {
          const created: InMemoryUser = {
            id: `user-${seq++}`,
            name: data.name,
            email: data.email,
            role: data.role,
            sessionVersion: 0,
            passwordHash: data.passwordHash,
            hasSetPassword: data.hasSetPassword,
            membership: null,
            savings: [],
            loans: [],
            eAjoMembers: [],
            eAjo: [],
          }
          users.set(created.id, created)
          return { ...created, createdAt: new Date() }
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string }
          data: { sessionVersion?: { increment: number } }
        }) => {
          const existing = users.get(where.id)
          if (!existing) throw new Error('User not found')
          const updated: InMemoryUser = {
            ...existing,
            sessionVersion:
              existing.sessionVersion + (data.sessionVersion?.increment ?? 0),
          }
          users.set(where.id, updated)
          return updated
        },
      ),
    },
    adminPermissionGrant: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            adminUserId_permission: {
              adminUserId: string
              permission: AdminPermission
            }
          }
        }) => {
          const key = `${where.adminUserId_permission.adminUserId}:${where.adminUserId_permission.permission}`
          return grants.get(key) ?? null
        },
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where?: { adminUserId?: string; permission?: AdminPermission }
        } = {}) => {
          const list: InMemoryGrant[] = []
          for (const g of grants.values()) {
            if (where?.adminUserId && g.adminUserId !== where.adminUserId) {
              continue
            }
            if (where?.permission && g.permission !== where.permission) {
              continue
            }
            list.push(g)
          }
          return list
        },
      ),
      deleteMany: vi.fn(
        async ({ where }: { where: { adminUserId: string } }) => {
          let count = 0
          for (const [key, g] of grants.entries()) {
            if (g.adminUserId === where.adminUserId) {
              grants.delete(key)
              count += 1
            }
          }
          return { count }
        },
      ),
      createMany: vi.fn(
        async ({
          data,
        }: {
          data: {
            adminUserId: string
            permission: AdminPermission
            grantedById: string
          }[]
        }) => {
          for (const item of data) {
            const key = `${item.adminUserId}:${item.permission}`
            grants.set(key, {
              id: `grant-${seq++}`,
              ...item,
            })
          }
          return { count: data.length }
        },
      ),
    },
  }

  return db
}

describe('permission-based admin access integration (P1-03)', () => {
  let memDb: ReturnType<typeof createInMemoryAuthzDb>

  beforeEach(() => {
    memDb = createInMemoryAuthzDb()
    mockSessionHolder.session = null

    memDb.users.set('owner-1', {
      id: 'owner-1',
      email: 'owner@crystalkairos.coop',
      name: 'Cooperative Owner',
      role: UserRole.OWNER,
      sessionVersion: 0,
      passwordHash: '$2a$12$owner',
      hasSetPassword: true,
      membership: null,
      savings: [],
      loans: [],
      eAjoMembers: [],
      eAjo: [],
    })

    memDb.users.set('admin-loans-read', {
      id: 'admin-loans-read',
      email: 'admin1@crystalkairos.coop',
      name: 'Loans Reader Admin',
      role: UserRole.ADMIN,
      sessionVersion: 0,
      passwordHash: '$2a$12$admin1',
      hasSetPassword: true,
      membership: null,
      savings: [],
      loans: [],
      eAjoMembers: [],
      eAjo: [],
    })

    memDb.grants.set(`admin-loans-read:${AdminPermission.LOANS_READ}`, {
      id: 'g-1',
      adminUserId: 'admin-loans-read',
      permission: AdminPermission.LOANS_READ,
      grantedById: 'owner-1',
    })

    memDb.users.set('member-1', {
      id: 'member-1',
      email: 'member1@crystalkairos.coop',
      name: 'Regular Member',
      role: UserRole.USER,
      sessionVersion: 0,
      passwordHash: '$2a$12$member1',
      hasSetPassword: true,
      membership: { id: 'm-1' },
      savings: [],
      loans: [],
      eAjoMembers: [],
      eAjo: [],
    })
  })

  it('allows OWNER to pass any requirePermission check without explicit grant rows', async () => {
    mockSessionHolder.session = {
      user: {
        id: 'owner-1',
        email: 'owner@crystalkairos.coop',
        name: 'Cooperative Owner',
        role: UserRole.OWNER,
        sessionVersion: 0,
      },
    }

    const actor = await requirePermission(
      AdminPermission.LOANS_REVIEW,
      memDb as never,
    )
    expect(actor.id).toBe('owner-1')
    expect(actor.role).toBe(UserRole.OWNER)
  })

  it('allows ADMIN with LOANS_READ to read loans, but blocks LOANS_REVIEW until granted', async () => {
    mockSessionHolder.session = {
      user: {
        id: 'admin-loans-read',
        email: 'admin1@crystalkairos.coop',
        name: 'Loans Reader Admin',
        role: UserRole.ADMIN,
        sessionVersion: 0,
      },
    }

    const readActor = await requirePermission(
      AdminPermission.LOANS_READ,
      memDb as never,
    )
    expect(readActor.id).toBe('admin-loans-read')

    await expect(
      requirePermission(AdminPermission.LOANS_REVIEW, memDb as never),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('prevents ADMIN or USER from calling requireOwner (e.g. granting permissions or creating staff)', async () => {
    mockSessionHolder.session = {
      user: {
        id: 'admin-loans-read',
        email: 'admin1@crystalkairos.coop',
        name: 'Loans Reader Admin',
        role: UserRole.ADMIN,
        sessionVersion: 0,
      },
    }

    await expect(requireOwner(memDb as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })

    mockSessionHolder.session = {
      user: {
        id: 'member-1',
        email: 'member1@crystalkairos.coop',
        name: 'Regular Member',
        role: UserRole.USER,
        sessionVersion: 0,
      },
    }

    await expect(
      requirePermission(AdminPermission.LOANS_READ, memDb as never),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('takes effect on the very next request when a permission is revoked or sessionVersion is bumped', async () => {
    mockSessionHolder.session = {
      user: {
        id: 'admin-loans-read',
        email: 'admin1@crystalkairos.coop',
        name: 'Loans Reader Admin',
        role: UserRole.ADMIN,
        sessionVersion: 0,
      },
    }

    // Initially passes
    await expect(
      requirePermission(AdminPermission.LOANS_READ, memDb as never),
    ).resolves.toBeDefined()

    // Owner revokes grant in DB
    await memDb.adminPermissionGrant.deleteMany({
      where: { adminUserId: 'admin-loans-read' },
    })

    // Next request immediately fails even before sessionVersion check
    await expect(
      requirePermission(AdminPermission.LOANS_READ, memDb as never),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })

    // Bumping sessionVersion also invalidates stale session tokens
    await memDb.user.update({
      where: { id: 'admin-loans-read' },
      data: { sessionVersion: { increment: 1 } },
    })

    await expect(
      requirePermission(AdminPermission.LOANS_READ, memDb as never),
    ).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    })
  })

  it('forbids assigning staff roles or permissions to a user who has member records (D-15)', async () => {
    await expect(
      assertUserHasNoMemberRecords('member-1', memDb as never),
    ).rejects.toMatchObject({
      code: 'STAFF_CANNOT_BE_MEMBER',
    })

    await expect(
      assertUserHasNoMemberRecords('admin-loans-read', memDb as never),
    ).resolves.toBeUndefined()
  })

  it('enforces dual control when two or more eligible staff exist, and allows single-operator OWNER when alone (A-19)', async () => {
    const ownerActor = {
      id: 'owner-1',
      email: 'owner@crystalkairos.coop',
      name: 'Cooperative Owner',
      role: UserRole.OWNER,
      sessionVersion: 0,
      permissions: [AdminPermission.LOANS_DISBURSE],
    }

    // Only owner-1 has LOANS_DISBURSE right now -> single-operator allowed for OWNER
    const singleOp = await enforceDualControl(
      {
        actor: ownerActor,
        previousActorId: 'owner-1',
        requiredPermission: AdminPermission.LOANS_DISBURSE,
      },
      memDb as never,
    )
    expect(singleOp.singleOperator).toBe(true)

    // Grant LOANS_DISBURSE to admin-loans-read so 2 eligible staff exist
    await memDb.adminPermissionGrant.createMany({
      data: [
        {
          adminUserId: 'admin-loans-read',
          permission: AdminPermission.LOANS_DISBURSE,
          grantedById: 'owner-1',
        },
      ],
    })

    // Same user trying to both approve and disburse now fails dual control
    await expect(
      enforceDualControl(
        {
          actor: ownerActor,
          previousActorId: 'owner-1',
          requiredPermission: AdminPermission.LOANS_DISBURSE,
        },
        memDb as never,
      ),
    ).rejects.toThrowError(AuthzError)

    // Different staff user succeeds
    const dualOp = await enforceDualControl(
      {
        actor: ownerActor,
        previousActorId: 'admin-loans-read',
        requiredPermission: AdminPermission.LOANS_DISBURSE,
      },
      memDb as never,
    )
    expect(dualOp.singleOperator).toBe(false)
  })

  it('bootstraps the first OWNER via CLI helper and refuses to create a second OWNER', async () => {
    const emptyDb = createInMemoryAuthzDb()

    const firstOwner = await bootstrapInitialOwner(
      {
        name: 'First Owner',
        email: 'first-owner@crystalkairos.coop',
        password: 'StrongOwnerPassword!2026',
      },
      emptyDb as never,
    )

    expect(firstOwner.role).toBe(UserRole.OWNER)

    await expect(
      bootstrapInitialOwner(
        {
          name: 'Second Owner',
          email: 'second-owner@crystalkairos.coop',
          password: 'AnotherStrongPassword!2026',
        },
        emptyDb as never,
      ),
    ).rejects.toThrow(/already exists/)
  })
})
