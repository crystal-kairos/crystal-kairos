import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { v2 as cloudinary } from 'cloudinary'
import { Prisma } from '@/generated/prisma/client'
import {
  AdminPermission,
  GuaranteeState,
  SavingsFrequency,
  SavingsStatus,
  SavingsType,
  UserRole,
} from '@/generated/prisma/enums'

const mockSession = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string; role: string; sessionVersion: number } },
}))
vi.mock('@/auth', () => ({ auth: vi.fn(async () => mockSession.session) }))

// Product eligibility (profile gate) is covered elsewhere; loans here only need the guarantee flow.
vi.mock('@/lib/services/profile.service', async (orig) => ({
  ...(await orig<typeof import('@/lib/services/profile.service')>()),
  assertProductEligibility: vi.fn(async () => {}),
}))

vi.mock('@/lib/services/rate-policy.service', async (orig) => {
  const actual = await orig<typeof import('@/lib/services/rate-policy.service')>()
  const { Prisma: P } = await import('@/generated/prisma/client')
  const rate = (m: number) => ({
    durationMonths: m,
    monthlyInterestPercent: new P.Decimal(m === 3 ? 4 : 5),
    latePenaltyDailyPercent: new P.Decimal('0.5'),
    penaltyCapType: 'PERCENT_OF_PRINCIPAL' as const,
    penaltyCapValue: new P.Decimal(10),
    version: 7,
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
  })
  return {
    ...actual,
    getActiveLoanRateForDuration: vi.fn(async (m: number) => ([3, 6].includes(m) ? rate(m) : null)),
    getActiveLoanTermRates: vi.fn(async () => [rate(3), rate(6)]),
  }
})

import { prisma } from '@/lib/prisma'
import { getProfileCompletion } from '@/lib/services/profile.service'
import { AuditAction } from '@/lib/services/audit.service'
import {
  applyForLoanAction,
  decideGuarantorRequestAction,
  withdrawGuarantorConsentAction,
} from '@/models/loans/actions'
import { approveLoanAction } from '@/models/admin/loanActions'
import { getMyLoanGuaranteeRequests } from '@/models/loans/query'
import { uploadPassportPhotoAction } from '@/models/members/passport-actions'

const prefix = `fixpg-${Date.now()}`
const createdUserIds: string[] = []
type TestUser = { id: string; email: string; name: string; role: UserRole }

const VALID_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
const VALID_PDF = Buffer.from('%PDF-1.4\n%test\n', 'utf8')

async function createUser(suffix: string, role: UserRole = UserRole.USER, savings = 0): Promise<TestUser> {
  const user = await prisma.user.create({
    data: {
      email: `${prefix}-${suffix}@example.test`,
      name: `Fix ${suffix}`,
      role,
      sessionVersion: 1,
      mfaEnabled: role !== UserRole.USER,
    },
  })
  createdUserIds.push(user.id)
  if (savings > 0) {
    await prisma.savings.create({
      data: {
        userId: user.id,
        savingsType: SavingsType.REGULAR,
        frequency: SavingsFrequency.MONTHLY,
        durationMonths: 12,
        targetAmount: new Prisma.Decimal(savings),
        currentBalance: new Prisma.Decimal(savings),
        totalDeposited: new Prisma.Decimal(savings),
        status: SavingsStatus.ACTIVE,
        ratePercentSnapshot: new Prisma.Decimal(5),
        rateVersionSnapshot: 1,
      },
    })
  }
  if (role === UserRole.USER) {
    await prisma.bankAccount.create({
      data: {
        userId: user.id,
        bankName: 'Test Bank',
        bankCode: '999',
        accountNumber: String(Math.floor(1e9 + Math.random() * 8e9)),
        accountName: user.name,
        isPrimary: true,
        isVerified: true,
      },
    })
  }
  return { id: user.id, email: user.email, name: user.name, role: user.role }
}

async function createAdmin(suffix: string, permissions: AdminPermission[]) {
  const admin = await createUser(suffix, UserRole.ADMIN)
  for (const permission of permissions) {
    await prisma.adminPermissionGrant.create({ data: { adminUserId: admin.id, permission, grantedById: admin.id } })
  }
  return admin
}

function signInAs(user: TestUser | null) {
  mockSession.session = user
    ? { user: { id: user.id, email: user.email, name: user.name, role: user.role, sessionVersion: 1 } }
    : null
}

async function apply(borrower: TestUser, guarantor: TestUser, amount: number, duration = 6) {
  signInAs(borrower)
  const applied = await applyForLoanAction(borrower.id, {
    requestedAmount: amount,
    duration,
    purpose: 'Stock for my shop',
    guarantorEmail: guarantor.email,
  })
  expect(applied.success, applied.error).toBe(true)
  return applied.data!.id as string
}

function fakeCloudinaryUpload() {
  return vi.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation(((
    _opts: unknown,
    cb: (err: unknown, res: { secure_url: string; public_id: string }) => void,
  ) => ({
    end: () =>
      cb(undefined, {
        secure_url: 'https://res.cloudinary.example/authenticated/passport.png',
        public_id: `${prefix}/passport-photos/${Math.random().toString(36).slice(2)}`,
      }),
  })) as never)
}

function photoForm(buffer: Buffer, name: string, type: string) {
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array(buffer)], name, { type }))
  return fd
}

describe('Fixes: loan guarantor consent screen and passport photo upload', { timeout: 30000 }, () => {
  let reviewer: TestUser

  beforeAll(async () => {
    reviewer = await createAdmin('reviewer', [AdminPermission.LOANS_REVIEW, AdminPermission.LOANS_DISBURSE])
  })

  beforeEach(() => signInAs(null))

  afterAll(async () => {
    const ids = createdUserIds
    const loanIds = (await prisma.loan.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((l) => l.id)
    await prisma.borrowerOfferAcceptance.deleteMany({ where: { loanId: { in: loanIds } } })
    await prisma.guaranteeReservation.deleteMany({ where: { OR: [{ applicantId: { in: ids } }, { guarantorId: { in: ids } }] } })
    await prisma.feeAssessment.deleteMany({ where: { memberId: { in: ids } } })
    await prisma.loan.deleteMany({ where: { id: { in: loanIds } } })
    await prisma.storedFile.deleteMany({ where: { OR: [{ uploadedById: { in: ids } }, { ownerUserId: { in: ids } }] } })
    await prisma.savings.deleteMany({ where: { userId: { in: ids } } })
    await prisma.bankAccount.deleteMany({ where: { userId: { in: ids } } })
    await prisma.adminPermissionGrant.deleteMany({ where: { adminUserId: { in: ids } } })
    await prisma.auditEvent.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { affectedUserId: { in: ids } }] } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
  })

  // ---------------------------------------------------------------- loan guarantees

  it('lists a pending loan guarantee request for the guarantor with the full terms (C1 figures)', async () => {
    const borrower = await createUser('b1', UserRole.USER, 100000) // limit ₦200k → ₦100k support needed
    const guarantor = await createUser('g1', UserRole.USER, 200000)
    await apply(borrower, guarantor, 300000)

    signInAs(guarantor)
    const res = await getMyLoanGuaranteeRequests(guarantor.id)
    expect(res.success).toBe(true)
    expect(res.viewerIsGuarantor).toBe(true)
    expect(res.data).toHaveLength(1)
    const row = res.data[0]
    expect(row.state).toBe(GuaranteeState.PENDING)
    expect(row.applicantName).toBe(borrower.name)
    expect(row.quote?.principal).toBe(300000)
    expect(row.quote?.termMonths).toBe(6)
    expect(row.quote?.monthlyInstalment).toBe(65000)
    expect(row.quote?.totalScheduledRepayment).toBe(390000)
    expect(row.quote?.penaltyCapAmount).toBe(30000)
    expect(row.guaranteeAmount).toBe(100000)
  })

  it('nobody else can read a guarantor’s requests', async () => {
    const borrower = await createUser('b2', UserRole.USER, 100000)
    const guarantor = await createUser('g2', UserRole.USER, 200000)
    await apply(borrower, guarantor, 150000)

    signInAs(borrower)
    expect((await getMyLoanGuaranteeRequests(guarantor.id)).success).toBe(false)

    const noPerm = await createAdmin('noperm', [AdminPermission.EAJO_READ])
    signInAs(noPerm)
    expect((await getMyLoanGuaranteeRequests(guarantor.id)).success).toBe(false)

    signInAs(reviewer) // LOANS_REVIEW alone is not LOANS_READ/GUARANTEES_REVIEW
    expect((await getMyLoanGuaranteeRequests(guarantor.id)).success).toBe(false)
  })

  it('accepting from the list moves the request to “Loans you guarantee” with evidence', async () => {
    const borrower = await createUser('b3', UserRole.USER, 100000)
    const guarantor = await createUser('g3', UserRole.USER, 200000)
    await apply(borrower, guarantor, 250000)

    signInAs(guarantor)
    const [pending] = (await getMyLoanGuaranteeRequests(guarantor.id)).data
    const decided = await decideGuarantorRequestAction({ reservationId: pending.id, decision: 'ACCEPT' })
    expect(decided.success, decided.error).toBe(true)

    const [after] = (await getMyLoanGuaranteeRequests(guarantor.id)).data
    expect(after.state).toBe(GuaranteeState.CONSENTED)
    expect(after.guaranteeAmount).toBe(50000) // reserved: 250k − 200k standalone limit
    expect(after.hasEvidence).toBe(true)
    expect(after.consentedAt).not.toBeNull()
  })

  it('a guarantor can withdraw consent before the loan is paid out', async () => {
    const borrower = await createUser('b4', UserRole.USER, 100000)
    const guarantor = await createUser('g4', UserRole.USER, 200000)
    await apply(borrower, guarantor, 220000)

    signInAs(guarantor)
    const [row] = (await getMyLoanGuaranteeRequests(guarantor.id)).data
    expect((await decideGuarantorRequestAction({ reservationId: row.id, decision: 'ACCEPT' })).success).toBe(true)
    const withdrawn = await withdrawGuarantorConsentAction({ reservationId: row.id, reason: 'Changed my mind' })
    expect(withdrawn.success, withdrawn.error).toBe(true)

    const [after] = (await getMyLoanGuaranteeRequests(guarantor.id)).data
    expect(after.state).toBe(GuaranteeState.WITHDRAWN_BEFORE_ACTIVATION)
  })

  it('revised terms from the admin come back to the guarantor as a new decision', async () => {
    const borrower = await createUser('b5', UserRole.USER, 50000) // limit ₦100k
    const guarantor = await createUser('g5', UserRole.USER, 200000)
    const loanId = await apply(borrower, guarantor, 200000)

    signInAs(guarantor)
    const [row] = (await getMyLoanGuaranteeRequests(guarantor.id)).data
    expect((await decideGuarantorRequestAction({ reservationId: row.id, decision: 'ACCEPT' })).success).toBe(true)

    signInAs(reviewer)
    const changed = await approveLoanAction(loanId, 150000, { approvedTermMonths: 3 })
    expect(changed.success, changed.error).toBe(true)

    signInAs(guarantor)
    const [revised] = (await getMyLoanGuaranteeRequests(guarantor.id)).data
    expect(revised.state).toBe(GuaranteeState.AWAITING_RECONSENT)
    expect(revised.isRevisedTerms).toBe(true)
    expect(revised.quote?.principal).toBe(150000)
    expect(revised.quote?.termMonths).toBe(3)
    expect(revised.quote?.monthlyInterestRatePercent).toBe(4)
  })

  // ---------------------------------------------------------------- passport photo

  it('a member uploads a passport photo and the profile counts it as complete', async () => {
    const member = await createUser('photo1')
    fakeCloudinaryUpload()
    signInAs(member)

    const before = await getProfileCompletion(member.id)
    expect(before.sections.passportPhoto.isComplete).toBe(false)

    const res = await uploadPassportPhotoAction(photoForm(VALID_PNG, 'me.png', 'image/png'))
    expect(res.success, res.error).toBe(true)
    expect(res.data?.photoUrl).toMatch(/^\/api\/files\//)

    const user = await prisma.user.findUniqueOrThrow({ where: { id: member.id } })
    expect(user.photoUrl).toBe(res.data?.photoUrl)
    const fileId = user.photoUrl!.split('/').pop()!
    const stored = await prisma.storedFile.findUniqueOrThrow({ where: { id: fileId } })
    expect(stored.purpose).toBe('passport-photos')
    expect(stored.ownerUserId).toBe(member.id)

    const after = await getProfileCompletion(member.id)
    expect(after.sections.passportPhoto.isComplete).toBe(true)

    const audit = await prisma.auditEvent.findFirst({
      where: { action: AuditAction.MEMBER_PASSPORT_PHOTO_SET, affectedUserId: member.id },
    })
    expect(audit).not.toBeNull()

    // Replacing keeps the earlier photo as history
    const again = await uploadPassportPhotoAction(photoForm(VALID_PNG, 'me2.png', 'image/png'))
    expect(again.success).toBe(true)
    expect(await prisma.storedFile.count({ where: { ownerUserId: member.id, purpose: 'passport-photos' } })).toBe(2)
  })

  it('only JPG or PNG photos are accepted', async () => {
    const member = await createUser('photo2')
    fakeCloudinaryUpload()
    signInAs(member)
    const res = await uploadPassportPhotoAction(photoForm(VALID_PDF, 'me.pdf', 'application/pdf'))
    expect(res.success).toBe(false)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: member.id } })).photoUrl).toBeNull()

    const empty = await uploadPassportPhotoAction(new FormData())
    expect(empty.success).toBe(false)
    expect(empty.code).toBe('VALIDATION_ERROR')
  })

  it('staff cannot upload a passport photo (staff are not members)', async () => {
    const admin = await createAdmin('photo-admin', [AdminPermission.MEMBERS_APPROVE])
    fakeCloudinaryUpload()
    signInAs(admin)
    const res = await uploadPassportPhotoAction(photoForm(VALID_PNG, 'me.png', 'image/png'))
    expect(res.success).toBe(false)
    expect(res.code).toBe('FORBIDDEN')
  })
})
