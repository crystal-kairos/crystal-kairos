import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '@/lib/prisma'
import { auth } from '@/auth'
import { addMemberToEAjoGroupAction } from '@/models/admin/eajoActions'
import { createTransaction } from '@/models/transactions/actions'
import {
  AdminPermission,
  EAjoMemberStatus,
  TransactionCategory,
  TransactionType,
  UserRole,
} from '@/generated/prisma/enums'
import { Prisma } from '@/generated/prisma/client'

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}))

vi.mock('@/lib/storage/cloudinary', () => ({
  bindStoredFileToRecord: vi.fn().mockResolvedValue(true),
}))

describe('E-Ajo admin add-member foreign-key fix (PR P1-08)', () => {
  const adminActor = {
    id: 'admin-eajo-actor',
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

    vi.spyOn(prisma.user, 'findUnique').mockImplementation((async (args: any) => {
      if (args?.where?.id === adminActor.id) {
        return adminActor
      }
      if (args?.where?.id === 'member-user-1') {
        return {
          id: 'member-user-1',
          role: UserRole.USER,
          bankAccounts: [
            {
              id: 'bank-1',
              bankName: 'First Bank',
              accountNumber: '0123456789',
              accountName: 'Member One',
            },
          ],
        }
      }
      return null
    }) as never)

    vi.spyOn(prisma.adminPermissionGrant, 'findMany').mockResolvedValue([
      {
        id: 'grant-eajo',
        adminUserId: adminActor.id,
        permission: AdminPermission.EAJO_MANAGE,
        grantedById: 'owner-id',
        createdAt: new Date(),
      },
      {
        id: 'grant-tx',
        adminUserId: adminActor.id,
        permission: AdminPermission.TRANSACTIONS_REVIEW,
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

  it('creates initial transaction referencing eAjoMemberId only, never eAjoId', async () => {
    const mockGroup = {
      id: 'group-uuid-1',
      contributionAmount: new Prisma.Decimal('20000.00'),
      members: [],
    }

    vi.spyOn(prisma.eAjoGroup, 'findUnique').mockResolvedValue(mockGroup as any)

    let createdTxData: any = null
    const mockMember = {
      id: 'eajo-member-row-99',
      userId: 'member-user-1',
      groupId: 'group-uuid-1',
      payoutPosition: 1,
      status: EAjoMemberStatus.ACTIVE,
    }

    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
      const tx = {
        eAjoMember: {
          create: vi.fn().mockResolvedValue(mockMember),
        },
        transaction: {
          create: vi.fn().mockImplementation(async ({ data }: any) => {
            createdTxData = data
            return { id: 'tx-123', ...data }
          }),
        },
      }
      return callback(tx)
    })

    const res = await addMemberToEAjoGroupAction({
      userId: 'member-user-1',
      groupId: 'group-uuid-1',
      payoutPosition: 1,
      status: EAjoMemberStatus.ACTIVE,
      receiptUrl: 'https://res.cloudinary.com/test/receipt.jpg',
    })

    expect(res.success).toBe(true)
    expect(createdTxData).toBeDefined()

    // Must link to eAjoMemberId
    expect(createdTxData.eAjoMemberId).toBe('eajo-member-row-99')

    // Must NOT link to legacy eAjoId (which causes foreign key error on legacy EAjo table)
    expect(createdTxData.eAjoId).toBeUndefined()
  })

  it('supports eAjoMemberId in createTransaction action', async () => {
    vi.spyOn(prisma.eAjoMember, 'findFirst').mockResolvedValue({
      id: 'eajo-member-row-99',
      userId: 'member-user-1',
    } as any)

    let txCreatedPayload: any = null
    vi.spyOn(prisma.transaction, 'create').mockImplementation((async ({ data }: any) => {
      txCreatedPayload = data
      return { id: 'tx-new-1', ...data } as any
    }) as never)

    const res = await createTransaction({
      userId: 'member-user-1',
      amount: 15000,
      category: TransactionCategory.AJO_CONTRIBUTION,
      type: TransactionType.DEPOSIT,
      eAjoMemberId: 'eajo-member-row-99',
    })

    expect(res.success).toBe(true)
    expect(txCreatedPayload.eAjoMemberId).toBe('eajo-member-row-99')
    expect(txCreatedPayload.eAjoId).toBeNull()
  })
})
