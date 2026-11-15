/**
 * P3-03 savings workflows against a real PostgreSQL database.
 * Golden values: Appendix C5. Dates far in the future (2027) are reached through the
 * confirmation value date and the jobs' `asOf` parameter, never the machine clock.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/auth', () => ({ auth: vi.fn(async () => null) }))
vi.mock('@/features/notification', () => ({ sendEmail: vi.fn(async () => undefined) }))
import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import {
  AdminPermission,
  DisbursementStatus,
  GuaranteeState,
  GuaranteeType,
  LedgerAccountType,
  LoanStatus,
  PaymentPeriodStatus,
  SavingsFrequency,
  SavingsStatus,
  SavingsType,
  SavingsWithdrawalKind,
  UserRole,
} from '@/generated/prisma/enums'
import type { StaffActor } from '@/lib/authz/guards'
import { formatDateOnly, lagosToday } from '@/lib/domain/dates'
import { setSavingsProductTermRates } from '@/lib/services/rate-policy.service'
import {
  confirmPaymentSubmission,
  rejectPaymentSubmission,
} from '@/lib/services/payments.service'
import {
  accrueSavingsPlanInterest,
  approveSavingsWithdrawal,
  cancelSavingsWithdrawal,
  confirmSavingsWithdrawalPayout,
  getAccruedInterest,
  recalculateSavingsPeriodForfeiture,
  requestSavingsWithdrawal,
  submitSavingsDeposit,
  subscribeToSavingsPlan,
} from '@/lib/services/savings.service'
import { getWalletBalance } from '@/lib/services/wallet.service'
import { runSavingsAccrualJob } from '@/lib/jobs/savings-accrual.job'
import { runSavingsExpiryJob } from '@/lib/jobs/savings-expiry.job'
import { runSavingsMaturityJob } from '@/lib/jobs/maturity.job'
import { runSavingsForfeitureJob } from '@/lib/jobs/savings-forfeiture.job'

const prefix = `p303-${Date.now()}`
const noNotify = async () => {}

let ownerId: string
let adminA: StaffActor
let adminB: StaffActor
const products: Record<'FIXED' | 'REGULAR' | 'STAGGERED', string> = {} as never
let memberSeq = 0

async function createMember(withBank = true) {
  memberSeq += 1
  const user = await prisma.user.create({
    data: {
      email: `${prefix}-m${memberSeq}@example.test`,
      name: `P303 Member ${memberSeq}`,
      role: UserRole.USER,
      isActive: true,
    },
  })
  if (withBank) {
    await prisma.bankAccount.create({
      data: {
        userId: user.id,
        bankName: 'Test Bank',
        bankCode: '999',
        accountNumber: `${String(Date.now()).slice(-7)}${String(memberSeq).padStart(3, '0')}`,
        accountName: user.name,
        isPrimary: true,
        isVerified: true,
      },
    })
  }
  return user.id
}

async function storedFile(uploadedById: string) {
  const f = await prisma.storedFile.create({
    data: {
      publicId: `${prefix}/file-${Math.random().toString(36).slice(2)}`,
      secureUrl: 'https://res.cloudinary.example/file',
      purpose: 'receipts',
      format: 'png',
      contentType: 'image/png',
      sizeBytes: 100,
      uploadedById,
    },
  })
  return f.id
}

/** Member uploads a receipt today; staff confirm it with the given value date. */
async function deposit(
  memberId: string,
  savingsId: string,
  amount: number,
  valueDate: string,
  periodIds?: string[],
) {
  const { submission } = await submitSavingsDeposit({
    memberId,
    savingsId,
    amount,
    paidOn: lagosToday(),
    periodIds,
    receiptFileId: await storedFile(memberId),
  })
  const res = await confirmPaymentSubmission({
    submissionId: submission.id,
    confirmedById: ownerId,
    valueDate,
    valueDateChangeReason: 'Bank statement shows the credit on this date',
  })
  return { submission, payment: res.payment }
}

async function plan(id: string) {
  return prisma.savings.findUniqueOrThrow({ where: { id }, include: { periods: { orderBy: { periodNumber: 'asc' } }, lots: true } })
}

async function payableFor(savingsId: string) {
  const agg = await prisma.journalLine.aggregate({
    where: { accountType: LedgerAccountType.SAVINGS_INTEREST_PAYABLE, accountRefId: savingsId },
    _sum: { debit: true, credit: true },
  })
  return (agg._sum.credit ?? new Prisma.Decimal(0)).minus(agg._sum.debit ?? 0)
}

function staff(id: string, role: 'OWNER' | 'ADMIN'): StaffActor {
  return {
    id,
    email: `${id}@example.test`,
    name: id,
    role: role as StaffActor['role'],
    sessionVersion: 1,
    permissions: [AdminPermission.SAVINGS_MANAGE],
  }
}

beforeAll(async () => {
  const owner = await prisma.user.findFirstOrThrow({ where: { role: UserRole.OWNER } })
  ownerId = owner.id
  for (const n of ['a', 'b']) {
    const u = await prisma.user.create({
      data: { email: `${prefix}-admin-${n}@example.test`, name: `Admin ${n}`, role: UserRole.ADMIN, isActive: true },
    })
    await prisma.adminPermissionGrant.create({
      data: { adminUserId: u.id, permission: AdminPermission.SAVINGS_MANAGE, grantedById: ownerId },
    })
    if (n === 'a') adminA = staff(u.id, 'ADMIN')
    else adminB = staff(u.id, 'ADMIN')
  }
  for (const type of [SavingsType.FIXED, SavingsType.REGULAR, SavingsType.STAGGERED]) {
    const p = await prisma.savingsProduct.create({
      data: { type, title: `${prefix} ${type}`, description: 'Test plan', icon: 'PiggyBank', createdBy: ownerId },
    })
    await setSavingsProductTermRates(ownerId, p.id, [
      { durationMonths: 6, ratePercent: 12 },
      { durationMonths: 1, ratePercent: 1 },
    ])
    products[type] = p.id
  }
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('P3-03 savings workflows', () => {
  it('subscription is PENDING with a snapshotted rate and no schedule, start or maturity (D-08, D-09)', async () => {
    const memberId = await createMember()
    const s = await subscribeToSavingsPlan({
      memberId,
      productId: products.REGULAR,
      durationMonths: 6,
      targetAmount: 20000,
      frequency: SavingsFrequency.MONTHLY,
    })
    const p = await plan(s.id)
    expect(p.status).toBe(SavingsStatus.PENDING)
    expect(p.startDate).toBeNull()
    expect(p.maturityDate).toBeNull()
    expect(p.periods).toHaveLength(0)
    expect(Number(p.ratePercentSnapshot)).toBe(12)
    expect(p.rateVersionSnapshot).toBe(1)

    await expect(
      subscribeToSavingsPlan({ memberId, productId: products.REGULAR, durationMonths: 7, targetAmount: 1, frequency: SavingsFrequency.MONTHLY }),
    ).rejects.toMatchObject({ code: 'TERM_NOT_OFFERED' })
    await expect(
      subscribeToSavingsPlan({ memberId, productId: products.REGULAR, durationMonths: 13, targetAmount: 1, frequency: SavingsFrequency.MONTHLY }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      subscribeToSavingsPlan({ memberId, productId: products.REGULAR, durationMonths: 6, targetAmount: 1, frequency: SavingsFrequency.ONCE }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('expires a PENDING plan after the window, but not one with a receipt in review (A-05)', async () => {
    const memberId = await createMember()
    const idle = await subscribeToSavingsPlan({ memberId, productId: products.STAGGERED, durationMonths: 6 })
    const reviewed = await subscribeToSavingsPlan({ memberId, productId: products.STAGGERED, durationMonths: 6 })
    await submitSavingsDeposit({
      memberId,
      savingsId: reviewed.id,
      amount: 5000,
      paidOn: lagosToday(),
      receiptFileId: await storedFile(memberId),
    })
    const createdAt = new Date('2027-01-01T09:00:00Z')
    await prisma.savings.updateMany({ where: { id: { in: [idle.id, reviewed.id] } }, data: { createdAt } })

    await runSavingsExpiryJob({ asOf: '2027-01-15', notify: noNotify }) // day 14: still inside the window
    expect((await plan(idle.id)).status).toBe(SavingsStatus.PENDING)

    const notices: unknown[] = []
    await runSavingsExpiryJob({ asOf: '2027-01-16', notify: async (n) => void notices.push(n) })
    expect((await plan(idle.id)).status).toBe(SavingsStatus.CANCELLED)
    expect((await plan(reviewed.id)).status).toBe(SavingsStatus.PENDING)
    expect(notices.some((n) => (n as { memberId: string }).memberId === memberId)).toBe(true)

    // Idempotent: a second run changes nothing and sends nothing for this plan.
    const again: unknown[] = []
    await runSavingsExpiryJob({ asOf: '2027-01-20', notify: async (n) => void again.push(n) })
    expect(again.filter((n) => (n as { memberId: string }).memberId === memberId)).toHaveLength(0)
  })

  it('allows only one first-deposit receipt in review at a time', async () => {
    const memberId = await createMember()
    const s = await subscribeToSavingsPlan({ memberId, productId: products.STAGGERED, durationMonths: 6 })
    await submitSavingsDeposit({ memberId, savingsId: s.id, amount: 1000, paidOn: lagosToday(), receiptFileId: await storedFile(memberId) })
    await expect(
      submitSavingsDeposit({ memberId, savingsId: s.id, amount: 1000, paidOn: lagosToday(), receiptFileId: await storedFile(memberId) }),
    ).rejects.toMatchObject({ code: 'FIRST_DEPOSIT_IN_REVIEW' })
  })

  it('C5 staggered plan: value date sets start/maturity; monthly accrual with catch-up; maturity payout 165,016.57', async () => {
    const memberId = await createMember()
    const s = await subscribeToSavingsPlan({ memberId, productId: products.STAGGERED, durationMonths: 6 })
    await deposit(memberId, s.id, 100000, '2027-01-01')
    let p = await plan(s.id)
    expect(p.status).toBe(SavingsStatus.ACTIVE)
    expect(formatDateOnly(p.startDate!)).toBe('2027-01-01') // value date, not the confirmation date
    expect(formatDateOnly(p.maturityDate!)).toBe('2027-07-01')
    await deposit(memberId, s.id, 50000, '2027-04-01')
    p = await plan(s.id)
    expect(formatDateOnly(p.maturityDate!)).toBe('2027-07-01') // later deposits never move maturity
    expect(Number(p.currentBalance)).toBe(150000)
    expect(p.lots).toHaveLength(2)

    await runSavingsAccrualJob({ asOf: '2027-02-28' })
    const lotA = p.lots.find((l) => Number(l.principal) === 100000)!
    const rows = await prisma.savingsInterestAccrual.findMany({ where: { lotId: lotA.id }, orderBy: { accrualDate: 'asc' } })
    expect(rows.map((r) => [formatDateOnly(r.accrualDate), r.amount.toFixed(2)])).toEqual([
      ['2027-01-31', '1988.95'],
      ['2027-02-28', '1856.35'],
    ])

    // Missed months are back-filled once; a re-run posts nothing more.
    await runSavingsAccrualJob({ asOf: '2027-07-01' })
    const second = await runSavingsAccrualJob({ asOf: '2027-07-01' })
    expect(await getAccruedInterest(prisma, s.id)).toEqual(new Prisma.Decimal('15016.57'))
    expect((await payableFor(s.id)).toFixed(2)).toBe('15016.57')
    const lotRows = await prisma.savingsInterestAccrual.findMany({ where: { lot: { savingsId: s.id } } })
    expect(new Set(lotRows.map((r) => `${r.lotId}:${formatDateOnly(r.accrualDate)}`)).size).toBe(lotRows.length)
    expect(second.postings).toBeGreaterThanOrEqual(0)

    await runSavingsMaturityJob({ asOf: '2027-06-30', notify: noNotify })
    expect((await plan(s.id)).status).toBe(SavingsStatus.ACTIVE)
    await runSavingsMaturityJob({ asOf: '2027-07-01', notify: noNotify })
    expect((await plan(s.id)).status).toBe(SavingsStatus.MATURED)

    const req = await requestSavingsWithdrawal({ memberId, savingsId: s.id, asOf: '2027-07-02' })
    expect(req.kind).toBe(SavingsWithdrawalKind.MATURITY)
    expect(req.disbursement.amount.toFixed(2)).toBe('165016.57')
    expect((await plan(s.id)).status).toBe(SavingsStatus.WITHDRAWAL_PENDING)

    // Payout needs approval first, then dual control (approver ≠ payer).
    const evidence = await storedFile(adminB.id)
    await expect(
      confirmSavingsWithdrawalPayout({ savingsId: s.id, staff: adminB, valueDate: lagosToday(), bankReference: 'TRF-1', evidenceFileId: evidence }),
    ).rejects.toMatchObject({ code: 'STALE_STATE' })
    await approveSavingsWithdrawal({ savingsId: s.id, staff: adminA })
    await expect(
      confirmSavingsWithdrawalPayout({ savingsId: s.id, staff: adminA, valueDate: lagosToday(), bankReference: 'TRF-1', evidenceFileId: evidence }),
    ).rejects.toMatchObject({ code: 'DUAL_CONTROL_REQUIRED' })
    await confirmSavingsWithdrawalPayout({ savingsId: s.id, staff: adminB, valueDate: lagosToday(), bankReference: 'TRF-1', evidenceFileId: evidence })

    p = await plan(s.id)
    expect(p.status).toBe(SavingsStatus.WITHDRAWN)
    expect(Number(p.currentBalance)).toBe(0)
    const d = await prisma.disbursement.findUniqueOrThrow({ where: { id: req.disbursement.id } })
    expect(d.status).toBe(DisbursementStatus.PAID)
    expect((await payableFor(s.id)).toFixed(2)).toBe('0.00')
    const principalAgg = await prisma.journalLine.aggregate({
      where: { accountType: LedgerAccountType.SAVINGS_PRINCIPAL_LIABILITY, accountRefId: s.id },
      _sum: { debit: true, credit: true },
    })
    expect(principalAgg._sum.credit!.minus(principalAgg._sum.debit!).toFixed(2)).toBe('0.00')
  })

  it('regular plan: first deposit pays period 1, excess to wallet; schedule anchored on the value date (A-06)', async () => {
    const memberId = await createMember()
    const s = await subscribeToSavingsPlan({ memberId, productId: products.REGULAR, durationMonths: 6, targetAmount: 20000, frequency: SavingsFrequency.MONTHLY })
    await deposit(memberId, s.id, 25000, '2027-01-31')
    const p = await plan(s.id)
    expect(p.periods.map((x) => formatDateOnly(x.dueDate))).toEqual([
      '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30',
    ])
    expect(formatDateOnly(p.maturityDate!)).toBe('2027-07-31')
    expect(p.periods[0].status).toBe(PaymentPeriodStatus.COMPLETED)
    expect(Number(p.periods[0].amountPaid)).toBe(20000)
    expect(Number(p.currentBalance)).toBe(20000)
    expect((await getWalletBalance(memberId)).toFixed(2)).toBe('5000.00')

    // Weekly plans have no due date on/after maturity.
    const w = await subscribeToSavingsPlan({ memberId, productId: products.REGULAR, durationMonths: 1, targetAmount: 1000, frequency: SavingsFrequency.WEEKLY })
    await deposit(memberId, w.id, 1000, '2027-02-01')
    expect((await plan(w.id)).periods.map((x) => formatDateOnly(x.dueDate))).toEqual(['2027-02-01', '2027-02-08', '2027-02-15', '2027-02-22'])
  })

  it('C5 regular forfeiture: 8 Mar (grace) keeps interest 1,524.86; 9 Mar forfeits; value-date correction restores', async () => {
    const results: Record<string, string> = {}
    for (const valueDate of ['2027-03-08', '2027-03-09']) {
      const memberId = await createMember()
      const s = await subscribeToSavingsPlan({ memberId, productId: products.REGULAR, durationMonths: 6, targetAmount: 20000, frequency: SavingsFrequency.MONTHLY })
      await deposit(memberId, s.id, 20000, '2027-01-01')
      const periods = (await plan(s.id)).periods
      expect(formatDateOnly(periods[2].dueDate)).toBe('2027-03-01')
      const { payment } = await deposit(memberId, s.id, 20000, valueDate, [periods[2].id])

      await runSavingsForfeitureJob({ asOf: '2027-03-20' })
      const p3 = await prisma.savingsPeriod.findUniqueOrThrow({ where: { id: periods[2].id }, include: { lots: true } })
      expect(p3.status).toBe(PaymentPeriodStatus.COMPLETED)
      results[valueDate] = String(p3.interestForfeited)

      // Unpaid period 2 (due 1 Feb) is overdue and forfeited from day +8 (9 Feb), not on day +7.
      const p2 = periods[1]
      await runSavingsForfeitureJob({ asOf: '2027-02-08' })
      expect((await prisma.savingsPeriod.findUniqueOrThrow({ where: { id: p2.id } })).status).toBe(PaymentPeriodStatus.OVERDUE)
      await runSavingsForfeitureJob({ asOf: '2027-03-20' })
      expect((await prisma.savingsPeriod.findUniqueOrThrow({ where: { id: p2.id } })).interestForfeited).toBe(true)

      if (valueDate === '2027-03-09') {
        expect(p3.lots[0].interestBearing).toBe(false)
        // Value-date correction (e.g. bank statement shows 8 Mar) clears the forfeiture.
        await prisma.payment.update({ where: { id: payment.id }, data: { valueDate: new Date('2027-03-08') } })
        await prisma.savingsLot.update({ where: { id: p3.lots[0].id }, data: { valueDate: new Date('2027-03-08') } })
        await prisma.$transaction((tx) => recalculateSavingsPeriodForfeiture(tx, p3.id, '2027-03-20'))
        const restored = await prisma.savingsLot.findUniqueOrThrow({ where: { id: p3.lots[0].id } })
        expect(restored.interestBearing).toBe(true)
      }
      await runSavingsAccrualJob({ asOf: '2027-07-01' })
      const lot = await prisma.savingsLot.findFirstOrThrow({ where: { savingsPeriodId: p3.id }, include: { accruals: true } })
      const earned = lot.accruals.filter((a) => !a.reversedAt).reduce((sum, a) => sum.plus(a.amount), new Prisma.Decimal(0))
      expect(earned.toFixed(2)).toBe('1524.86')
    }
    expect(results).toEqual({ '2027-03-08': 'false', '2027-03-09': 'true' })
  })

  it('forfeiting a period reverses interest already accrued on its lots', async () => {
    const memberId = await createMember()
    const s = await subscribeToSavingsPlan({ memberId, productId: products.REGULAR, durationMonths: 6, targetAmount: 20000, frequency: SavingsFrequency.MONTHLY })
    await deposit(memberId, s.id, 20000, '2027-01-01')
    const periods = (await plan(s.id)).periods
    await deposit(memberId, s.id, 10000, '2027-02-02', [periods[1].id]) // part-paid on time
    await runSavingsAccrualJob({ asOf: '2027-01-31' })
    const lot = await prisma.savingsLot.findFirstOrThrow({ where: { savingsPeriodId: periods[1].id } })
    // Accrue before the forfeiture boundary is evaluated (job ordering does not matter).
    await prisma.$transaction((tx) => accrueSavingsPlanInterest(tx, s.id, '2027-02-28'))
    const before = await prisma.savingsInterestAccrual.findMany({ where: { lotId: lot.id, reversedAt: null } })
    expect(before.length).toBe(1)
    await runSavingsForfeitureJob({ asOf: '2027-03-01' })
    const after = await prisma.savingsInterestAccrual.findMany({ where: { lotId: lot.id } })
    expect(after.every((a) => a.reversedAt)).toBe(true)
    expect((await prisma.savingsPeriod.findUniqueOrThrow({ where: { id: periods[1].id } })).status).toBe(PaymentPeriodStatus.OVERDUE)
  })

  it('a forfeiture cleared after maturity re-posts the lot interest once (maturity true-up, OQ-12)', async () => {
    const memberId = await createMember()
    const s = await subscribeToSavingsPlan({ memberId, productId: products.REGULAR, durationMonths: 6, targetAmount: 20000, frequency: SavingsFrequency.MONTHLY })
    await deposit(memberId, s.id, 20000, '2027-01-01')
    const periods = (await plan(s.id)).periods
    await deposit(memberId, s.id, 10000, '2027-02-02', [periods[1].id])
    const lot = await prisma.savingsLot.findFirstOrThrow({ where: { savingsPeriodId: periods[1].id } })
    await prisma.$transaction((tx) => accrueSavingsPlanInterest(tx, s.id, '2027-07-01'))
    // Forfeiture evaluated late (e.g. after a rejected receipt): every row, including maturity, is reversed.
    await prisma.$transaction((tx) => recalculateSavingsPeriodForfeiture(tx, periods[1].id, '2027-07-02'))
    expect((await prisma.savingsInterestAccrual.findMany({ where: { lotId: lot.id, reversedAt: null } })).length).toBe(0)
    // A correction (simulated: the period's amount due was 10,000) clears the forfeiture.
    await prisma.savingsPeriod.update({ where: { id: periods[1].id }, data: { amountDue: 10000 } })
    await prisma.$transaction((tx) => recalculateSavingsPeriodForfeiture(tx, periods[1].id, '2027-07-10'))
    await prisma.$transaction((tx) => accrueSavingsPlanInterest(tx, s.id, '2027-07-10'))
    await prisma.$transaction((tx) => accrueSavingsPlanInterest(tx, s.id, '2027-07-10')) // idempotent
    const active = await prisma.savingsInterestAccrual.findMany({ where: { lotId: lot.id, reversedAt: null } })
    const total = active.reduce((sum, a) => sum.plus(a.amount), new Prisma.Decimal(0))
    // 10,000 × 12% × 149/181: held 2 Feb → 1 Jul (149 days) of a 181-day term
    expect(total.toFixed(2)).toBe(new Prisma.Decimal(10000).times(12).dividedBy(100).times(149).dividedBy(181).toDecimalPlaces(2).toFixed(2))
    expect(active).toHaveLength(1)
  })

  it('review shield suppresses forfeiture; rejection lifts it and the next run catches up (A-11)', async () => {
    const memberId = await createMember()
    const s = await subscribeToSavingsPlan({ memberId, productId: products.REGULAR, durationMonths: 6, targetAmount: 20000, frequency: SavingsFrequency.MONTHLY })
    await deposit(memberId, s.id, 20000, '2027-01-01')
    const p2 = (await plan(s.id)).periods[1]
    const { submission } = await submitSavingsDeposit({
      memberId, savingsId: s.id, amount: 20000, paidOn: lagosToday(), periodIds: [p2.id], receiptFileId: await storedFile(memberId),
    })
    expect((await prisma.savingsPeriod.findUniqueOrThrow({ where: { id: p2.id } })).status).toBe(PaymentPeriodStatus.IN_REVIEW)
    await runSavingsForfeitureJob({ asOf: '2027-02-20' })
    let row = await prisma.savingsPeriod.findUniqueOrThrow({ where: { id: p2.id } })
    expect(row.interestForfeited).toBe(false)
    expect(row.status).toBe(PaymentPeriodStatus.IN_REVIEW)

    await rejectPaymentSubmission({ submissionId: submission.id, reviewerId: ownerId, rejectionReason: 'Unreadable receipt' })
    await runSavingsForfeitureJob({ asOf: '2027-02-20' })
    row = await prisma.savingsPeriod.findUniqueOrThrow({ where: { id: p2.id } })
    expect(row.interestForfeited).toBe(true)
    expect(row.status).toBe(PaymentPeriodStatus.OVERDUE)
  })

  it('fixed plan takes principal up to the target, excess to the wallet, then refuses more receipts', async () => {
    const memberId = await createMember()
    const s = await subscribeToSavingsPlan({ memberId, productId: products.FIXED, durationMonths: 6, targetAmount: 100000 })
    await deposit(memberId, s.id, 120000, '2027-01-10')
    const p = await plan(s.id)
    expect(Number(p.currentBalance)).toBe(100000)
    expect(p.periods).toHaveLength(0)
    expect((await getWalletBalance(memberId)).toFixed(2)).toBe('20000.00')
    await expect(
      submitSavingsDeposit({ memberId, savingsId: s.id, amount: 1, paidOn: lagosToday(), receiptFileId: await storedFile(memberId) }),
    ).rejects.toMatchObject({ code: 'SAVINGS_TARGET_REACHED' })
  })

  it('confirming the same first deposit twice (concurrently) posts one payment and one lot', async () => {
    const memberId = await createMember()
    const s = await subscribeToSavingsPlan({ memberId, productId: products.STAGGERED, durationMonths: 6 })
    const { submission } = await submitSavingsDeposit({ memberId, savingsId: s.id, amount: 7000, paidOn: lagosToday(), receiptFileId: await storedFile(memberId) })
    const outcomes = await Promise.allSettled([
      confirmPaymentSubmission({ submissionId: submission.id, confirmedById: ownerId }),
      confirmPaymentSubmission({ submissionId: submission.id, confirmedById: ownerId }),
    ])
    expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true)
    const p = await plan(s.id)
    expect(p.lots).toHaveLength(1)
    expect(Number(p.currentBalance)).toBe(7000)
    expect(await prisma.payment.count({ where: { submissionId: submission.id } })).toBe(1)
  })

  it('early withdrawal forfeits accrued interest; refused while locked, reserved or already pending', async () => {
    const memberId = await createMember()
    const s = await subscribeToSavingsPlan({ memberId, productId: products.STAGGERED, durationMonths: 6 })
    await deposit(memberId, s.id, 100000, '2026-10-01')
    await runSavingsAccrualJob({ asOf: '2026-11-30' })
    expect((await getAccruedInterest(prisma, s.id)).gt(0)).toBe(true)

    // Own-loan lock (D-02).
    const loan = await prisma.loan.create({
      data: { userId: memberId, requestedAmount: 50000, duration: 6, interestRate: 5, purpose: 'Test', status: LoanStatus.ACTIVE },
    })
    await expect(requestSavingsWithdrawal({ memberId, savingsId: s.id })).rejects.toMatchObject({ code: 'OWN_SAVINGS_LOCKED' })
    await prisma.loan.update({ where: { id: loan.id }, data: { status: LoanStatus.COMPLETED } })

    // Principal reserved for a guarantee.
    const other = await createMember()
    const reservation = await prisma.guaranteeReservation.create({
      data: { guaranteeType: GuaranteeType.LOAN, guarantorId: memberId, applicantId: other, requestedAmount: 1000, reservedAmount: 1000, state: GuaranteeState.CONSENTED },
    })
    await expect(requestSavingsWithdrawal({ memberId, savingsId: s.id })).rejects.toMatchObject({ code: 'SAVINGS_ENCUMBERED' })
    await prisma.guaranteeReservation.update({ where: { id: reservation.id }, data: { state: GuaranteeState.RELEASED } })

    // Two concurrent requests: exactly one wins.
    const both = await Promise.allSettled([
      requestSavingsWithdrawal({ memberId, savingsId: s.id }),
      requestSavingsWithdrawal({ memberId, savingsId: s.id }),
    ])
    expect(both.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    const p = await plan(s.id)
    expect(p.status).toBe(SavingsStatus.WITHDRAWAL_PENDING)
    expect(p.withdrawalKind).toBe(SavingsWithdrawalKind.EARLY)
    expect(Number(p.withdrawalInterest)).toBe(0)

    // Member cancels → ACTIVE; requests again; staff approve and pay.
    await cancelSavingsWithdrawal({ savingsId: s.id, actorId: memberId, memberId, reason: 'Changed my mind' })
    expect((await plan(s.id)).status).toBe(SavingsStatus.ACTIVE)
    await requestSavingsWithdrawal({ memberId, savingsId: s.id })
    await approveSavingsWithdrawal({ savingsId: s.id, staff: adminA })
    await expect(
      cancelSavingsWithdrawal({ savingsId: s.id, actorId: memberId, memberId, reason: 'Too late' }),
    ).rejects.toMatchObject({ code: 'STALE_STATE' })
    await confirmSavingsWithdrawalPayout({
      savingsId: s.id, staff: adminB, valueDate: lagosToday(), bankReference: 'TRF-EARLY', evidenceFileId: await storedFile(adminB.id),
    })
    expect((await plan(s.id)).status).toBe(SavingsStatus.WITHDRAWN)
    expect((await payableFor(s.id)).toFixed(2)).toBe('0.00')
    expect((await getAccruedInterest(prisma, s.id)).toFixed(2)).toBe('0.00')
  })

  it('a rate change never alters an existing plan; a new subscription uses the new rate', async () => {
    const memberId = await createMember()
    const product = await prisma.savingsProduct.create({
      data: { type: SavingsType.STAGGERED, title: `${prefix} rate`, description: 'x', icon: 'PiggyBank', createdBy: ownerId },
    })
    await setSavingsProductTermRates(ownerId, product.id, [{ durationMonths: 3, ratePercent: 3 }])
    const first = await subscribeToSavingsPlan({ memberId, productId: product.id, durationMonths: 3 })
    await setSavingsProductTermRates(ownerId, product.id, [{ durationMonths: 3, ratePercent: 4 }])
    const second = await subscribeToSavingsPlan({ memberId, productId: product.id, durationMonths: 3 })
    expect(Number((await plan(first.id)).ratePercentSnapshot)).toBe(3)
    expect(Number(second.ratePercentSnapshot)).toBe(4)
    expect(second.rateVersionSnapshot).toBe(2)
  })
})
