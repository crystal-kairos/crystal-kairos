import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Prisma } from '@/generated/prisma/client'
import {
  AdminPermission,
  AllocationTargetType,
  EAjoDuration,
  EAjoFrequency,
  EAjoMemberStatus,
  EAjoPayoutStatus,
  EAjoStatus,
  GuaranteeState,
  LedgerAccountType,
  PenaltyCapType,
  SavingsFrequency,
  SavingsStatus,
  SavingsType,
  UserRole,
} from '@/generated/prisma/enums'

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }))
// Profile-completion gates are covered by registration-profile-gates.test.ts
vi.mock('@/lib/services/profile.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/profile.service')>()
  return { ...actual, assertProductEligibility: vi.fn(async () => undefined) }
})

import { prisma } from '@/lib/prisma'
import { addDays, addMonthsClamped, lagosToday, toLagosDateString } from '@/lib/domain/dates'
import type { StaffActor } from '@/lib/authz/guards'
import { decideGuarantorRequest } from '@/lib/services/guarantees.service'
import { createPaymentSubmission, confirmPaymentSubmission } from '@/lib/services/payments.service'
import { getWalletBalance } from '@/lib/services/wallet.service'
import {
  accrueEAjoPenaltiesForParticipant,
  activateEAjoGroup,
  approveEAjoParticipant,
  approveEAjoPayout,
  cancelEAjoParticipant,
  getEAjoParticipantLedgerBalance,
  holdEAjoPayout,
  joinEAjoGroup,
  recordEAjoPayoutPaid,
  rejectEAjoParticipant,
  releaseEAjoPayoutHold,
} from '@/lib/services/eajo.service'
import { runPayoutEligibilityJob } from '@/lib/jobs/payout-eligibility.job'
import { runEAjoPenaltyJob } from '@/lib/jobs/eajo-penalties.job'
import { disbursePayment } from '@/lib/services/disbursement.service'

const OWNER_ID = '00000000-0000-4000-8000-000000000001'
const ts = Date.now()
const prefix = `test-p305-${ts}`
const day = (d: Date) => toLagosDateString(d)

describe('E-ajo slots, payouts, cancellation and penalties (PR P3-05, §2.8, §2.3, C4)', () => {
  const ownerActor = { id: OWNER_ID, role: UserRole.OWNER }
  let admin: StaffActor
  let ownerStaff: StaffActor
  const users: Record<string, string> = {}
  let groupId: string
  let tightGroupId: string
  const participant: Record<string, string> = {}
  const today = lagosToday()

  async function createMember(key: string, savings: number) {
    const u = await prisma.user.create({
      data: { email: `${prefix}-${key}@example.com`, name: `P305 ${key}`, role: UserRole.USER, isActive: true },
    })
    users[key] = u.id
    if (savings > 0) {
      await prisma.savings.create({
        data: {
          userId: u.id,
          savingsType: SavingsType.REGULAR,
          frequency: SavingsFrequency.MONTHLY,
          durationMonths: 12,
          targetAmount: savings,
          currentBalance: savings,
          totalDeposited: savings,
          status: SavingsStatus.ACTIVE,
          ratePercentSnapshot: 5,
          rateVersionSnapshot: 1,
        },
      })
    }
    await prisma.bankAccount.create({
      data: {
        userId: u.id,
        bankCode: '058',
        bankName: 'GTBank',
        accountNumber: String(ts).slice(-6) + String(Object.keys(users).length).padStart(4, '0'),
        accountName: `P305 ${key}`,
        isPrimary: true,
        isVerified: true,
        verifiedAt: new Date(),
      },
    })
    return u.id
  }

  async function createGroup(title: string, maxMembersPerSlot: number | null) {
    const g = await prisma.eAjoGroup.create({
      data: {
        title: `${prefix} ${title}`,
        contributionAmount: 10000,
        frequency: EAjoFrequency.MONTHLY,
        duration: EAjoDuration.TWELVE_MONTHS,
        durationMonths: 12,
        totalSlots: 12,
        status: EAjoStatus.PENDING,
        createdBy: OWNER_ID,
        latePenaltyDailyPercent: 1, // ₦100 per day on a ₦10,000 contribution
        penaltyCapType: PenaltyCapType.FIXED_AMOUNT,
        penaltyCapValue: 250,
        maxMembersPerSlot,
      },
    })
    const pct = (s: number) => (s === 1 ? 15 : s === 2 ? 10 : s === 12 ? 0 : 5)
    await prisma.eAjoSlotPolicy.createMany({
      data: Array.from({ length: 12 }, (_, i) => ({
        groupId: g.id,
        slotNumber: i + 1,
        earlySlotPenaltyPercent: pct(i + 1),
        createdById: OWNER_ID,
      })),
    })
    return g.id
  }

  async function join(key: string, gId: string, slot: number, guarantorKey: string) {
    return prisma.$transaction((tx) =>
      joinEAjoGroup(tx, {
        memberId: users[key],
        groupId: gId,
        slotNumber: slot,
        guarantorId: users[guarantorKey],
        actor: { id: users[key], role: UserRole.USER },
      }),
    )
  }

  async function consent(eajoMemberId: string) {
    const r = await prisma.guaranteeReservation.findFirstOrThrow({ where: { eajoMemberId } })
    await prisma.$transaction((tx) =>
      decideGuarantorRequest(tx, { reservationId: r.id, guarantorId: r.guarantorId, decision: 'ACCEPT' }),
    )
  }

  async function pay(key: string, eajoMemberId: string, periodNumbers: number[]) {
    const periods = await prisma.eAjoContributionPeriod.findMany({
      where: { eajoMemberId, periodNumber: { in: periodNumbers } },
    })
    const { submission } = await createPaymentSubmission({
      memberId: users[key],
      claimedAmount: periods.length * 10000,
      paidOn: today,
      targets: periods.map((p) => ({
        targetType: AllocationTargetType.EAJO,
        targetId: eajoMemberId,
        targetPeriodId: p.id,
        requestedAmount: 10000,
      })),
    })
    return confirmPaymentSubmission({ submissionId: submission.id, confirmedById: OWNER_ID })
  }

  beforeAll(async () => {
    const adminUser = await prisma.user.create({
      data: { email: `${prefix}-admin@example.com`, name: 'P305 Admin', role: UserRole.ADMIN, isActive: true },
    })
    users.admin = adminUser.id
    await prisma.adminPermissionGrant.create({
      data: { adminUserId: adminUser.id, permission: AdminPermission.EAJO_PAYOUTS_MANAGE, grantedById: OWNER_ID },
    })
    admin = {
      id: adminUser.id,
      email: adminUser.email,
      name: adminUser.name,
      role: UserRole.ADMIN,
      sessionVersion: 1,
      permissions: [AdminPermission.EAJO_PAYOUTS_MANAGE],
    } as StaffActor
    ownerStaff = {
      id: OWNER_ID,
      email: 'owner@example.test',
      name: 'Owner',
      role: UserRole.OWNER,
      sessionVersion: 1,
      permissions: [],
    } as unknown as StaffActor

    for (const k of ['a', 'b', 'c', 'd', 'late']) await createMember(k, 0)
    await createMember('guarantor', 1_000_000)
    groupId = await createGroup('Main', 2)
    tightGroupId = await createGroup('Tight', 1)
    for (const k of ['t1', 't2', 't3']) await createMember(k, 0)
  })

  afterAll(async () => {
    const ids = Object.values(users)
    const members = await prisma.eAjoMember.findMany({
      where: { groupId: { in: [groupId, tightGroupId] } },
      select: { id: true },
    })
    const memberIds = members.map((m) => m.id)
    const periods = await prisma.eAjoContributionPeriod.findMany({
      where: { eajoMemberId: { in: memberIds } },
      select: { id: true },
    })
    const payments = await prisma.payment.findMany({ where: { memberId: { in: ids } }, select: { id: true } })
    const entries = await prisma.journalEntry.findMany({
      where: {
        OR: [
          { sourceId: { in: [...memberIds, ...periods.map((p) => p.id), ...payments.map((p) => p.id)] } },
          { lines: { some: { memberId: { in: ids } } } },
        ],
      },
      select: { id: true },
    })
    const entryIds = entries.map((e) => e.id)
    await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: payments.map((p) => p.id) } } })
    await prisma.eAjoPayout.deleteMany({ where: { eajoMemberId: { in: memberIds } } })
    await prisma.disbursement.deleteMany({ where: { recipientUserId: { in: ids } } })
    await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entryIds } } })
    await prisma.journalEntry.deleteMany({ where: { reversalOfId: { in: entryIds } } })
    await prisma.journalEntry.deleteMany({ where: { id: { in: entryIds } } })
    await prisma.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } })
    await prisma.paymentSubmission.deleteMany({ where: { memberId: { in: ids } } })
    await prisma.eAjoPenaltyAccrual.deleteMany({ where: { eajoContributionPeriodId: { in: periods.map((p) => p.id) } } })
    await prisma.eAjoContributionPeriod.deleteMany({ where: { eajoMemberId: { in: memberIds } } })
    await prisma.guaranteeReservation.deleteMany({ where: { eajoMemberId: { in: memberIds } } })
    await prisma.eAjoMember.deleteMany({ where: { id: { in: memberIds } } })
    await prisma.eAjoSlotPolicy.deleteMany({ where: { groupId: { in: [groupId, tightGroupId] } } })
    await prisma.eAjoGroup.deleteMany({ where: { id: { in: [groupId, tightGroupId] } } })
    await prisma.storedFile.deleteMany({ where: { uploadedById: { in: ids } } })
    await prisma.bankAccount.deleteMany({ where: { userId: { in: ids } } })
    await prisma.savings.deleteMany({ where: { userId: { in: ids } } })
    await prisma.adminPermissionGrant.deleteMany({ where: { adminUserId: { in: ids } } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } })
  })

  it('enforces maxMembersPerSlot under concurrent joins', async () => {
    const results = await Promise.allSettled(['t1', 't2', 't3'].map((k) => join(k, tightGroupId, 3, 'guarantor')))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(rejected.every((r) => r.reason?.code === 'SLOT_FULL')).toBe(true)
  })

  it('lets several members share a slot, rejects a second application and a full slot', async () => {
    const a = await join('a', groupId, 2, 'guarantor')
    const b = await join('b', groupId, 2, 'guarantor')
    participant.a = a.participant.id
    participant.b = b.participant.id
    // Reservation is the advance c × (N − s) = 100,000 for slot 2
    expect(a.reservation.requestedAmount.toFixed(2)).toBe('100000.00')
    expect(a.preview.netPayout.toFixed(2)).toBe('110000.00')

    await expect(join('c', groupId, 2, 'guarantor')).rejects.toMatchObject({ code: 'SLOT_FULL' })
    await expect(join('a', groupId, 5, 'guarantor')).rejects.toMatchObject({ code: 'ALREADY_JOINED' })

    const c = await join('c', groupId, 12, 'guarantor')
    participant.c = c.participant.id
    // Last slot: zero advance, the guarantor still consents
    expect(c.reservation.requestedAmount.toFixed(2)).toBe('0.00')
    const d = await join('d', groupId, 6, 'guarantor')
    participant.d = d.participant.id
  })

  it('requires guarantor consent before approval', async () => {
    await expect(
      prisma.$transaction((tx) => approveEAjoParticipant(tx, { eajoMemberId: participant.a, actor: ownerActor })),
    ).rejects.toMatchObject({ code: 'GUARANTOR_CONSENT_REQUIRED' })

    for (const k of ['a', 'b', 'c']) {
      await consent(participant[k])
      const approved = await prisma.$transaction((tx) =>
        approveEAjoParticipant(tx, { eajoMemberId: participant[k], actor: ownerActor }),
      )
      expect(approved.status).toBe(EAjoMemberStatus.APPROVED)
    }
    const res = await prisma.guaranteeReservation.findFirstOrThrow({ where: { eajoMemberId: participant.a } })
    expect(res.state).toBe(GuaranteeState.CONSENTED)
    expect(res.reservedAmount.toFixed(2)).toBe('100000.00')
  })

  it('activates the group: snapshots terms, creates periods and payouts, locks the roster', async () => {
    const group = await prisma.$transaction((tx) => activateEAjoGroup(tx, { groupId, actor: ownerActor, startDate: today }))
    expect(group.status).toBe(EAjoStatus.ACTIVE)

    // d never got consent/approval: rejected at activation, reservation released
    const d = await prisma.eAjoMember.findUniqueOrThrow({ where: { id: participant.d } })
    expect(d.status).toBe(EAjoMemberStatus.REJECTED)
    const dRes = await prisma.guaranteeReservation.findFirstOrThrow({ where: { eajoMemberId: participant.d } })
    expect(dRes.state).toBe(GuaranteeState.RELEASED)

    const periods = await prisma.eAjoContributionPeriod.findMany({
      where: { eajoMemberId: participant.a },
      orderBy: { periodNumber: 'asc' },
    })
    expect(periods).toHaveLength(12)
    expect(day(periods[1].dueDate)).toBe(day(addMonthsClamped(today, 1)))

    const payoutA = await prisma.eAjoPayout.findUniqueOrThrow({ where: { eajoMemberId: participant.a } })
    expect(payoutA.advanceAmount.toFixed(2)).toBe('100000.00')
    expect(payoutA.earlySlotPenalty.toFixed(2)).toBe('10000.00')
    expect(payoutA.netPayout.toFixed(2)).toBe('110000.00')
    expect(payoutA.status).toBe(EAjoPayoutStatus.NOT_ELIGIBLE)
    const payoutC = await prisma.eAjoPayout.findUniqueOrThrow({ where: { eajoMemberId: participant.c } })
    expect(payoutC.netPayout.toFixed(2)).toBe('120000.00')

    await expect(join('late', groupId, 4, 'guarantor')).rejects.toMatchObject({ code: 'GROUP_NOT_OPEN' })
    await expect(
      prisma.$transaction((tx) => approveEAjoParticipant(tx, { eajoMemberId: participant.d, actor: ownerActor })),
    ).rejects.toMatchObject({ code: 'ROSTER_LOCKED' })
  })

  it('makes a payout eligible only when month s is reached and settled, independent of others', async () => {
    await pay('a', participant.a, [1, 2])
    await pay('b', participant.b, [1]) // b is behind
    await pay('c', participant.c, [1, 2])

    // Before the payout month: nobody eligible
    let payoutA = await prisma.eAjoPayout.findUniqueOrThrow({ where: { eajoMemberId: participant.a } })
    expect(payoutA.status).toBe(EAjoPayoutStatus.NOT_ELIGIBLE)
    // Contributions before payout sit in the contribution liability
    expect(
      (await getEAjoParticipantLedgerBalance(prisma, participant.a, LedgerAccountType.EAJO_CONTRIBUTION_LIABILITY)).toFixed(2),
    ).toBe('20000.00')

    const month2 = day(addMonthsClamped(today, 1))
    const job = await runPayoutEligibilityJob({ today: month2, groupId })
    expect(job.becameEligible).toBe(1)

    payoutA = await prisma.eAjoPayout.findUniqueOrThrow({ where: { eajoMemberId: participant.a } })
    expect(payoutA.status).toBe(EAjoPayoutStatus.ELIGIBLE)
    const payoutB = await prisma.eAjoPayout.findUniqueOrThrow({ where: { eajoMemberId: participant.b } })
    expect(payoutB.status).toBe(EAjoPayoutStatus.NOT_ELIGIBLE)

    // Re-running is idempotent
    const again = await runPayoutEligibilityJob({ today: month2, groupId })
    expect(again.becameEligible + again.becameNotEligible).toBe(0)
  })

  it('holds and releases a payout', async () => {
    const payoutA = await prisma.eAjoPayout.findUniqueOrThrow({ where: { eajoMemberId: participant.a } })
    await prisma.$transaction((tx) => holdEAjoPayout(tx, { payoutId: payoutA.id, actor: ownerActor, reason: 'KYC check' }))
    expect((await prisma.eAjoPayout.findUniqueOrThrow({ where: { id: payoutA.id } })).status).toBe(EAjoPayoutStatus.HELD)
    await prisma.$transaction((tx) =>
      releaseEAjoPayoutHold(tx, { payoutId: payoutA.id, actor: ownerActor, today: day(addMonthsClamped(today, 1)) }),
    )
    expect((await prisma.eAjoPayout.findUniqueOrThrow({ where: { id: payoutA.id } })).status).toBe(EAjoPayoutStatus.ELIGIBLE)
  })

  it('pays out under dual control with the C4 journal; later contributions clear the advance', async () => {
    const month2 = day(addMonthsClamped(today, 1))
    const payoutA = await prisma.eAjoPayout.findUniqueOrThrow({ where: { eajoMemberId: participant.a } })
    const approved = await prisma.$transaction((tx) =>
      approveEAjoPayout(tx, { payoutId: payoutA.id, actor: ownerActor, today: month2 }),
    )
    expect(approved.disbursement.amount.toFixed(2)).toBe('110000.00')

    // The generic disbursement flow refuses e-ajo payouts
    await expect(
      disbursePayment({
        disbursementId: approved.disbursement.id,
        disbursedById: OWNER_ID,
        bankReference: 'X',
        valueDate: month2,
      }),
    ).rejects.toMatchObject({ code: 'USE_EAJO_PAYOUT_FLOW' })

    const evidenceOwner = await prisma.storedFile.create({
      data: {
        publicId: `${prefix}-ev-owner`,
        secureUrl: 'https://example.test/ev.png',
        purpose: 'receipts',
        format: 'png',
        contentType: 'image/png',
        sizeBytes: 10,
        uploadedById: OWNER_ID,
      },
    })
    // Same person who approved cannot record payment while a second eligible staff exists (A-19)
    await expect(
      prisma.$transaction((tx) =>
        recordEAjoPayoutPaid(tx, {
          payoutId: payoutA.id,
          actor: ownerStaff,
          valueDate: month2,
          bankReference: 'TRF-1',
          evidenceFileId: evidenceOwner.id,
          today: month2,
        }),
      ),
    ).rejects.toMatchObject({ code: 'DUAL_CONTROL_REQUIRED' })
    await prisma.storedFile.delete({ where: { id: evidenceOwner.id } })

    const evidence = await prisma.storedFile.create({
      data: {
        publicId: `${prefix}-ev`,
        secureUrl: 'https://example.test/ev.png',
        purpose: 'receipts',
        format: 'png',
        contentType: 'image/png',
        sizeBytes: 10,
        uploadedById: admin.id,
      },
    })
    const paid = await prisma.$transaction((tx) =>
      recordEAjoPayoutPaid(tx, {
        payoutId: payoutA.id,
        actor: admin,
        valueDate: month2,
        bankReference: 'TRF-1',
        evidenceFileId: evidence.id,
        today: month2,
      }),
    )
    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: paid.journalEntryId! } })
    const amount = (t: LedgerAccountType, side: 'debit' | 'credit') =>
      lines.filter((l) => l.accountType === t).reduce((s, l) => s.plus(l[side]), new Prisma.Decimal(0)).toFixed(2)
    expect(amount(LedgerAccountType.EAJO_CONTRIBUTION_LIABILITY, 'debit')).toBe('20000.00')
    expect(amount(LedgerAccountType.EAJO_ADVANCE_RECEIVABLE, 'debit')).toBe('100000.00')
    expect(amount(LedgerAccountType.COOPERATIVE_CASH, 'credit')).toBe('110000.00')
    expect(amount(LedgerAccountType.EAJO_EARLY_SLOT_INCOME, 'credit')).toBe('10000.00')

    // Replay is idempotent
    const replay = await prisma.$transaction((tx) =>
      recordEAjoPayoutPaid(tx, {
        payoutId: payoutA.id,
        actor: admin,
        valueDate: month2,
        bankReference: 'TRF-1',
        evidenceFileId: evidence.id,
        today: month2,
      }),
    )
    expect(replay.isReplay).toBe(true)

    // After payout: reservation = remaining unpaid contributions (10 × 10,000)
    let res = await prisma.guaranteeReservation.findFirstOrThrow({ where: { eajoMemberId: participant.a } })
    expect(res.reservedAmount.toFixed(2)).toBe('100000.00')

    await pay('a', participant.a, [3])
    expect(
      (await getEAjoParticipantLedgerBalance(prisma, participant.a, LedgerAccountType.EAJO_ADVANCE_RECEIVABLE)).toFixed(2),
    ).toBe('-90000.00') // asset: 100,000 debit − 10,000 credit
    res = await prisma.guaranteeReservation.findFirstOrThrow({ where: { eajoMemberId: participant.a } })
    expect(res.reservedAmount.toFixed(2)).toBe('90000.00')

    // Cancellation after payout is refused
    await expect(
      prisma.$transaction((tx) => cancelEAjoParticipant(tx, { eajoMemberId: participant.a, actor: ownerActor, reason: 'x' })),
    ).rejects.toMatchObject({ code: 'CANCELLATION_NOT_ALLOWED' })
  })

  it('cancelling before payout returns confirmed contributions to the wallet without a penalty', async () => {
    const before = await getWalletBalance(users.b)
    const out = await prisma.$transaction((tx) =>
      cancelEAjoParticipant(tx, { eajoMemberId: participant.b, actor: ownerActor, reason: 'Member request' }),
    )
    expect(out.refundedToWallet.toFixed(2)).toBe('10000.00')
    expect((await getWalletBalance(users.b)).minus(before).toFixed(2)).toBe('10000.00')
    const payoutB = await prisma.eAjoPayout.findUniqueOrThrow({ where: { eajoMemberId: participant.b } })
    expect(payoutB.status).toBe(EAjoPayoutStatus.CANCELLED)
    const res = await prisma.guaranteeReservation.findFirstOrThrow({ where: { eajoMemberId: participant.b } })
    expect(res.state).toBe(GuaranteeState.RELEASED)
    expect(res.reservedAmount.toFixed(2)).toBe('0.00')
  })

  it('accrues late penalties after grace, stops at the cap, never duplicates; fees can be deducted on cancellation', async () => {
    const p3 = await prisma.eAjoContributionPeriod.findFirstOrThrow({
      where: { eajoMemberId: participant.c, periodNumber: 3 },
    })
    const through = day(addDays(p3.dueDate, 10)) // days +8, +9, +10
    const first = await prisma.$transaction((tx) =>
      accrueEAjoPenaltiesForParticipant(tx, { eajoMemberId: participant.c, throughDate: through, today: through }),
    )
    // ₦100/day, fixed cap ₦250 → 100 + 100 + 50
    expect(first.accrued).toBe(3)
    expect(first.total.toFixed(2)).toBe('250.00')

    const accruals = await prisma.eAjoPenaltyAccrual.findMany({
      where: { eajoContributionPeriodId: p3.id },
      orderBy: { penaltyDate: 'asc' },
    })
    expect(accruals.map((a) => day(a.penaltyDate))).toEqual([
      day(addDays(p3.dueDate, 8)),
      day(addDays(p3.dueDate, 9)),
      day(addDays(p3.dueDate, 10)),
    ])
    expect(accruals.map((a) => a.amount.toFixed(2))).toEqual(['100.00', '100.00', '50.00'])

    // Re-running (also through the job) adds nothing: cap reached, rows unique
    const job = await runEAjoPenaltyJob({ groupId, throughDate: day(addDays(p3.dueDate, 20)), today: through })
    expect(job.accruals).toBe(0)

    // Unpaid late fees block cancellation (OQ-18)…
    await expect(
      prisma.$transaction((tx) => cancelEAjoParticipant(tx, { eajoMemberId: participant.c, actor: ownerActor, reason: 'x' })),
    ).rejects.toMatchObject({ code: 'PENALTIES_OUTSTANDING' })

    // …unless the admin deducts them from the contributions: 20,000 held − 250 fees = 19,750 refunded
    const walletBefore = await getWalletBalance(users.c)
    const out = await prisma.$transaction((tx) =>
      cancelEAjoParticipant(tx, {
        eajoMemberId: participant.c,
        actor: ownerActor,
        reason: 'Member leaving',
        deductPenalties: true,
      }),
    )
    expect(out.penaltiesDeducted.toFixed(2)).toBe('250.00')
    expect(out.refundedToWallet.toFixed(2)).toBe('19750.00')
    expect((await getWalletBalance(users.c)).minus(walletBefore).toFixed(2)).toBe('19750.00')
    const p3After = await prisma.eAjoContributionPeriod.findUniqueOrThrow({ where: { id: p3.id } })
    expect(p3After.penaltyPaid.toFixed(2)).toBe('250.00')
    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: out.journalEntryId! } })
    const credit = (t: LedgerAccountType) =>
      lines.filter((l) => l.accountType === t).reduce((acc, l) => acc.plus(l.credit), new Prisma.Decimal(0)).toFixed(2)
    expect(credit(LedgerAccountType.EAJO_PENALTY_RECEIVABLE)).toBe('250.00')
    expect(credit(LedgerAccountType.MEMBER_WALLET_LIABILITY)).toBe('19750.00')
    expect(
      (await getEAjoParticipantLedgerBalance(prisma, participant.c, LedgerAccountType.EAJO_CONTRIBUTION_LIABILITY)).toFixed(2),
    ).toBe('0.00')
    expect((await prisma.eAjoMember.findUniqueOrThrow({ where: { id: participant.c } })).status).toBe(
      EAjoMemberStatus.CANCELLED,
    )
  })

  it('rejects a pending application with a reason', async () => {
    await expect(
      prisma.$transaction((tx) => rejectEAjoParticipant(tx, { eajoMemberId: participant.d, actor: ownerActor, reason: '' })),
    ).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
  })
})
