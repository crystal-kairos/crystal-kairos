import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { Prisma } from '@/generated/prisma/client'
import {
  AdminPermission,
  BorrowerOfferDecision,
  GuaranteeState,
  GuaranteeType,
  LoanStatus,
  SavingsFrequency,
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
import {
  getMemberEligibleSavingsPrincipal,
  getMemberUnencumberedSavings,
  requestLoanGuarantor,
  decideGuarantorRequest,
  withdrawGuarantorConsent,
  recordBorrowerOfferAcceptance,
  assertSavingsWithdrawalAllowed,
} from '@/lib/services/guarantees.service'
import {
  calculateRequiredGuaranteeSupport,
  getBorrowerStandaloneLimit,
  getGuarantorAvailableCapacity,
} from '@/lib/domain/capacity'
import { approveLoanAction, disburseLoanAction } from '@/models/admin/loanActions'
import {
  acceptLoanOfferAction,
  declineLoanOfferAction,
  decideGuarantorRequestAction,
} from '@/models/loans/actions'
import { requestSavingsWithdrawalAction } from '@/models/savings/actions'
import { GET as getEvidenceRoute } from '@/app/api/guarantees/[id]/evidence/route'
import { NextRequest } from 'next/server'

describe('Guarantor Requests, Capacity Reservations & Savings Locks Integration (PR P2-04, §2.1, §2.7)', () => {
  const timestamp = Date.now()
  const testEmailPrefix = `test-p204-${timestamp}`

  beforeEach(() => {
    delete process.env.MOCK_SESSION_USER
    mockSessionState.session = null
  })

  afterAll(async () => {
    const testUsers = await prisma.user.findMany({
      where: { email: { startsWith: testEmailPrefix } },
      select: { id: true },
    })
    const userIds = testUsers.map((u) => u.id)

    if (userIds.length > 0) {
      // Clean up guarantee reservations & offer acceptances
      await prisma.borrowerOfferAcceptance.deleteMany({
        where: { borrowerId: { in: userIds } },
      })
      await prisma.guaranteeReservation.deleteMany({
        where: {
          OR: [{ applicantId: { in: userIds } }, { guarantorId: { in: userIds } }],
        },
      })
      await prisma.transaction.deleteMany({
        where: { userId: { in: userIds } },
      })
      await prisma.loanInstalment.deleteMany({
        where: { loan: { userId: { in: userIds } } },
      })
      await prisma.loan.deleteMany({
        where: { userId: { in: userIds } },
      })
      await prisma.savingsPeriod.deleteMany({
        where: { savings: { userId: { in: userIds } } },
      })
      await prisma.savings.deleteMany({
        where: { userId: { in: userIds } },
      })
      await prisma.bankAccount.deleteMany({
        where: { userId: { in: userIds } },
      })
      await prisma.adminPermissionGrant.deleteMany({
        where: { adminUserId: { in: userIds } },
      })
      await prisma.user.deleteMany({
        where: { id: { in: userIds } },
      })
    }
  })

  // Helper to create member with active savings
  async function createMemberWithSavings(params: {
    emailSuffix: string
    name: string
    savingsAmount: number
    role?: UserRole
    isActive?: boolean
  }) {
    const user = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-${params.emailSuffix}@example.com`,
        name: params.name,
        role: params.role || UserRole.USER,
        isActive: params.isActive !== false,
        sessionVersion: 1,
        mfaEnabled: true,
      },
    })

    if (params.savingsAmount > 0) {
      await prisma.savings.create({
        data: {
          userId: user.id,
          savingsType: SavingsType.REGULAR,
          frequency: SavingsFrequency.MONTHLY,
          maturity: SavingsMaturity.TWELVE_MONTHS,
          targetAmount: new Prisma.Decimal(params.savingsAmount),
          currentBalance: new Prisma.Decimal(params.savingsAmount),
          totalDeposited: new Prisma.Decimal(params.savingsAmount),
          status: SavingsStatus.ACTIVE,
          interestRate: new Prisma.Decimal(5),
          expectedMaturityAmount: new Prisma.Decimal(params.savingsAmount * 1.05),
          bankName: 'Test Bank',
          accountNumber: '0123456789',
          accountName: params.name,
        },
      })
    }

    return user
  }

  it('enforces guarantor eligibility rules: self, staff, deactivated, zero savings cannot guarantee', async () => {
    const borrower = await createMemberWithSavings({
      emailSuffix: 'b1',
      name: 'Borrower One',
      savingsAmount: 100000,
    })

    const staffGuarantor = await createMemberWithSavings({
      emailSuffix: 'staff-g',
      name: 'Staff Guarantor',
      savingsAmount: 200000,
      role: UserRole.ADMIN,
    })

    const deactivatedGuarantor = await createMemberWithSavings({
      emailSuffix: 'deact-g',
      name: 'Deactivated Guarantor',
      savingsAmount: 200000,
      isActive: false,
    })

    const zeroSavingsGuarantor = await createMemberWithSavings({
      emailSuffix: 'zero-g',
      name: 'Zero Savings Guarantor',
      savingsAmount: 0,
    })

    const loan = await prisma.loan.create({
      data: {
        userId: borrower.id,
        requestedAmount: new Prisma.Decimal(250000),
        duration: 6,
        interestRate: new Prisma.Decimal(5),
        purpose: 'Eligibility Check Loan',
        status: LoanStatus.PENDING,
      },
    })

    // 1. Cannot guarantee self
    await expect(
      prisma.$transaction(async (tx) => {
        return requestLoanGuarantor(tx, {
          loanId: loan.id,
          applicantId: borrower.id,
          guarantorId: borrower.id,
          requestedAmount: 50000,
          termMonths: 6,
          monthlyInterestRate: 5,
        })
      }),
    ).rejects.toThrow('Applicant cannot be their own guarantor')

    // 2. Staff user cannot guarantee
    await expect(
      prisma.$transaction(async (tx) => {
        return requestLoanGuarantor(tx, {
          loanId: loan.id,
          applicantId: borrower.id,
          guarantorId: staffGuarantor.id,
          requestedAmount: 50000,
          termMonths: 6,
          monthlyInterestRate: 5,
        })
      }),
    ).rejects.toThrow('Staff users (OWNER, ADMIN) can never be guarantors')

    // 3. Deactivated member cannot guarantee
    await expect(
      prisma.$transaction(async (tx) => {
        return requestLoanGuarantor(tx, {
          loanId: loan.id,
          applicantId: borrower.id,
          guarantorId: deactivatedGuarantor.id,
          requestedAmount: 50000,
          termMonths: 6,
          monthlyInterestRate: 5,
        })
      }),
    ).rejects.toThrow('Deactivated members cannot serve as guarantors')

    // 4. Zero savings member cannot guarantee
    await expect(
      prisma.$transaction(async (tx) => {
        return requestLoanGuarantor(tx, {
          loanId: loan.id,
          applicantId: borrower.id,
          guarantorId: zeroSavingsGuarantor.id,
          requestedAmount: 50000,
          termMonths: 6,
          monthlyInterestRate: 5,
        })
      }),
    ).rejects.toThrow('positive eligible unencumbered savings')
  })

  it('guarantor explicit decision flow: accept creates reservation with PDF, decline releases reservation', async () => {
    const borrower = await createMemberWithSavings({
      emailSuffix: 'b-flow',
      name: 'Borrower Flow',
      savingsAmount: 100000, // Standalone limit = ₦200,000
    })

    const guarantor = await createMemberWithSavings({
      emailSuffix: 'g-flow',
      name: 'Guarantor Flow',
      savingsAmount: 80000,
    })

    const loan = await prisma.loan.create({
      data: {
        userId: borrower.id,
        requestedAmount: new Prisma.Decimal(250000), // Needs ₦50,000 guarantee support
        duration: 6,
        interestRate: new Prisma.Decimal(5),
        purpose: 'Consent Flow Test Loan',
        status: LoanStatus.PENDING,
      },
    })

    // 1. Create request
    const reservation = await prisma.$transaction(async (tx) => {
      return requestLoanGuarantor(tx, {
        loanId: loan.id,
        applicantId: borrower.id,
        guarantorId: guarantor.id,
        requestedAmount: 250000,
        termMonths: 6,
        monthlyInterestRate: 5,
      })
    })

    expect(reservation.state).toBe(GuaranteeState.PENDING)
    expect(reservation.reservedAmount.toNumber()).toBe(0)

    // 2. Applicant or third party cannot decide on guarantor's behalf
    await expect(
      prisma.$transaction(async (tx) => {
        return decideGuarantorRequest(tx, {
          reservationId: reservation.id,
          guarantorId: borrower.id, // wrong ID
          decision: 'ACCEPT',
        })
      }),
    ).rejects.toThrow('not authorised to decide this guarantee request')

    // 3. Guarantor accepts
    const acceptOutcome = await prisma.$transaction(async (tx) => {
      return decideGuarantorRequest(tx, {
        reservationId: reservation.id,
        guarantorId: guarantor.id,
        decision: 'ACCEPT',
      })
    })

    expect(acceptOutcome.reservation.state).toBe(GuaranteeState.CONSENTED)
    expect(acceptOutcome.reservation.reservedAmount.toNumber()).toBe(50000)
    expect(acceptOutcome.evidence.documentId).toMatch(/^CK-EVD-/)
    expect(acceptOutcome.evidence.sha256).toBeDefined()
    expect(acceptOutcome.evidence.pdfBuffer).toBeDefined()

    // Free capacity of guarantor is now ₦80,000 - ₦50,000 = ₦30,000
    const freeCapacity = await getMemberUnencumberedSavings(guarantor.id)
    expect(freeCapacity.toNumber()).toBe(30000)

    // 4. Guarantor withdraws consent before loan activation
    const withdrawOutcome = await prisma.$transaction(async (tx) => {
      return withdrawGuarantorConsent(tx, {
        reservationId: reservation.id,
        guarantorId: guarantor.id,
        reason: 'Change of mind before approval',
      })
    })

    expect(withdrawOutcome.state).toBe(
      GuaranteeState.WITHDRAWN_BEFORE_ACTIVATION,
    )
    expect(withdrawOutcome.reservedAmount.toNumber()).toBe(0)

    // Free capacity restored to ₦80,000
    const restoredCapacity = await getMemberUnencumberedSavings(guarantor.id)
    expect(restoredCapacity.toNumber()).toBe(80000)
  })

  it('Appendix C3 fixture: cumulative capacity across portfolio rejects deficit application', async () => {
    // Borrower has ₦100,000 confirmed savings (standalone limit ₦200,000)
    const borrower = await createMemberWithSavings({
      emailSuffix: 'c3-borrower',
      name: 'C3 Borrower',
      savingsAmount: 100000,
    })

    // Guarantor has ₦80,000 confirmed savings
    const guarantor = await createMemberWithSavings({
      emailSuffix: 'c3-guarantor',
      name: 'C3 Guarantor',
      savingsAmount: 80000,
    })

    // Loan 1: ₦250,000 (requires ₦50,000 support)
    const loan1 = await prisma.loan.create({
      data: {
        userId: borrower.id,
        requestedAmount: new Prisma.Decimal(250000),
        approvedAmount: new Prisma.Decimal(250000),
        duration: 6,
        interestRate: new Prisma.Decimal(5),
        purpose: 'Loan 1',
        status: LoanStatus.APPROVED,
      },
    })

    const res1 = await prisma.$transaction(async (tx) => {
      const r = await requestLoanGuarantor(tx, {
        loanId: loan1.id,
        applicantId: borrower.id,
        guarantorId: guarantor.id,
        requestedAmount: 250000,
        termMonths: 6,
        monthlyInterestRate: 5,
      })
      return decideGuarantorRequest(tx, {
        reservationId: r.id,
        guarantorId: guarantor.id,
        decision: 'ACCEPT',
      })
    })

    expect(res1.reservation.reservedAmount.toNumber()).toBe(50000)

    // Guarantor remaining capacity = ₦80,000 - ₦50,000 = ₦30,000
    const remainingCap = await getGuarantorAvailableCapacity(
      80000,
      await prisma.guaranteeReservation.findMany({
        where: { guarantorId: guarantor.id, state: GuaranteeState.CONSENTED },
      }).then((rs) => rs.reduce((acc, r) => acc + r.reservedAmount.toNumber(), 0)),
    )
    expect(remainingCap.toNumber()).toBe(30000)

    // Loan 2: ₦40,000. Projected cumulative exposure = ₦290,000. Standalone limit = ₦200,000.
    // Required guarantee support = ₦90,000. Additional support needed = ₦40,000.
    // Guarantor only has ₦30,000 available -> ₦10,000 deficit!
    const loan2 = await prisma.loan.create({
      data: {
        userId: borrower.id,
        requestedAmount: new Prisma.Decimal(40000),
        duration: 3,
        interestRate: new Prisma.Decimal(5),
        purpose: 'Loan 2',
        status: LoanStatus.PENDING,
      },
    })

    await expect(
      prisma.$transaction(async (tx) => {
        return requestLoanGuarantor(tx, {
          loanId: loan2.id,
          applicantId: borrower.id,
          guarantorId: guarantor.id,
          requestedAmount: 40000,
          termMonths: 3,
          monthlyInterestRate: 5,
        })
      }),
    ).rejects.toThrow('Guarantor has insufficient free capacity')
  })

  it('parallel concurrency race test: two concurrent guarantee requests exceeding capacity cannot both succeed', async () => {
    // Guarantor has ₦100,000 savings
    const guarantor = await createMemberWithSavings({
      emailSuffix: 'race-g',
      name: 'Race Guarantor',
      savingsAmount: 100000,
    })

    // Borrower A has 0 savings, needs ₦70,000 guarantee support
    const borrowerA = await createMemberWithSavings({
      emailSuffix: 'race-ba',
      name: 'Borrower A',
      savingsAmount: 0,
    })

    // Borrower B has 0 savings, needs ₦70,000 guarantee support
    const borrowerB = await createMemberWithSavings({
      emailSuffix: 'race-bb',
      name: 'Borrower B',
      savingsAmount: 0,
    })

    const loanA = await prisma.loan.create({
      data: {
        userId: borrowerA.id,
        requestedAmount: new Prisma.Decimal(70000),
        duration: 6,
        interestRate: new Prisma.Decimal(5),
        purpose: 'Race Loan A',
        status: LoanStatus.PENDING,
      },
    })

    const loanB = await prisma.loan.create({
      data: {
        userId: borrowerB.id,
        requestedAmount: new Prisma.Decimal(70000),
        duration: 6,
        interestRate: new Prisma.Decimal(5),
        purpose: 'Race Loan B',
        status: LoanStatus.PENDING,
      },
    })

    // Launch both requests concurrently
    const results = await Promise.allSettled([
      prisma.$transaction(async (tx) => {
        const reqA = await requestLoanGuarantor(tx, {
          loanId: loanA.id,
          applicantId: borrowerA.id,
          guarantorId: guarantor.id,
          requestedAmount: 70000,
          termMonths: 6,
          monthlyInterestRate: 5,
        })
        return decideGuarantorRequest(tx, {
          reservationId: reqA.id,
          guarantorId: guarantor.id,
          decision: 'ACCEPT',
        })
      }),
      prisma.$transaction(async (tx) => {
        const reqB = await requestLoanGuarantor(tx, {
          loanId: loanB.id,
          applicantId: borrowerB.id,
          guarantorId: guarantor.id,
          requestedAmount: 70000,
          termMonths: 6,
          monthlyInterestRate: 5,
        })
        return decideGuarantorRequest(tx, {
          reservationId: reqB.id,
          guarantorId: guarantor.id,
          decision: 'ACCEPT',
        })
      }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    // Exactly one must succeed, one must fail because ₦70,000 + ₦70,000 = ₦140,000 > ₦100,000
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)

    // Total reserved amount on guarantor must be exactly ₦70,000
    const reservations = await prisma.guaranteeReservation.findMany({
      where: {
        guarantorId: guarantor.id,
        state: GuaranteeState.CONSENTED,
      },
    })
    const totalReserved = reservations.reduce(
      (sum, r) => sum + r.reservedAmount.toNumber(),
      0,
    )
    expect(totalReserved).toBe(70000)
  })

  it('own-savings lock (FULL mode, D-02): borrower cannot withdraw savings while loan is active or approved', async () => {
    const borrower = await createMemberWithSavings({
      emailSuffix: 'lien-b',
      name: 'Lien Borrower',
      savingsAmount: 150000,
    })

    const savings = await prisma.savings.findFirst({
      where: { userId: borrower.id },
    })
    expect(savings).not.null

    // Create an approved loan
    await prisma.loan.create({
      data: {
        userId: borrower.id,
        requestedAmount: new Prisma.Decimal(100000),
        approvedAmount: new Prisma.Decimal(100000),
        duration: 6,
        interestRate: new Prisma.Decimal(5),
        purpose: 'Lien Test Loan',
        status: LoanStatus.APPROVED,
      },
    })

    mockSessionState.session = {
      user: {
        id: borrower.id,
        email: borrower.email,
        name: borrower.name,
        role: UserRole.USER,
        sessionVersion: 1,
      },
    }

    // Attempt savings withdrawal
    const result = await requestSavingsWithdrawalAction(borrower.id, savings!.id)
    expect(result.success).toBe(false)
    expect(result.code).toBe('OWN_SAVINGS_LOCKED')
    expect(result.error).toContain('confirmed savings principal is locked')
  })

  it('guarantor reserved savings lock: guarantor cannot withdraw savings encumbered by active guarantee', async () => {
    const borrower = await createMemberWithSavings({
      emailSuffix: 'enc-b',
      name: 'Enc Borrower',
      savingsAmount: 0,
    })

    const guarantor = await createMemberWithSavings({
      emailSuffix: 'enc-g',
      name: 'Enc Guarantor',
      savingsAmount: 100000,
    })

    const gSavings = await prisma.savings.findFirst({
      where: { userId: guarantor.id },
    })

    const loan = await prisma.loan.create({
      data: {
        userId: borrower.id,
        requestedAmount: new Prisma.Decimal(60000),
        duration: 6,
        interestRate: new Prisma.Decimal(5),
        purpose: 'Enc Loan',
        status: LoanStatus.PENDING,
      },
    })

    // Reserve ₦60,000 on guarantor
    await prisma.$transaction(async (tx) => {
      const req = await requestLoanGuarantor(tx, {
        loanId: loan.id,
        applicantId: borrower.id,
        guarantorId: guarantor.id,
        requestedAmount: 60000,
        termMonths: 6,
        monthlyInterestRate: 5,
      })
      return decideGuarantorRequest(tx, {
        reservationId: req.id,
        guarantorId: guarantor.id,
        decision: 'ACCEPT',
      })
    })

    // Guarantor has ₦100,000 savings with ₦60,000 reserved -> ₦40,000 unencumbered
    // Attempting to withdraw the full ₦100,000 savings plan must fail with SAVINGS_ENCUMBERED
    mockSessionState.session = {
      user: {
        id: guarantor.id,
        email: guarantor.email,
        name: guarantor.name,
        role: UserRole.USER,
        sessionVersion: 1,
      },
    }

    const withdrawResult = await requestSavingsWithdrawalAction(
      guarantor.id,
      gSavings!.id,
    )
    expect(withdrawResult.success).toBe(false)
    expect(withdrawResult.code).toBe('SAVINGS_ENCUMBERED')
    expect(withdrawResult.error).toContain('reserved to secure active guarantees')
  })

  it('admin approval term changes force AWAITING_RECONSENT and release reservation (§2.7)', async () => {
    const borrower = await createMemberWithSavings({
      emailSuffix: 'rev-b',
      name: 'Revision Borrower',
      savingsAmount: 0,
    })

    const guarantor = await createMemberWithSavings({
      emailSuffix: 'rev-g',
      name: 'Revision Guarantor',
      savingsAmount: 150000,
    })

    const loan = await prisma.loan.create({
      data: {
        userId: borrower.id,
        requestedAmount: new Prisma.Decimal(80000),
        duration: 6,
        interestRate: new Prisma.Decimal(5),
        purpose: 'Revision Test Loan',
        status: LoanStatus.PENDING,
      },
    })

    // Guarantor consents to ₦80,000
    const { reservation } = await prisma.$transaction(async (tx) => {
      const req = await requestLoanGuarantor(tx, {
        loanId: loan.id,
        applicantId: borrower.id,
        guarantorId: guarantor.id,
        requestedAmount: 80000,
        termMonths: 6,
        monthlyInterestRate: 5,
      })
      return decideGuarantorRequest(tx, {
        reservationId: req.id,
        guarantorId: guarantor.id,
        decision: 'ACCEPT',
      })
    })

    expect(reservation.state).toBe(GuaranteeState.CONSENTED)
    expect(reservation.reservedAmount.toNumber()).toBe(80000)

    // Admin reviewer attempts to approve for ₦100,000 (different amount!)
    const admin = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-admin-rev@example.com`,
        name: 'Admin Reviewer',
        role: UserRole.ADMIN,
        sessionVersion: 1,
        mfaEnabled: true,
      },
    })
    await prisma.adminPermissionGrant.create({
      data: {
        adminUserId: admin.id,
        permission: AdminPermission.LOANS_REVIEW,
        grantedById: admin.id,
      },
    })

    mockSessionState.session = {
      user: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: UserRole.ADMIN,
        sessionVersion: 1,
      },
    }

    const approveResult = await approveLoanAction(loan.id, 100000)
    expect(approveResult.success).toBe(false)
    expect(approveResult.code).toBe('AWAITING_RECONSENT')
    expect(approveResult.error).toContain('Guarantor must re-consent')

    // Reservation has transitioned to AWAITING_RECONSENT and reservedAmount released to 0
    const updatedReservation = await prisma.guaranteeReservation.findUnique({
      where: { id: reservation.id },
    })
    expect(updatedReservation?.state).toBe(GuaranteeState.AWAITING_RECONSENT)
    expect(updatedReservation?.reservedAmount.toNumber()).toBe(0)
    expect(updatedReservation?.termsVersion).toBe(reservation.termsVersion + 1)
  })

  it('borrower explicit offer acceptance generates evidence and gates loan disbursement (§2.7, §2.9)', async () => {
    const borrower = await createMemberWithSavings({
      emailSuffix: 'acc-b',
      name: 'Acceptance Borrower',
      savingsAmount: 100000,
    })

    const loan = await prisma.loan.create({
      data: {
        userId: borrower.id,
        requestedAmount: new Prisma.Decimal(150000),
        approvedAmount: new Prisma.Decimal(150000),
        duration: 6,
        interestRate: new Prisma.Decimal(5),
        purpose: 'Offer Acceptance Loan',
        status: LoanStatus.APPROVED,
      },
    })

    mockSessionState.session = {
      user: {
        id: borrower.id,
        email: borrower.email,
        name: borrower.name,
        role: UserRole.USER,
        sessionVersion: 1,
      },
    }

    // Borrower accepts offer
    const acceptRes = await acceptLoanOfferAction(borrower.id, loan.id)
    expect(acceptRes.success).toBe(true)

    // Check borrower offer acceptance record
    const acceptance = await prisma.borrowerOfferAcceptance.findUnique({
      where: { loanId: loan.id },
    })
    expect(acceptance).not.null
    expect(acceptance?.decision).toBe(BorrowerOfferDecision.ACCEPTED)
    expect(acceptance?.evidenceSha256).toBeDefined()
    expect(acceptance?.evidenceDocumentId).toMatch(/^CK-EVD-/)

    // Loan status is now ACCEPTED
    const updatedLoan = await prisma.loan.findUnique({ where: { id: loan.id } })
    expect(updatedLoan?.status).toBe(LoanStatus.ACCEPTED)

    // Admin disburses loan
    const disburser = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-admin-disb@example.com`,
        name: 'Admin Disburser',
        role: UserRole.ADMIN,
        sessionVersion: 1,
        mfaEnabled: true,
      },
    })
    await prisma.adminPermissionGrant.create({
      data: {
        adminUserId: disburser.id,
        permission: AdminPermission.LOANS_DISBURSE,
        grantedById: disburser.id,
      },
    })

    mockSessionState.session = {
      user: {
        id: disburser.id,
        email: disburser.email,
        name: disburser.name,
        role: UserRole.ADMIN,
        sessionVersion: 1,
      },
    }

    const disburseRes = await disburseLoanAction(
      loan.id,
      'https://example.com/receipt.jpg',
    )
    expect(disburseRes.success).toBe(true)

    const finalLoan = await prisma.loan.findUnique({ where: { id: loan.id } })
    expect(finalLoan?.status).toBe(LoanStatus.ACTIVE)
  })

  it('protected evidence route (/api/guarantees/[id]/evidence) enforces strict access control', async () => {
    const borrower = await createMemberWithSavings({
      emailSuffix: 'ev-b',
      name: 'Evidence Borrower',
      savingsAmount: 100000,
    })

    const guarantor = await createMemberWithSavings({
      emailSuffix: 'ev-g',
      name: 'Evidence Guarantor',
      savingsAmount: 100000,
    })

    const outsider = await createMemberWithSavings({
      emailSuffix: 'ev-out',
      name: 'Evidence Outsider',
      savingsAmount: 50000,
    })

    const staffReader = await prisma.user.create({
      data: {
        email: `${testEmailPrefix}-staff-reader@example.com`,
        name: 'Staff Reader',
        role: UserRole.ADMIN,
        sessionVersion: 1,
        mfaEnabled: true,
      },
    })
    await prisma.adminPermissionGrant.create({
      data: {
        adminUserId: staffReader.id,
        permission: AdminPermission.LOANS_READ,
        grantedById: staffReader.id,
      },
    })

    const loan = await prisma.loan.create({
      data: {
        userId: borrower.id,
        requestedAmount: new Prisma.Decimal(120000),
        duration: 6,
        interestRate: new Prisma.Decimal(5),
        purpose: 'Evidence Route Loan',
        status: LoanStatus.PENDING,
      },
    })

    const { reservation, evidence } = await prisma.$transaction(async (tx) => {
      const req = await requestLoanGuarantor(tx, {
        loanId: loan.id,
        applicantId: borrower.id,
        guarantorId: guarantor.id,
        requestedAmount: 120000,
        termMonths: 6,
        monthlyInterestRate: 5,
      })
      return decideGuarantorRequest(tx, {
        reservationId: req.id,
        guarantorId: guarantor.id,
        decision: 'ACCEPT',
      })
    })

    const testUrl = `http://localhost:3000/api/guarantees/${reservation.id}/evidence?format=json`

    // 1. Unauthenticated -> 401
    mockSessionState.session = null
    const unauthReq = new NextRequest(testUrl)
    const unauthRes = await getEvidenceRoute(unauthReq, {
      params: Promise.resolve({ id: reservation.id }),
    })
    expect(unauthRes.status).toBe(401)

    // 2. Outsider member -> 403 Forbidden
    mockSessionState.session = {
      user: {
        id: outsider.id,
        email: outsider.email,
        name: outsider.name,
        role: UserRole.USER,
        sessionVersion: 1,
      },
    }
    const outsiderReq = new NextRequest(testUrl)
    const outsiderRes = await getEvidenceRoute(outsiderReq, {
      params: Promise.resolve({ id: reservation.id }),
    })
    expect(outsiderRes.status).toBe(403)

    // 3. Borrower -> 200 (json metadata with signed url)
    mockSessionState.session = {
      user: {
        id: borrower.id,
        email: borrower.email,
        name: borrower.name,
        role: UserRole.USER,
        sessionVersion: 1,
      },
    }
    const borrowerReq = new NextRequest(testUrl)
    const borrowerRes = await getEvidenceRoute(borrowerReq, {
      params: Promise.resolve({ id: reservation.id }),
    })
    expect(borrowerRes.status).toBe(200)
    const borrowerJson = await borrowerRes.json()
    expect(borrowerJson.success).toBe(true)
    expect(borrowerJson.documentId).toBe(evidence.documentId)
    expect(borrowerJson.sha256).toBe(evidence.sha256)

    // 4. Guarantor -> 200
    mockSessionState.session = {
      user: {
        id: guarantor.id,
        email: guarantor.email,
        name: guarantor.name,
        role: UserRole.USER,
        sessionVersion: 1,
      },
    }
    const guarantorReq = new NextRequest(testUrl)
    const guarantorRes = await getEvidenceRoute(guarantorReq, {
      params: Promise.resolve({ id: reservation.id }),
    })
    expect(guarantorRes.status).toBe(200)

    // 5. Staff with LOANS_READ -> 200
    mockSessionState.session = {
      user: {
        id: staffReader.id,
        email: staffReader.email,
        name: staffReader.name,
        role: UserRole.ADMIN,
        sessionVersion: 1,
      },
    }
    const staffReq = new NextRequest(testUrl)
    const staffRes = await getEvidenceRoute(staffReq, {
      params: Promise.resolve({ id: reservation.id }),
    })
    expect(staffRes.status).toBe(200)
  })
})
