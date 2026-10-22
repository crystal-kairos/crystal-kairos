import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@/lib/prisma'
import { auth } from '@/auth'
import { transitionTransaction } from '@/models/transactions/actions'
import {
  AdminPermission,
  TransactionCategory,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '@/generated/prisma/enums'
import { Prisma } from '@/generated/prisma/client'

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}))

describe('Double-confirmation race prevention (PR P1-08)', () => {
  const adminActor = {
    id: 'admin-actor-id',
    email: 'admin@crystalkairos.com',
    name: 'Admin User',
    role: UserRole.OWNER,
    sessionVersion: 1,
    isActive: true,
    mfaEnabled: true,
  }

  beforeEach(() => {
    vi.restoreAllMocks()

    vi.mocked(auth).mockResolvedValue({
      user: {
        id: adminActor.id,
        email: adminActor.email,
        name: adminActor.name,
        role: adminActor.role,
        sessionVersion: 1,
      },
    } as any)

    // Mock live session user as permitted admin
    vi.spyOn(prisma.user, 'findUnique').mockImplementation((async (args: any) => {
      if (args?.where?.id === adminActor.id) {
        return adminActor
      }
      return null
    }) as never)

    vi.spyOn(prisma.adminPermissionGrant, 'findMany').mockResolvedValue([
      {
        id: 'grant-1',
        adminUserId: adminActor.id,
        permission: AdminPermission.TRANSACTIONS_REVIEW,
        grantedById: 'owner-id',
        createdAt: new Date(),
      },
      {
        id: 'grant-2',
        adminUserId: adminActor.id,
        permission: AdminPermission.SAVINGS_PAYMENTS_REVIEW,
        grantedById: 'owner-id',
        createdAt: new Date(),
      },
    ] as any)

    vi.spyOn(prisma.userSession, 'findUnique').mockResolvedValue({
      id: 'session-id',
      userId: adminActor.id,
      expiresAt: new Date(Date.now() + 100000),
      idleExpiresAt: new Date(Date.now() + 100000),
      revokedAt: null,
      mfaVerifiedAt: new Date(),
    } as any)

    vi.spyOn(prisma.userSession, 'update').mockResolvedValue({} as any)
  })

  it('atomically confirms pending transaction and rejects concurrent second confirmation with STALE_STATE', async () => {
    let currentStatus: TransactionStatus = TransactionStatus.PENDING
    let savingsBalance = new Prisma.Decimal(0)

    const txRecord = {
      id: 'tx-race-1',
      userId: 'member-1',
      amount: new Prisma.Decimal('5000.00'),
      category: TransactionCategory.SAVINGS_DEPOSIT,
      type: TransactionType.DEPOSIT,
      status: currentStatus,
      savingsId: 'savings-1',
      savings: {
        id: 'savings-1',
        status: 'ACTIVE',
        currentBalance: savingsBalance,
        totalDeposited: savingsBalance,
      },
    }

    // Mock initial check query outside $transaction
    vi.spyOn(prisma.transaction, 'findUnique').mockImplementation((async (args: any) => {
      return {
        id: args.where.id,
        category: TransactionCategory.SAVINGS_DEPOSIT,
      }
    }) as never)

    // Mock $transaction executing conditional update
    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
      const mockTx = {
        transaction: {
          updateMany: vi.fn().mockImplementation(async (args: any) => {
            if (
              args.where.id === 'tx-race-1' &&
              args.where.status === TransactionStatus.PENDING &&
              currentStatus === TransactionStatus.PENDING
            ) {
              currentStatus = TransactionStatus.CONFIRMED
              return { count: 1 }
            }
            return { count: 0 }
          }),
          findUnique: vi.fn().mockImplementation(async (args: any) => {
            return {
              ...txRecord,
              status: currentStatus,
            }
          }),
        },
        savings: {
          update: vi.fn().mockImplementation(async (args: any) => {
            savingsBalance = savingsBalance.plus(args.data.currentBalance.increment)
            return { id: 'savings-1', currentBalance: savingsBalance }
          }),
        },
      }
      return callback(mockTx)
    })

    // Simulate two concurrent confirmation requests arriving at the same time
    const [result1, result2] = await Promise.all([
      transitionTransaction('tx-race-1', 'CONFIRM', adminActor.id),
      transitionTransaction('tx-race-1', 'CONFIRM', adminActor.id),
    ])

    // Exactly one should succeed, and exactly one should fail with STALE_STATE
    const results = [result1, result2]
    const successes = results.filter((r) => r.success)
    const failures = results.filter((r) => !r.success)

    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)

    // The failure must have code STALE_STATE
    expect(failures[0].code).toBe('STALE_STATE')
    expect(failures[0].error).toMatch(/already processed/i)

    // The savings balance should only have been incremented ONCE (5000, not 10000)
    expect(savingsBalance.toNumber()).toBe(5000)
  })

  it('returns NOT_FOUND when transaction does not exist', async () => {
    vi.spyOn(prisma.transaction, 'findUnique').mockResolvedValue(null)
    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
      const mockTx = {
        transaction: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findUnique: vi.fn().mockResolvedValue(null),
        },
      }
      return callback(mockTx)
    })

    const result = await transitionTransaction('tx-nonexistent', 'CONFIRM', adminActor.id)
    expect(result.success).toBe(false)
    expect(result.code).toBe('NOT_FOUND')
  })
})
