import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import {
  EAjoDuration,
  EAjoFrequency,
  EAjoStatus,
  Gender,
  MembershipStatus,
  SavingsFrequency,
  SavingsMaturity,
  SavingsType,
  UserRole,
} from '@/generated/prisma/enums'

const mockSessionHolder = {
  session: null as any,
}

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => mockSessionHolder.session),
}))

vi.mock('@/models/members/actions', () => ({
  getSessionHelper: vi.fn(async () => mockSessionHolder.session),
}))

import { prisma } from '@/lib/prisma'
import { register } from '@/models/auth/query'
import { getProfileCompletion } from '@/lib/services/profile.service'
import { applyForLoanAction } from '@/models/loans/actions'
import { createSavingsPlanAction } from '@/models/savings/actions'
import { applyToEAjoGroupAction } from '@/models/eajo/actions'

describe('Registration Simplification & Profile-Completion Gates (PR P3-01)', () => {
  const timestamp = Date.now()
  const randomSuffix = Math.floor(10000000 + Math.random() * 90000000)
  const testEmailPrefix = `test-p301-${timestamp}`
  const user1Email = `${testEmailPrefix}-user1@test.com`
  const user2Email = `${testEmailPrefix}-user2@test.com`
  const user1Phone = `080${randomSuffix}`
  const user1PhoneE164 = `+23480${randomSuffix}`
  const user1BankAccount = String(Math.floor(1000000000 + Math.random() * 9000000000))

  let user1Id: string
  let testGroupId: string

  beforeEach(() => {
    delete process.env.MOCK_SESSION_USER
  })

  afterAll(async () => {
    // Cleanup any test data created
    const testUsers = await prisma.user.findMany({
      where: { email: { startsWith: testEmailPrefix } },
      select: { id: true },
    })
    const ids = testUsers.map((u) => u.id)

    if (testGroupId) {
      await prisma.eAjoMember.deleteMany({ where: { groupId: testGroupId } })
      await prisma.eAjoGroup.deleteMany({ where: { id: testGroupId } })
    }

    if (ids.length > 0) {
      await prisma.notification.deleteMany({ where: { recipientId: { in: ids } } })
      await prisma.auditEvent.deleteMany({
        where: { OR: [{ actorId: { in: ids } }, { affectedUserId: { in: ids } }] },
      })
      await prisma.privacyConsent.deleteMany({ where: { userId: { in: ids } } })
      await prisma.storedFile.deleteMany({ where: { uploadedById: { in: ids } } })
      await prisma.bankAccount.deleteMany({ where: { userId: { in: ids } } })
      await prisma.nextOfKin.deleteMany({ where: { userId: { in: ids } } })
      await prisma.membership.deleteMany({ where: { userId: { in: ids } } })
      await prisma.userInfo.deleteMany({ where: { userId: { in: ids } } })
      await prisma.passwordSetupToken.deleteMany({ where: { userId: { in: ids } } })
      await prisma.user.deleteMany({ where: { id: { in: ids } } })
    }
  })

  it('1. Simplifies registration: allows registering with personal details only and auto-records privacy consent', async () => {
    const regResult = await register({
      name: 'P301 Test Member',
      email: user1Email,
      phoneNumber: user1Phone,
      address: '10 Marina Street, Lagos Island',
      gender: Gender.MALE,
      occupation: 'Trader',
    })

    if (!regResult.success) {
      console.error('Registration failed:', regResult)
    }

    expect(regResult.success).toBe(true)
    expect(regResult.user).toBeDefined()
    user1Id = regResult.user!.id

    // Check user record in database
    const dbUser = await prisma.user.findUnique({
      where: { id: user1Id },
      include: {
        userInfo: true,
        membership: true,
        privacyConsents: true,
        bankAccounts: true,
        nextOfKin: true,
      },
    })

    expect(dbUser).not.toBeNull()
    expect(dbUser!.role).toBe(UserRole.USER)
    expect(dbUser!.userInfo?.phoneNumber).toBe(user1PhoneE164)
    expect(dbUser!.membership?.status).toBe(MembershipStatus.PENDING)

    // Verify PrivacyConsent record was automatically created with v1.0
    expect(dbUser!.privacyConsents.length).toBeGreaterThanOrEqual(1)
    expect(dbUser!.privacyConsents[0].noticeVersion).toBe('v1.0')

    // Verify skipped sections were NOT populated
    expect(dbUser!.bankAccounts).toHaveLength(0)
    expect(dbUser!.nextOfKin).toBeNull()
  })

  it('2. Enforces phone number uniqueness across active members (A-22)', async () => {
    // Attempt to register a different user with the same phone number (in local 080 format)
    const duplicateLocalResult = await register({
      name: 'Duplicate Phone Local',
      email: user2Email,
      phoneNumber: user1Phone,
    })

    expect(duplicateLocalResult.success).toBe(false)
    expect(duplicateLocalResult.error).toContain('already registered')

    // Attempt to register with the same phone in E.164 format (+23480...)
    const duplicateE164Result = await register({
      name: 'Duplicate Phone E164',
      email: user2Email,
      phoneNumber: user1PhoneE164,
    })

    expect(duplicateE164Result.success).toBe(false)
    expect(duplicateE164Result.error).toContain('already registered')
  })

  it('3. Reports incomplete profile and pending review on getProfileCompletion', async () => {
    const report = await getProfileCompletion(user1Id)

    expect(report.userId).toBe(user1Id)
    expect(report.membershipStatus).toBe(MembershipStatus.PENDING)
    expect(report.isApproved).toBe(false)
    expect(report.isComplete).toBe(false)
    expect(report.completionPercentage).toBeLessThan(100)
    expect(report.missingSections).toContain('Bank Account')
    expect(report.missingSections).toContain('Next of Kin')

    // All products must be marked ineligible
    expect(report.productEligibility.SAVINGS.eligible).toBe(false)
    expect(report.productEligibility.LOAN.eligible).toBe(false)
    expect(report.productEligibility.EAJO.eligible).toBe(false)
  })

  it('4. Server-side gate blocks loan applications for incomplete and unapproved members', async () => {
    mockSessionHolder.session = {
      user: {
        id: user1Id,
        email: user1Email,
        name: 'P301 Test Member',
        role: UserRole.USER,
      },
    }

    const loanResult = await applyForLoanAction(user1Id, {
      requestedAmount: 50000,
      duration: 3,
      purpose: 'Business expansion',
    })

    expect(loanResult.success).toBe(false)
    expect(loanResult.error).toMatch(/Membership must be approved|Profile completion required/)
  })

  it('5. Server-side gate blocks savings plan applications for incomplete and unapproved members', async () => {
    mockSessionHolder.session = {
      user: {
        id: user1Id,
        email: user1Email,
        name: 'P301 Test Member',
        role: UserRole.USER,
      },
    }

    const savingsResult = await createSavingsPlanAction(user1Id, {
      savingsType: SavingsType.REGULAR,
      targetAmount: 100000,
      frequency: SavingsFrequency.MONTHLY,
      maturity: SavingsMaturity.THREE_MONTHS,
      bankName: 'Access Bank',
      accountNumber: '0123456789',
      accountName: 'P301 Test Member',
    })

    expect(savingsResult.success).toBe(false)
    expect(savingsResult.error).toMatch(/Membership must be approved|Profile completion required/)
  })

  it('6. Server-side gate blocks e-Ajo participation for incomplete and unapproved members', async () => {
    mockSessionHolder.session = {
      user: {
        id: user1Id,
        email: user1Email,
        name: 'P301 Test Member',
        role: UserRole.USER,
      },
    }

    // Create a temporary ajo group to apply to
    const group = await prisma.eAjoGroup.create({
      data: {
        title: `P301 Test Ajo ${timestamp}`,
        contributionAmount: 10000,
        frequency: EAjoFrequency.MONTHLY,
        duration: EAjoDuration.FOUR_MONTHS,
        totalSlots: 4,
        filledSlots: 0,
        startDate: new Date(),
        status: EAjoStatus.PENDING,
        createdBy: user1Id,
      },
    })
    testGroupId = group.id

    const ajoResult = await applyToEAjoGroupAction(user1Id, testGroupId, {
      payoutPosition: 1,
      guarantorName: 'Guarantor Test',
      guarantorPhoneNumber: '+2348099887766',
      bankName: 'Zenith Bank',
      accountNumber: '2233445566',
      accountName: 'P301 Test Member',
    })

    expect(ajoResult.success).toBe(false)
    expect(ajoResult.error).toMatch(/Membership must be approved|Profile completion required/)
  })

  it('7. Completing profile and admin approval unlocks eligibility', async () => {
    // 1. Add bank account
    await prisma.bankAccount.create({
      data: {
        userId: user1Id,
        bankName: 'Zenith Bank',
        accountNumber: user1BankAccount,
        accountName: 'P301 Test Member',
        isPrimary: true,
      },
    })

    // 2. Add next of kin
    await prisma.nextOfKin.create({
      data: {
        userId: user1Id,
        name: 'Kin Member',
        phoneNumber: '+2348088776655',
        relationship: 'SPOUSE',
        occupation: 'Trader',
        address: '10 Marina Street, Lagos Island',
        bankName: 'Zenith Bank',
        accountNumber: user1BankAccount,
        accountName: 'Kin Member',
      },
    })

    // 3. Set passport photo URL
    await prisma.user.update({
      where: { id: user1Id },
      data: {
        photoUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
      },
    })

    // 4. Update userInfo with dateOfBirth if missing
    await prisma.userInfo.update({
      where: { userId: user1Id },
      data: {
        dateOfBirth: new Date('1990-05-15'),
      },
    })

    // 5. Admin approves membership
    await prisma.membership.update({
      where: { userId: user1Id },
      data: {
        status: MembershipStatus.APPROVED,
      },
    })

    // Verify report is now 100% complete and approved
    const updatedReport = await getProfileCompletion(user1Id)
    expect(updatedReport.isApproved).toBe(true)
    expect(updatedReport.isComplete).toBe(true)
    expect(updatedReport.completionPercentage).toBe(100)
    expect(updatedReport.missingSections).toHaveLength(0)
    expect(updatedReport.productEligibility.SAVINGS.eligible).toBe(true)
    expect(updatedReport.productEligibility.LOAN.eligible).toBe(true)
    expect(updatedReport.productEligibility.EAJO.eligible).toBe(true)
  })
})
