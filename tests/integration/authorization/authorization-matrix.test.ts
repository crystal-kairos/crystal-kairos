import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AdminPermission,
  LoanStatus,
  Relationship,
  SavingsFrequency,
  SavingsMaturity,
  SavingsStatus,
  SavingsType,
  TransactionCategory,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '@/generated/prisma/enums'
import { Prisma } from '@/generated/prisma/client'

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
  authShouldThrow: false,
}))

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => {
    if (mockSessionState.authShouldThrow) {
      throw new Error('Auth context unavailable')
    }
    return mockSessionState.session
  }),
}))

vi.mock('@/lib/upload', () => ({
  uploadReceipt: vi.fn(async (_buf: Buffer, name: string) => ({
    url: `https://cdn.example.com/receipts/${name}`,
    publicId: `receipts/${name}`,
  })),
}))

import { prisma } from '@/lib/prisma'
import {
  getSessionHelper,
  updateNextOfKinAction,
  addBankAccountAction,
  resolveAccountNameAction,
} from '@/models/members/actions'
import { getAllMembers, getMemberById } from '@/models/members/query'
import {
  createTransaction,
  transitionTransaction,
  getUserLedgerBalances,
  getUserTransactions,
} from '@/models/transactions/actions'
import {
  createSavingsPlanAction,
  submitSavingsDepositAction,
  requestSavingsWithdrawalAction,
} from '@/models/savings/actions'
import { getSavingsPlanById } from '@/models/savings/query'
import {
  searchMemberByEmailAction,
  applyForLoanAction,
  submitLoanRepaymentAction,
  acceptLoanOfferAction,
  declineLoanOfferAction,
} from '@/models/loans/actions'
import { getLoanPlanById } from '@/models/loans/query'
import {
  submitEAjoContributionAction,
  uploadReceiptAction,
} from '@/models/eajo/actions'
import { getUserEAjoMemberships } from '@/models/eajo/query'
import { createLoanForMemberAction } from '@/models/admin/loanActions'
import { createSavingsForMemberAction } from '@/models/admin/savingsActions'
import { addMemberToEAjoGroupAction } from '@/models/admin/eajoActions'
import { auditServerActions } from '@/scripts/audit-server-actions'
import { checkSystemInvariants } from '@/scripts/check-invariants'

interface MockUserRecord {
  id: string
  email: string
  username?: string | null
  name: string
  role: UserRole
  sessionVersion: number
  isActive?: boolean
  passwordHash: string | null
  hasSetPassword: boolean
  photoUrl?: string | null
  lastLoginAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

describe('Server authorization matrix & invariants (PR P1-04)', () => {
  const users = new Map<string, MockUserRecord>()
  const grants = new Map<string, AdminPermission[]>()

  const seedUsers = () => {
    users.clear()
    grants.clear()
    const now = new Date()

    users.set('member-a', {
      id: 'member-a',
      email: 'member.a@crystalkairos.coop',
      name: 'Member Alpha',
      role: UserRole.USER,
      sessionVersion: 1,
      passwordHash: '$2a$12$secretHashAlpha',
      hasSetPassword: true,
      createdAt: now,
      updatedAt: now,
    })

    users.set('member-b', {
      id: 'member-b',
      email: 'member.b@crystalkairos.coop',
      name: 'Member Beta',
      role: UserRole.USER,
      sessionVersion: 1,
      passwordHash: '$2a$12$secretHashBeta',
      hasSetPassword: true,
      createdAt: now,
      updatedAt: now,
    })

    users.set('deactivated-member', {
      id: 'deactivated-member',
      email: 'inactive@crystalkairos.coop',
      name: 'Inactive Member',
      role: UserRole.USER,
      sessionVersion: 1,
      isActive: false,
      passwordHash: '$2a$12$secretHashInactive',
      hasSetPassword: true,
      createdAt: now,
      updatedAt: now,
    })

    users.set('admin-no-perms', {
      id: 'admin-no-perms',
      email: 'admin.noperms@crystalkairos.coop',
      name: 'Unprivileged Admin',
      role: UserRole.ADMIN,
      sessionVersion: 1,
      passwordHash: '$2a$12$secretHashAdmin1',
      hasSetPassword: true,
      createdAt: now,
      updatedAt: now,
    })
    grants.set('admin-no-perms', [])

    users.set('admin-reviewer', {
      id: 'admin-reviewer',
      email: 'admin.reviewer@crystalkairos.coop',
      name: 'Privileged Reviewer Admin',
      role: UserRole.ADMIN,
      sessionVersion: 1,
      passwordHash: '$2a$12$secretHashAdmin2',
      hasSetPassword: true,
      createdAt: now,
      updatedAt: now,
    })
    grants.set('admin-reviewer', [
      AdminPermission.MEMBERS_READ,
      AdminPermission.TRANSACTIONS_READ,
      AdminPermission.TRANSACTIONS_REVIEW,
      AdminPermission.SAVINGS_READ,
      AdminPermission.SAVINGS_PAYMENTS_REVIEW,
      AdminPermission.LOANS_READ,
      AdminPermission.LOANS_REVIEW,
      AdminPermission.EAJO_READ,
      AdminPermission.EAJO_MANAGE,
    ])

    users.set('owner-1', {
      id: 'owner-1',
      email: 'owner@crystalkairos.coop',
      name: 'Cooperative Owner',
      role: UserRole.OWNER,
      sessionVersion: 1,
      passwordHash: '$2a$12$secretHashOwner',
      hasSetPassword: true,
      createdAt: now,
      updatedAt: now,
    })
  }

  const signInAs = (
    userId: string | null,
    overrides?: { sessionVersion?: number; role?: UserRole },
  ) => {
    if (!userId) {
      mockSessionState.session = null
      return
    }
    const u = users.get(userId)
    if (!u) throw new Error(`Unknown test user ${userId}`)
    mockSessionState.session = {
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        role: overrides?.role ?? u.role,
        sessionVersion: overrides?.sessionVersion ?? u.sessionVersion,
      },
    }
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    mockSessionState.session = null
    mockSessionState.authShouldThrow = false
    delete process.env.MOCK_SESSION_USER
    seedUsers()

    vi.spyOn(prisma.user, 'findUnique').mockImplementation((async (args: {
      where: { id?: string; email?: string }
      select?: Record<string, unknown>
    }) => {
      let found: MockUserRecord | null = null
      if (args.where.id) {
        found = users.get(args.where.id) ?? null
      } else if (args.where.email) {
        for (const u of users.values()) {
          if (u.email === args.where.email) {
            found = u
            break
          }
        }
      }
      if (!found) return null
      if (args.select && !('passwordHash' in args.select)) {
        const clone = { ...found } as Record<string, unknown>
        delete clone.passwordHash
        return clone
      }
      return { ...found }
    }) as never)

    vi.spyOn(prisma.adminPermissionGrant, 'findMany').mockImplementation((async (
      args?: { where?: { adminUserId?: string; permission?: AdminPermission } },
    ) => {
      const adminId = args?.where?.adminUserId
      if (adminId) {
        const list = grants.get(adminId) ?? []
        return list.map((permission) => ({ permission, adminUserId: adminId }))
      }
      return []
    }) as never)

    vi.spyOn(prisma.adminPermissionGrant, 'findUnique').mockImplementation((async (
      args: {
        where: {
          adminUserId_permission: {
            adminUserId: string
            permission: AdminPermission
          }
        }
      },
    ) => {
      const { adminUserId, permission } = args.where.adminUserId_permission
      const list = grants.get(adminUserId) ?? []
      if (!list.includes(permission)) return null
      return {
        id: `grant-${adminUserId}-${permission}`,
        adminUserId,
        permission,
        grantedById: 'owner-1',
        createdAt: new Date(),
      }
    }) as never)
  })

  it('passes static server action audit across all files in models/', () => {
    const findings = auditServerActions()
    expect(findings).toEqual([])
  })

  it('forbids MOCK_SESSION_USER when NODE_ENV is not test', async () => {
    const env = process.env as Record<string, string | undefined>
    const prevNodeEnv = env.NODE_ENV
    try {
      env.MOCK_SESSION_USER = JSON.stringify({
        user: { id: 'member-a', role: 'OWNER' },
      })
      env.NODE_ENV = 'production'

      await expect(getSessionHelper()).rejects.toThrow(
        /MOCK_SESSION_USER is forbidden outside NODE_ENV=test/,
      )
    } finally {
      env.NODE_ENV = prevNodeEnv
      delete env.MOCK_SESSION_USER
    }
  })

  it('enforces authorization and prevents recordedBy/userId spoofing on createTransaction', async () => {
    vi.spyOn(prisma.savings, 'findFirst').mockImplementation((async (args: {
      where: { id: string; userId: string }
    }) => {
      if (
        args.where.id === 'savings-a' &&
        args.where.userId === 'member-a'
      ) {
        return { id: 'savings-a', userId: 'member-a' }
      }
      return null
    }) as never)

    const createSpy = vi
      .spyOn(prisma.transaction, 'create')
      .mockImplementation((async (args: { data: Record<string, unknown> }) => ({
        id: 'tx-1',
        ...args.data,
      })) as never)

    // 1. Anonymous rejected
    signInAs(null)
    const anonRes = await createTransaction({
      userId: 'member-a',
      amount: 5000,
      category: TransactionCategory.SAVINGS_DEPOSIT,
      type: TransactionType.DEPOSIT,
      savingsId: 'savings-a',
      recordedBy: 'spoofed-actor',
    })
    expect(anonRes.success).toBe(false)

    // 2. Member A cannot create a transaction for Member B
    signInAs('member-a')
    const crossMemberRes = await createTransaction({
      userId: 'member-b',
      amount: 5000,
      category: TransactionCategory.SAVINGS_DEPOSIT,
      type: TransactionType.DEPOSIT,
      recordedBy: 'member-a',
    })
    expect(crossMemberRes.success).toBe(false)
    expect(crossMemberRes.error).toMatch(/not authorised/i)

    // 3. Member A cannot link a savings plan owned by Member B
    const foreignSavingsRes = await createTransaction({
      userId: 'member-a',
      amount: 5000,
      category: TransactionCategory.SAVINGS_DEPOSIT,
      type: TransactionType.DEPOSIT,
      savingsId: 'savings-b',
      recordedBy: 'member-a',
    })
    expect(foreignSavingsRes.success).toBe(false)
    expect(foreignSavingsRes.error).toMatch(/Savings plan not found/i)

    // 4. Member A creating own transaction ignores spoofed recordedBy
    const ownRes = await createTransaction({
      userId: 'member-a',
      amount: 5000,
      category: TransactionCategory.SAVINGS_DEPOSIT,
      type: TransactionType.DEPOSIT,
      savingsId: 'savings-a',
      recordedBy: 'spoofed-admin-id',
    })
    expect(ownRes.success).toBe(true)
    expect(createSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'member-a',
          recordedBy: 'member-a',
        }),
      }),
    )
  })

  it('enforces staff permissions and ignores caller-supplied adminId on transitionTransaction', async () => {
    vi.spyOn(prisma.transaction, 'findUnique').mockResolvedValue({
      id: 'tx-pending-1',
      userId: 'member-a',
      amount: new Prisma.Decimal(10000),
      category: TransactionCategory.SAVINGS_DEPOSIT,
      type: TransactionType.DEPOSIT,
      status: TransactionStatus.PENDING,
      savingsId: 'savings-a',
      savings: {
        id: 'savings-a',
        status: SavingsStatus.ACTIVE,
        savingsType: SavingsType.REGULAR,
        maturity: SavingsMaturity.SIX_MONTHS,
      },
    } as never)

    const updateTxSpy = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: 'tx-pending-1',
      userId: 'member-a',
      ...args.data,
    }))

    vi.spyOn(prisma, '$transaction').mockImplementation((async (
      cb: (tx: unknown) => Promise<unknown>,
    ) => {
      return cb({
        transaction: {
          findUnique: prisma.transaction.findUnique,
          update: updateTxSpy,
        },
        savings: {
          update: vi.fn(async () => ({})),
        },
      })
    }) as never)

    // 1. Anonymous rejected
    signInAs(null)
    expect(
      (await transitionTransaction('tx-pending-1', 'CONFIRM', 'spoof-admin'))
        .success,
    ).toBe(false)

    // 2. Regular member rejected
    signInAs('member-a')
    expect(
      (await transitionTransaction('tx-pending-1', 'CONFIRM', 'member-a'))
        .success,
    ).toBe(false)

    // 3. Admin without permission rejected
    signInAs('admin-no-perms')
    const unprivRes = await transitionTransaction(
      'tx-pending-1',
      'CONFIRM',
      'admin-no-perms',
    )
    expect(unprivRes.success).toBe(false)
    expect(unprivRes.error).toMatch(/permission/i)

    // 4. Admin with SAVINGS_PAYMENTS_REVIEW succeeds and records actor.id instead of spoofed adminId
    signInAs('admin-reviewer')
    const privRes = await transitionTransaction(
      'tx-pending-1',
      'CONFIRM',
      'spoofed-other-admin-id',
    )
    expect(privRes.success).toBe(true)
    expect(updateTxSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processedBy: 'admin-reviewer',
          status: TransactionStatus.CONFIRMED,
        }),
      }),
    )
  })

  it('enforces ownership and staff permissions on getUserLedgerBalances and getUserTransactions', async () => {
    vi.spyOn(prisma.transaction, 'findMany').mockResolvedValue([] as never)

    // Anonymous rejected
    signInAs(null)
    expect((await getUserLedgerBalances('member-a')).success).toBe(false)
    expect((await getUserTransactions('member-a')).success).toBe(false)

    // Member A can read own balances/transactions
    signInAs('member-a')
    expect((await getUserLedgerBalances('member-a')).success).toBe(true)
    expect((await getUserTransactions('member-a')).success).toBe(true)

    // Member A cannot read Member B's balances/transactions
    expect((await getUserLedgerBalances('member-b')).success).toBe(false)
    expect((await getUserTransactions('member-b')).success).toBe(false)

    // Admin without permission cannot read Member A's balances/transactions
    signInAs('admin-no-perms')
    expect((await getUserLedgerBalances('member-a')).success).toBe(false)
    expect((await getUserTransactions('member-a')).success).toBe(false)

    // Admin with TRANSACTIONS_READ can read Member A's balances/transactions
    signInAs('admin-reviewer')
    expect((await getUserLedgerBalances('member-a')).success).toBe(true)
    expect((await getUserTransactions('member-a')).success).toBe(true)
  })

  it('enforces member ownership on savings actions and getSavingsPlanById', async () => {
    vi.spyOn(prisma.savings, 'findUnique').mockResolvedValue({
      id: 'savings-a',
      userId: 'member-a',
      savingsType: SavingsType.REGULAR,
      targetAmount: new Prisma.Decimal(50000),
      frequency: SavingsFrequency.MONTHLY,
      maturity: SavingsMaturity.SIX_MONTHS,
      interestRate: new Prisma.Decimal(5),
      currentBalance: new Prisma.Decimal(10000),
      accruedInterest: new Prisma.Decimal(0),
      totalDeposited: new Prisma.Decimal(10000),
      expectedMaturityAmount: new Prisma.Decimal(52500),
      status: SavingsStatus.ACTIVE,
      transactions: [],
    } as never)

    vi.spyOn(prisma.savings, 'findFirst').mockImplementation((async (args: {
      where: { id: string; userId: string }
    }) => {
      if (
        args.where.id === 'savings-a' &&
        args.where.userId === 'member-a'
      ) {
        return {
          id: 'savings-a',
          userId: 'member-a',
          status: SavingsStatus.ACTIVE,
          currentBalance: new Prisma.Decimal(10000),
          accruedInterest: new Prisma.Decimal(0),
        }
      }
      return null
    }) as never)

    // Member B cannot view Member A's savings plan
    signInAs('member-b')
    const crossRead = await getSavingsPlanById('savings-a')
    expect(crossRead.success).toBe(false)

    // Member B cannot deposit into or withdraw from Member A's savings plan
    const crossDeposit = await submitSavingsDepositAction('member-a', {
      savingsId: 'savings-a',
      amount: 5000,
      receiptUrl: 'https://cdn.example.com/r.png',
    })
    expect(crossDeposit.success).toBe(false)

    const crossWithdraw = await requestSavingsWithdrawalAction(
      'member-b',
      'savings-a',
    )
    expect(crossWithdraw.success).toBe(false)
    expect(crossWithdraw.error).toMatch(/Savings plan not found/i)

    // Staff cannot create a personal member savings plan via member action (D-15)
    signInAs('owner-1')
    const staffPlan = await createSavingsPlanAction('owner-1', {
      savingsType: SavingsType.REGULAR,
      targetAmount: 10000,
      frequency: SavingsFrequency.MONTHLY,
      maturity: SavingsMaturity.SIX_MONTHS,
      bankName: 'GTBank',
      accountNumber: '0123456789',
      accountName: 'Owner',
    })
    expect(staffPlan.success).toBe(false)
    expect(staffPlan.error).toMatch(/Staff accounts cannot perform member/i)
  })

  it('enforces member ownership on loan actions, guarantor search, and getLoanPlanById without leaking passwordHash', async () => {
    vi.spyOn(prisma.loan, 'findUnique').mockResolvedValue({
      id: 'loan-a',
      userId: 'member-a',
      requestedAmount: new Prisma.Decimal(40000),
      approvedAmount: new Prisma.Decimal(40000),
      interestRate: new Prisma.Decimal(5),
      applicationFee: new Prisma.Decimal(2000),
      duration: 6,
      purpose: 'Business',
      status: LoanStatus.APPROVED,
      outstandingBalance: new Prisma.Decimal(0),
      totalRepaid: new Prisma.Decimal(0),
      defaultPenalty: new Prisma.Decimal(0),
      gracePeriodDays: 3,
      disbursedAt: null,
      repaymentEndDate: null,
      user: {
        id: 'member-a',
        name: 'Member Alpha',
        email: 'member.a@crystalkairos.coop',
      },
      transactions: [],
    } as never)

    vi.spyOn(prisma.loan, 'findFirst').mockImplementation((async (args: {
      where: { id: string; userId: string }
    }) => {
      if (args.where.id === 'loan-a' && args.where.userId === 'member-a') {
        return {
          id: 'loan-a',
          userId: 'member-a',
          status: LoanStatus.APPROVED,
        }
      }
      return null
    }) as never)

    vi.spyOn(prisma.loan, 'update').mockResolvedValue({
      id: 'loan-a',
      status: LoanStatus.ACCEPTED,
    } as never)

    // 1. Anonymous cannot accept or decline loan offers
    signInAs(null)
    expect((await acceptLoanOfferAction('member-a', 'loan-a')).success).toBe(
      false,
    )
    expect(
      (await declineLoanOfferAction('member-a', 'loan-a', 'Too expensive'))
        .success,
    ).toBe(false)

    // 2. Member B cannot apply, accept, decline, repay, or view Member A's loan
    signInAs('member-b')
    expect(
      (
        await applyForLoanAction('member-a', {
          requestedAmount: 10000,
          duration: 3,
          purpose: 'Spoofed application',
        })
      ).success,
    ).toBe(false)
    expect((await acceptLoanOfferAction('member-a', 'loan-a')).success).toBe(
      false,
    )
    expect((await acceptLoanOfferAction('member-b', 'loan-a')).success).toBe(
      false,
    )
    expect(
      (await declineLoanOfferAction('member-a', 'loan-a', 'Spoofed')).success,
    ).toBe(false)
    expect(
      (
        await submitLoanRepaymentAction('member-a', {
          loanId: 'loan-a',
          amount: 5000,
          receiptUrl: 'https://cdn.example.com/r.png',
        })
      ).success,
    ).toBe(false)
    expect((await getLoanPlanById('loan-a')).success).toBe(false)

    // 3. Member A can view and accept own loan offer; DTO never exposes passwordHash
    signInAs('member-a')
    const loanDetail = await getLoanPlanById('loan-a')
    expect(loanDetail.success).toBe(true)
    expect(JSON.stringify(loanDetail.data)).not.toContain('passwordHash')
    expect((await acceptLoanOfferAction('member-a', 'loan-a')).success).toBe(
      true,
    )

    // 4. searchMemberByEmailAction rejects staff emails as guarantors (D-15)
    const ownerGuarantor = await searchMemberByEmailAction(
      'owner@crystalkairos.coop',
    )
    expect(ownerGuarantor.success).toBe(false)

    const validGuarantor = await searchMemberByEmailAction(
      'member.b@crystalkairos.coop',
    )
    expect(validGuarantor.success).toBe(true)
  })

  it('guards uploadReceiptAction, eAjo queries/actions, and member profile/bank mutations', async () => {
    const file = new File(['dummy-receipt'], 'receipt.png', {
      type: 'image/png',
    })
    const formData = new FormData()
    formData.append('file', file)

    // 1. Anonymous cannot upload receipts or resolve bank accounts
    signInAs(null)
    expect((await uploadReceiptAction(formData)).success).toBe(false)
    expect(
      (await resolveAccountNameAction('GTBank', '0123456789')).success,
    ).toBe(false)

    // 2. Member B cannot read or submit eAjo contributions or edit profile/banks for Member A
    signInAs('member-b')
    expect((await getUserEAjoMemberships('member-a')).success).toBe(false)
    expect(
      (
        await submitEAjoContributionAction(
          'member-a',
          'eajo-member-a',
          5000,
          'https://cdn.example.com/r.png',
        )
      ).success,
    ).toBe(false)
    expect(
      (
        await updateNextOfKinAction('member-a', {
          name: 'Spouse',
          phoneNumber: '08012345678',
          relationship: Relationship.SPOUSE,
          occupation: 'Engineer',
          address: '123 Lagos Way',
          bankName: 'GTBank',
          accountNumber: '0123456789',
          accountName: 'Spouse',
        })
      ).success,
    ).toBe(false)
    expect(
      (
        await addBankAccountAction('member-a', {
          bankName: 'GTBank',
          accountNumber: '0123456789',
          accountName: 'Member A',
        })
      ).success,
    ).toBe(false)

    // 3. Authenticated Member A can upload a receipt
    signInAs('member-a')
    const uploadRes = await uploadReceiptAction(formData)
    expect(uploadRes.success).toBe(true)
  })

  it('rejects deactivated users and stale sessionVersion tokens immediately', async () => {
    vi.spyOn(prisma.transaction, 'findMany').mockResolvedValue([] as never)

    // Deactivated member rejected
    signInAs('deactivated-member')
    const inactiveRes = await getUserTransactions('deactivated-member')
    expect(inactiveRes.success).toBe(false)
    expect(inactiveRes.error).toMatch(/deactivated/i)

    // Stale sessionVersion rejected
    signInAs('member-a', { sessionVersion: 0 })
    const staleRes = await getUserTransactions('member-a')
    expect(staleRes.success).toBe(false)
    expect(staleRes.error).toMatch(/session is no longer valid/i)
  })

  it('prevents admin actions from creating loans, savings, or eAjo memberships for staff accounts (D-15)', async () => {
    signInAs('owner-1')

    const staffLoan = await createLoanForMemberAction({
      userId: 'admin-reviewer',
      purpose: 'Staff loan attempt',
      requestedAmount: 50000,
      duration: 6,
      status: LoanStatus.APPROVED,
    })
    expect(staffLoan.success).toBe(false)
    expect(staffLoan.error).toMatch(/Staff accounts .* cannot hold membership/i)

    const staffSavings = await createSavingsForMemberAction({
      userId: 'owner-1',
      productId: 'prod-1',
      targetAmount: 10000,
      frequency: SavingsFrequency.MONTHLY,
      maturity: SavingsMaturity.SIX_MONTHS,
    })
    expect(staffSavings.success).toBe(false)
    expect(staffSavings.error).toMatch(
      /Staff accounts .* cannot hold membership/i,
    )

    const staffEAjo = await addMemberToEAjoGroupAction({
      userId: 'admin-reviewer',
      groupId: 'group-1',
      payoutPosition: 1,
      status: 'APPROVED',
    })
    expect(staffEAjo.success).toBe(false)
    expect(staffEAjo.error).toMatch(
      /Staff accounts .* cannot hold membership/i,
    )
  })

  it('guards member directory queries and omits passwordHash in getMemberById', async () => {
    // Anonymous and unprivileged admin rejected on getAllMembers
    signInAs(null)
    expect(
      (
        await getAllMembers({
          page: 1,
          pageSize: 5,
          sortField: 'createdAt',
          sortDirection: 'asc',
        })
      ).success,
    ).toBe(false)

    signInAs('admin-no-perms')
    expect(
      (
        await getAllMembers({
          page: 1,
          pageSize: 5,
          sortField: 'createdAt',
          sortDirection: 'asc',
        })
      ).success,
    ).toBe(false)

    // Member A can read own profile via getMemberById and passwordHash is omitted
    signInAs('member-a')
    const ownProfile = await getMemberById('member-a')
    expect(ownProfile.success).toBe(true)
    expect(ownProfile.data).not.toBeNull()
    expect(JSON.stringify(ownProfile.data)).not.toContain('passwordHash')

    // Member A cannot read Member B's profile
    const otherProfile = await getMemberById('member-b')
    expect(otherProfile.success).toBe(false)
  })

  it('verifies D-15 and single-OWNER invariants via checkSystemInvariants', async () => {
    const cleanDb = {
      user: {
        findMany: vi.fn(async () => [
          {
            id: 'owner-1',
            email: 'owner@crystalkairos.coop',
            role: UserRole.OWNER,
            membership: null,
            savings: [],
            loans: [],
            eAjoMembers: [],
            eAjo: [],
          },
          {
            id: 'admin-1',
            email: 'admin@crystalkairos.coop',
            role: UserRole.ADMIN,
            membership: null,
            savings: [],
            loans: [],
            eAjoMembers: [],
            eAjo: [],
          },
        ]),
      },
    }

    const cleanResult = await checkSystemInvariants(cleanDb as never)
    expect(cleanResult.valid).toBe(true)
    expect(cleanResult.violations).toHaveLength(0)

    const dirtyDb = {
      user: {
        findMany: vi.fn(async () => [
          {
            id: 'owner-1',
            email: 'owner@crystalkairos.coop',
            role: UserRole.OWNER,
            membership: { id: 'bad-membership' },
            savings: [],
            loans: [{ id: 'bad-loan' }],
            eAjoMembers: [],
            eAjo: [],
          },
        ]),
      },
    }

    const dirtyResult = await checkSystemInvariants(dirtyDb as never)
    expect(dirtyResult.valid).toBe(false)
    expect(dirtyResult.violations.length).toBeGreaterThanOrEqual(2)
  })
})
