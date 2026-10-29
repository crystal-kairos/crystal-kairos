import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import {
  AdminPermission,
  EAjoDuration,
  EAjoFrequency,
  EAjoMemberStatus,
  EAjoStatus,
  LoanStatus,
  PenaltyCapType,
  PolicyUpdateStatus,
  SavingsMaturity,
  SavingsStatus,
  SavingsType,
  UserRole,
} from '@/generated/prisma/enums'

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
import { Prisma } from '@/generated/prisma/client'
import {
  setLoanTermRate,
  getActiveLoanTermRates,
  setSavingsProductTermRates,
} from '@/lib/services/rate-policy.service'
import { createEAjoGroupAction, activateEAjoGroupAction } from '@/models/admin/actions'
import { toLagosDateString } from '@/lib/domain/dates'

describe('PR P2-05 Integration Tests: Rates, Penalties, Savings Plan Terms & E-Ajo Policies', () => {
  let adminUser: any
  let memberUser: any

  const cleanUpTestData = async () => {
    await prisma.policyUpdateDraft.deleteMany()
    await prisma.eAjoPayout.deleteMany()
    await prisma.eAjoContributionPeriod.deleteMany()
    await prisma.eAjoSlotPolicy.deleteMany()
    await prisma.eAjoMember.deleteMany()
    await prisma.eAjoGroup.deleteMany({ where: { createdByUser: { email: { contains: '-rates-' } } } })
    await prisma.savingsProductTermRate.deleteMany()
    await prisma.savingsPeriod.deleteMany()
    await prisma.savings.deleteMany({ where: { user: { email: { contains: '-rates-' } } } })
    await prisma.savingsProduct.deleteMany({ where: { createdByUser: { email: { contains: '-rates-' } } } })
    await prisma.loanInstalment.deleteMany({ where: { loan: { user: { email: { contains: '-rates-' } } } } })
    await prisma.borrowerOfferAcceptance.deleteMany()
    await prisma.guaranteeReservation.deleteMany()
    await prisma.loan.deleteMany({ where: { user: { email: { contains: '-rates-' } } } })
    await prisma.loanTermRate.deleteMany()
    await prisma.bankAccount.deleteMany({ where: { user: { email: { contains: '-rates-' } } } })
    await prisma.membership.deleteMany({ where: { user: { email: { contains: '-rates-' } } } })
    await prisma.adminPermissionGrant.deleteMany({
      where: {
        OR: [
          { admin: { email: { contains: '-rates-' } } },
          { grantedBy: { email: { contains: '-rates-' } } },
        ],
      },
    })
    await prisma.user.deleteMany({ where: { email: { contains: '-rates-' } } })
  }

  beforeEach(async () => {
    await cleanUpTestData()

    const uniqueTag = `${Date.now()}-${Math.floor(Math.random() * 100000)}`

    adminUser = await prisma.user.create({
      data: {
        email: `admin-rates-${uniqueTag}@test.com`,
        name: 'Rates Admin',
        role: UserRole.ADMIN,
        mfaEnabled: true,
      },
    })

    await prisma.adminPermissionGrant.createMany({
      data: [
        {
          adminUserId: adminUser.id,
          permission: AdminPermission.LOAN_SETTINGS_MANAGE,
          grantedById: adminUser.id,
        },
        {
          adminUserId: adminUser.id,
          permission: AdminPermission.SAVINGS_MANAGE,
          grantedById: adminUser.id,
        },
        {
          adminUserId: adminUser.id,
          permission: AdminPermission.EAJO_MANAGE,
          grantedById: adminUser.id,
        },
        {
          adminUserId: adminUser.id,
          permission: AdminPermission.POLICY_NOTICES_MANAGE,
          grantedById: adminUser.id,
        },
      ],
    })

    mockSessionState.session = {
      user: {
        id: adminUser.id,
        email: adminUser.email,
        name: adminUser.name,
        role: adminUser.role,
      },
    }

    memberUser = await prisma.user.create({
      data: {
        email: `member-rates-${uniqueTag}@test.com`,
        name: 'Rates Borrower',
        role: UserRole.USER,
        membership: {
          create: {
            status: 'APPROVED',
            membershipNumber: `CK-${uniqueTag}`,
          },
        },
        bankAccounts: {
          create: {
            bankName: 'First Bank',
            accountNumber: `${Math.floor(1000000000 + Math.random() * 9000000000)}`,
            accountName: 'Rates Borrower',
          },
        },
      },
    })
  })

  afterEach(async () => {
    await cleanUpTestData()
  })

  afterAll(async () => {
    await cleanUpTestData()
  })

  it('versions loan term rates, snapshots on loan, and appends to policy update draft', async () => {
    // 1. Configure initial 6-month loan term rate (Version 1)
    const rateV1 = await setLoanTermRate(adminUser.id, {
      durationMonths: 6,
      monthlyInterestPercent: 5.0,
      latePenaltyDailyPercent: 0.5,
      penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
      penaltyCapValue: 10.0,
      effectiveFrom: '2027-01-01',
    })

    expect(rateV1.version).toBe(1)
    expect(Number(rateV1.monthlyInterestPercent)).toBe(5.0)

    // Check policy draft created
    const draft1 = await prisma.policyUpdateDraft.findFirst({
      where: { status: PolicyUpdateStatus.DRAFT },
    })
    expect(draft1).not.toBeNull()
    const changes1 = draft1!.changes as any[]
    expect(changes1.length).toBe(1)
    expect(changes1[0].productOrTerm).toBe('Loan 6 Months')

    // 2. Member creates a 6-month loan and snapshots v1
    const loan = await prisma.loan.create({
      data: {
        userId: memberUser.id,
        requestedAmount: 300000,
        approvedAmount: 300000,
        interestRate: 5.0,
        monthlyInterestRatePercent: 5.0,
        interestCalculationMethod: 'FLAT_MONTHLY_ON_ORIGINAL_PRINCIPAL',
        latePenaltyDailyPercent: 0.5,
        penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
        penaltyCapValue: 10.0,
        loanTermRateVersion: 1,
        duration: 6,
        purpose: 'Inventory purchase',
        status: LoanStatus.APPROVED,
      },
    })

    expect(loan.loanTermRateVersion).toBe(1)

    // 3. Admin updates rate for 6 months to 6.0% (Version 2)
    const rateV2 = await setLoanTermRate(adminUser.id, {
      durationMonths: 6,
      monthlyInterestPercent: 6.0,
      latePenaltyDailyPercent: 0.75,
      penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
      penaltyCapValue: 15.0,
      effectiveFrom: '2027-04-01',
    })

    expect(rateV2.version).toBe(2)

    // Previous rate should have effectiveTo set
    const oldRate = await prisma.loanTermRate.findUnique({ where: { id: rateV1.id } })
    expect(oldRate?.effectiveTo).not.toBeNull()

    // Policy draft should have both changes appended
    const draft2 = await prisma.policyUpdateDraft.findFirst({
      where: { status: PolicyUpdateStatus.DRAFT },
    })
    const changes2 = draft2!.changes as any[]
    expect(changes2.length).toBe(2)

    // Existing loan keeps its snapshotted Version 1 rates
    const reloadedLoan = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })
    expect(reloadedLoan.loanTermRateVersion).toBe(1)
    expect(Number(reloadedLoan.monthlyInterestRatePercent)).toBe(5.0)
    expect(Number(reloadedLoan.latePenaltyDailyPercent)).toBe(0.5)
  })

  it('manages savings product term rates, generates canonical display text, and snapshots subscription', async () => {
    // 1. Create a SavingsProduct
    const product = await prisma.savingsProduct.create({
      data: {
        title: 'Target Growth Fund',
        description: 'Disciplined savings for personal projects',
        type: SavingsType.REGULAR,
        badge: 'Recommended',
        icon: 'PiggyBank',
        createdBy: adminUser.id,
      },
    })

    // 2. Set term rates for 6 and 12 months (D-09)
    await setSavingsProductTermRates(adminUser.id, product.id, [
      { durationMonths: 6, ratePercent: 12.0 },
      { durationMonths: 12, ratePercent: 24.0 },
    ])

    // Verify canonical rate display text is updated
    const refreshedProduct = await prisma.savingsProduct.findUniqueOrThrow({
      where: { id: product.id },
      include: { termRates: true },
    })
    expect(refreshedProduct.rates).toBe('12.00% (6M) / 24.00% (12M)')
    expect(refreshedProduct.termRates.length).toBe(2)

    // 3. Member subscribes to 6-month term
    const termRate6 = refreshedProduct.termRates.find((r) => r.durationMonths === 6)!
    const savings = await prisma.savings.create({
      data: {
        userId: memberUser.id,
        productId: product.id,
        savingsType: SavingsType.REGULAR,
        frequency: 'MONTHLY',
        maturity: SavingsMaturity.SIX_MONTHS,
        durationMonths: 6,
        ratePercent: termRate6.ratePercent,
        interestCalculationMethod: 'SIMPLE_INTEREST_HELD_FRACTION',
        savingsProductTermRateVersion: termRate6.version,
        interestRate: termRate6.ratePercent,
        bankName: 'First Bank',
        accountNumber: '0123456789',
        accountName: 'Rates Borrower',
        status: SavingsStatus.ACTIVE,
      },
    })

    expect(savings.durationMonths).toBe(6)
    expect(Number(savings.ratePercent)).toBe(12.0)
    expect(savings.savingsProductTermRateVersion).toBe(1)

    // 4. Admin updates 6-month rate to 14%
    await setSavingsProductTermRates(adminUser.id, product.id, [
      { durationMonths: 6, ratePercent: 14.0 },
    ])

    // Subscription keeps snapshotted 12%
    const reloadedSavings = await prisma.savings.findUniqueOrThrow({ where: { id: savings.id } })
    expect(Number(reloadedSavings.ratePercent)).toBe(12.0)
    expect(reloadedSavings.savingsProductTermRateVersion).toBe(1)
  })

  it('rejects eAjo group creation without complete slot policies or non-monthly frequency', async () => {
    // Reject non-monthly frequency (A-09)
    await expect(
      createEAjoGroupAction({
        title: 'Weekly Ajo Group',
        contributionAmount: 10000,
        frequency: EAjoFrequency.WEEKLY,
        duration: EAjoDuration.FOUR_MONTHS,
        slotPolicies: [
          { slotNumber: 1, earlySlotPenaltyPercent: 10 },
          { slotNumber: 2, earlySlotPenaltyPercent: 5 },
          { slotNumber: 3, earlySlotPenaltyPercent: 0 },
          { slotNumber: 4, earlySlotPenaltyPercent: 0 },
        ],
      })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Contribution frequency is fixed to MONTHLY'),
    })

    // Reject missing slot policy (only 3 of 4 provided)
    await expect(
      createEAjoGroupAction({
        title: 'Incomplete Slot Policy Group',
        contributionAmount: 10000,
        frequency: EAjoFrequency.MONTHLY,
        duration: EAjoDuration.FOUR_MONTHS,
        slotPolicies: [
          { slotNumber: 1, earlySlotPenaltyPercent: 10 },
          { slotNumber: 2, earlySlotPenaltyPercent: 5 },
          { slotNumber: 3, earlySlotPenaltyPercent: 0 },
        ],
      })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('A slot policy is mandatory for EVERY slot'),
    })
  })

  it('creates eAjo group with all slot policies, activates and generates EAjoPayout records (Appendix C4)', async () => {
    // 12-slot group matching Appendix C4
    const slotPolicies = Array.from({ length: 12 }, (_, i) => {
      const slot = i + 1
      return {
        slotNumber: slot,
        earlySlotPenaltyPercent: slot === 1 ? 15 : slot === 2 ? 10 : 0,
      }
    })

    const groupRes = await createEAjoGroupAction({
      title: '12-Month Expansion Ajo',
      contributionAmount: 10000,
      frequency: EAjoFrequency.MONTHLY,
      duration: EAjoDuration.TWELVE_MONTHS,
      latePenaltyDailyPercent: 0.5,
      penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
      penaltyCapValue: 10,
      slotPolicies,
    })

    expect(groupRes.success).toBe(true)
    const groupId = groupRes.data!.id

    // Check all 12 slot policies were created in DB
    const persistedPolicies = await prisma.eAjoSlotPolicy.findMany({
      where: { groupId },
      orderBy: { slotNumber: 'asc' },
    })
    expect(persistedPolicies.length).toBe(12)
    expect(Number(persistedPolicies[0].earlySlotPenaltyPercent)).toBe(15)
    expect(Number(persistedPolicies[1].earlySlotPenaltyPercent)).toBe(10)
    expect(Number(persistedPolicies[11].earlySlotPenaltyPercent)).toBe(0)

    // Add member to Slot 2 (matching Appendix C4)
    const member = await prisma.eAjoMember.create({
      data: {
        groupId,
        userId: memberUser.id,
        payoutPosition: 2,
        guarantorName: 'Guarantor Test',
        guarantorPhoneNumber: '08012345678',
        bankName: 'First Bank',
        accountNumber: '0123456789',
        accountName: 'Rates Borrower',
        status: EAjoMemberStatus.APPROVED,
      },
    })

    // Activate group
    const activateRes = await activateEAjoGroupAction(groupId)
    expect(activateRes.success).toBe(true)

    // Check member snapshotted values
    const activatedMember = await prisma.eAjoMember.findUniqueOrThrow({
      where: { id: member.id },
      include: { payout: true },
    })

    expect(activatedMember.status).toBe(EAjoMemberStatus.ACTIVE)
    expect(Number(activatedMember.earlySlotPenaltyPercent)).toBe(10)
    expect(Number(activatedMember.latePenaltyDailyPercent)).toBe(0.5)

    // Check EAjoPayout row generated matches Appendix C4 exactly
    const payout = activatedMember.payout!
    expect(payout).not.toBeNull()
    expect(Number(payout.expectedPayout)).toBe(120000)
    expect(Number(payout.advanceAmount)).toBe(100000)
    expect(Number(payout.earlySlotPenalty)).toBe(10000)
    expect(Number(payout.netPayout)).toBe(110000)
  })
})
