import { Prisma } from '@/generated/prisma/client'
import {
  AdminPermission,
  AllocationStatus,
  AllocationTargetType,
  DisbursementPurpose,
  DisbursementStatus,
  EAjoMemberStatus,
  EAjoPayoutStatus,
  EAjoStatus,
  GuaranteeState,
  GuaranteeType,
  LedgerAccountType,
  PaymentComponentType,
  PaymentStatus,
  PaymentSubmissionStatus,
  UserRole,
} from '@/generated/prisma/enums'
import { prisma } from '@/lib/prisma'
import { AppError } from '@/lib/errors/app-error'
import { lockMembers, transition } from '@/lib/db/concurrency'
import { addDays, addMonthsClamped, lagosToday, parseDateOnly, toLagosDateString } from '@/lib/domain/dates'
import { roundMoney } from '@/lib/domain/money'
import { formatSequentialNumber, nextSequenceAfter } from '@/lib/domain/payment-reference'
import { lockSequence } from '@/lib/db/sequence'
import { calculateEAjoAdvanceExposure } from '@/lib/domain/capacity'
import {
  calculateEAjoPayout,
  evaluateEAjoPayoutEligibility,
  type EAjoPayoutEligibility,
} from '@/lib/domain/eajo-payout'
import { planEAjoPenaltyAccruals } from '@/lib/domain/eajo-penalty'
import { enforceDualControl, type StaffActor } from '@/lib/authz/guards'
import { getMemberUnencumberedSavings, requestEAjoGuarantor } from '@/lib/services/guarantees.service'
import { generateAndPersistEAjoSchedule, recordEAjoPenaltyAccrual } from '@/lib/services/schedules.service'
import { postEajoPayout, postJournalEntry, type JournalLineInput } from '@/lib/services/ledger.service'
import { assertProductEligibility } from '@/lib/services/profile.service'
import { AuditAction, AuditOutcome, recordAuditEvent } from '@/lib/services/audit.service'

/**
 * E-ajo slot-and-payout model (PR P3-05, guide §1.5, §2.1, §2.3, §2.8, §2.12, ASSUMPTION A-09).
 *
 * - Members pick any slot; several may share a slot unless the group sets `maxMembersPerSlot`.
 * - Each participant's payout is `c × N − earlySlotPenalty`, independent of everyone else (D-03).
 * - Roster and amounts lock at activation, when contribution periods and the payout record are
 *   created from the snapshot terms.
 * - Contributions credit EAJO_CONTRIBUTION_LIABILITY before the participant's payout and
 *   EAJO_ADVANCE_RECEIVABLE after it.
 *
 * Every function that changes state takes a transaction client; callers own the transaction.
 * Locking order: the group lock (if any) first, then member advisory locks.
 */

type Tx = Prisma.TransactionClient

export interface EAjoActorRef {
  id: string
  role: UserRole
}

/** Participant statuses that occupy a slot (count toward `maxMembersPerSlot`). */
const SLOT_OCCUPYING_STATUSES: EAjoMemberStatus[] = [
  EAjoMemberStatus.PENDING,
  EAjoMemberStatus.APPROVED,
  EAjoMemberStatus.ACTIVE,
  EAjoMemberStatus.COMPLETED,
]

const PAYOUT_CANCELLABLE_STATUSES: EAjoPayoutStatus[] = [
  EAjoPayoutStatus.NOT_ELIGIBLE,
  EAjoPayoutStatus.ELIGIBLE,
  EAjoPayoutStatus.HELD,
]

const ZERO = new Prisma.Decimal(0)

function hasRawExecutor(tx: Tx): boolean {
  return typeof (tx as unknown as { $executeRaw?: unknown }).$executeRaw === 'function'
}

/** Serialises all roster changes of one group (joins, approvals, activation, cancellation). */
export async function lockEAjoGroup(tx: Tx, groupId: string): Promise<void> {
  if (!hasRawExecutor(tx)) return
  const lockKey = `eajo-group:${groupId}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
}

function lagosDateKey(d: Date | string): string {
  return toLagosDateString(parseDateOnly(d))
}

function dateOnly(d: Date | string): Date {
  return parseDateOnly(d)
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

/**
 * Balance (credits − debits) of a liability-type account for one participant, from the journal.
 * Contribution allocations post with `accountRefId = eajoMemberId`.
 */
export async function getEAjoParticipantLedgerBalance(
  tx: Tx | typeof prisma,
  eajoMemberId: string,
  accountType: LedgerAccountType,
): Promise<Prisma.Decimal> {
  const agg = await tx.journalLine.aggregate({
    where: { accountType, accountRefId: eajoMemberId },
    _sum: { debit: true, credit: true },
  })
  return roundMoney((agg._sum.credit ?? ZERO).minus(agg._sum.debit ?? ZERO))
}

/**
 * Account a confirmed e-ajo contribution credits (§2.8 rule 5, §2.12): the contribution liability
 * until the participant's payout is PAID, the advance receivable afterwards.
 */
export async function getEAjoContributionCreditAccounts(
  tx: Tx,
  eajoMemberIds: string[],
): Promise<Map<string, LedgerAccountType>> {
  const unique = [...new Set(eajoMemberIds)]
  const result = new Map<string, LedgerAccountType>()
  if (unique.length === 0) return result
  const payouts = await tx.eAjoPayout.findMany({
    where: { eajoMemberId: { in: unique } },
    select: { eajoMemberId: true, status: true },
  })
  const paid = new Set(payouts.filter((p) => p.status === EAjoPayoutStatus.PAID).map((p) => p.eajoMemberId))
  for (const id of unique) {
    result.set(
      id,
      paid.has(id) ? LedgerAccountType.EAJO_ADVANCE_RECEIVABLE : LedgerAccountType.EAJO_CONTRIBUTION_LIABILITY,
    )
  }
  return result
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

async function releaseEAjoReservations(tx: Tx, eajoMemberId: string, reason: string) {
  const open = await tx.guaranteeReservation.findMany({
    where: {
      eajoMemberId,
      state: { in: [GuaranteeState.PENDING, GuaranteeState.CONSENTED, GuaranteeState.AWAITING_RECONSENT] },
    },
  })
  for (const r of open) {
    await tx.guaranteeReservation.update({
      where: { id: r.id },
      data: {
        state: GuaranteeState.RELEASED,
        reservedAmount: ZERO,
        releasedAt: new Date(),
        decisionReason: r.decisionReason ?? reason,
      },
    })
  }
  return open.length
}

// ---------------------------------------------------------------------------
// Join, approve, reject
// ---------------------------------------------------------------------------

export interface JoinEAjoGroupParams {
  memberId: string
  groupId: string
  slotNumber: number
  guarantorId: string
  actor: EAjoActorRef
}

/**
 * A member applies for a slot (§2.8 rule 2). Concurrent joins are serialised by the group lock,
 * so `maxMembersPerSlot` cannot be exceeded. Pending applications occupy their slot.
 */
export async function joinEAjoGroup(tx: Tx, params: JoinEAjoGroupParams) {
  const { memberId, groupId, slotNumber, guarantorId, actor } = params

  await lockEAjoGroup(tx, groupId)

  const group = await tx.eAjoGroup.findUnique({
    where: { id: groupId },
    include: { slotPolicies: true },
  })
  if (!group) throw new AppError('NOT_FOUND', 'E-ajo group not found.', { statusCode: 404 })
  if (group.status !== EAjoStatus.PENDING) {
    throw new AppError('GROUP_NOT_OPEN', 'This group is no longer accepting applications.', { statusCode: 409 })
  }
  if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > group.totalSlots) {
    throw new AppError('VALIDATION_ERROR', `Choose a slot between 1 and ${group.totalSlots}.`, {
      statusCode: 422,
      fieldErrors: { slotNumber: ['Invalid slot'] },
    })
  }
  const policy = group.slotPolicies.find((p) => p.slotNumber === slotNumber)
  if (!policy) {
    // §2.8 rule 1: never fall back to a default penalty
    throw new AppError('SLOT_POLICY_MISSING', 'This group has no early-slot penalty for that slot.', { statusCode: 422 })
  }
  if (guarantorId === memberId) {
    throw new AppError('INVALID_GUARANTOR', 'You cannot act as your own guarantor.', { statusCode: 422 })
  }

  await lockMembers(tx, [memberId, guarantorId])

  const existing = await tx.eAjoMember.findUnique({ where: { groupId_userId: { groupId, userId: memberId } } })
  if (existing) {
    throw new AppError('ALREADY_JOINED', 'You have already applied to this group.', { statusCode: 409 })
  }

  if (group.maxMembersPerSlot !== null && group.maxMembersPerSlot !== undefined) {
    const occupying = await tx.eAjoMember.count({
      where: { groupId, payoutPosition: slotNumber, status: { in: SLOT_OCCUPYING_STATUSES } },
    })
    if (occupying >= group.maxMembersPerSlot) {
      throw new AppError('SLOT_FULL', `Slot ${slotNumber} is full. Please choose another slot.`, { statusCode: 409 })
    }
  }

  const preview = calculateEAjoPayout({
    monthlyContribution: group.contributionAmount,
    totalSlots: group.totalSlots,
    slotNumber,
    earlySlotPenaltyPercent: policy.earlySlotPenaltyPercent,
  })

  const guarantor = await tx.user.findUnique({
    where: { id: guarantorId },
    select: { id: true, name: true, userInfo: { select: { phoneNumber: true } } },
  })

  const participant = await tx.eAjoMember.create({
    data: {
      groupId,
      userId: memberId,
      payoutPosition: slotNumber,
      // Preview values; the binding snapshot is taken at activation (§2.8 rule 3)
      feePercentage: policy.earlySlotPenaltyPercent,
      feeAmount: preview.earlySlotPenalty,
      totalExpectedPayout: preview.expectedPayout,
      netPayoutAmount: preview.netPayout,
      earlySlotPenaltyPercent: policy.earlySlotPenaltyPercent,
      guarantorName: guarantor?.name ?? null,
      guarantorPhoneNumber: guarantor?.userInfo?.phoneNumber ?? null,
      status: EAjoMemberStatus.PENDING,
    },
  })

  const reservation = await requestEAjoGuarantor(tx, {
    eajoMemberId: participant.id,
    applicantId: memberId,
    guarantorId,
    slotNumber,
    totalSlots: group.totalSlots,
    monthlyContribution: group.contributionAmount,
  })

  await recordAuditEvent(
    {
      actorId: actor.id,
      actorRole: actor.role,
      affectedUserId: memberId,
      action: AuditAction.EAJO_MEMBER_JOINED,
      entityType: 'EAjoMember',
      entityId: participant.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: {
        groupId,
        slotNumber,
        guaranteeReservationId: reservation.id,
        expectedPayout: preview.expectedPayout.toFixed(2),
        advanceAmount: preview.advanceAmount.toFixed(2),
        earlySlotPenalty: preview.earlySlotPenalty.toFixed(2),
        netPayout: preview.netPayout.toFixed(2),
      },
    },
    tx,
  )

  return { participant, reservation, preview }
}

async function loadParticipantForUpdate(tx: Tx, eajoMemberId: string) {
  const participant = await tx.eAjoMember.findUnique({ where: { id: eajoMemberId } })
  if (!participant) throw new AppError('NOT_FOUND', 'E-ajo participant not found.', { statusCode: 404 })
  return participant
}

/**
 * Admin approves an application (§2.7: only after the guarantor has consented and the reservation
 * still fits the guarantor's free capacity). The roster can only change while the group is PENDING.
 */
export async function approveEAjoParticipant(tx: Tx, params: { eajoMemberId: string; actor: EAjoActorRef }) {
  const first = await loadParticipantForUpdate(tx, params.eajoMemberId)
  await lockEAjoGroup(tx, first.groupId)

  const reservation = await tx.guaranteeReservation.findFirst({
    where: { eajoMemberId: first.id, guaranteeType: GuaranteeType.EAJO },
    orderBy: { createdAt: 'desc' },
  })
  await lockMembers(tx, [first.userId, ...(reservation ? [reservation.guarantorId] : [])])

  const participant = await loadParticipantForUpdate(tx, params.eajoMemberId)
  const group = await tx.eAjoGroup.findUniqueOrThrow({ where: { id: participant.groupId } })
  if (group.status !== EAjoStatus.PENDING) {
    throw new AppError('ROSTER_LOCKED', 'The group roster is locked after activation.', { statusCode: 409 })
  }
  if (participant.status !== EAjoMemberStatus.PENDING) {
    throw new AppError('STALE_STATE', `Application is ${participant.status} and cannot be approved.`, { statusCode: 409 })
  }

  if (!reservation || reservation.state !== GuaranteeState.CONSENTED) {
    throw new AppError(
      'GUARANTOR_CONSENT_REQUIRED',
      'The named guarantor has not consented to this e-ajo guarantee yet.',
      { statusCode: 422 },
    )
  }

  const expectedAdvance = calculateEAjoAdvanceExposure({
    payoutPosition: participant.payoutPosition,
    totalSlots: group.totalSlots,
    contributionAmount: group.contributionAmount,
  })
  if (!roundMoney(reservation.reservedAmount).equals(expectedAdvance)) {
    throw new AppError(
      'GUARANTEE_TERMS_CHANGED',
      'The guarantee no longer matches the group terms; the guarantor must consent again.',
      { statusCode: 409 },
    )
  }

  // Recheck capacity at approval (§2.1): never approve on stale capacity
  const free = await getMemberUnencumberedSavings(reservation.guarantorId, tx, reservation.id)
  const guarantor = await tx.user.findUnique({
    where: { id: reservation.guarantorId },
    select: { role: true, isActive: true },
  })
  if (!guarantor || guarantor.role !== UserRole.USER || !guarantor.isActive) {
    throw new AppError('INELIGIBLE_GUARANTOR', 'The guarantor is no longer an active member.', { statusCode: 422 })
  }
  if (free.lt(reservation.reservedAmount) || (reservation.reservedAmount.lte(0) && free.lte(0))) {
    throw new AppError(
      'CAPACITY_EXCEEDED',
      `The guarantor no longer has enough free capacity (available ₦${free.toFixed(2)}, needed ₦${reservation.reservedAmount.toFixed(2)}).`,
      { statusCode: 422 },
    )
  }

  await assertProductEligibility(participant.userId, 'EAJO', tx as unknown as typeof prisma)

  await transition(tx.eAjoMember, participant.id, EAjoMemberStatus.PENDING, {
    status: EAjoMemberStatus.APPROVED,
    approvedAt: new Date(),
    approvedBy: params.actor.id,
  })
  await tx.eAjoGroup.update({ where: { id: group.id }, data: { filledSlots: { increment: 1 } } })

  await recordAuditEvent(
    {
      actorId: params.actor.id,
      actorRole: params.actor.role,
      affectedUserId: participant.userId,
      action: AuditAction.EAJO_PARTICIPANT_APPROVED,
      entityType: 'EAjoMember',
      entityId: participant.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: { groupId: group.id, slotNumber: participant.payoutPosition, guaranteeReservationId: reservation.id },
    },
    tx,
  )

  return tx.eAjoMember.findUniqueOrThrow({ where: { id: participant.id } })
}

/** Admin rejects a pending application with a reason; the guarantee reservation is released. */
export async function rejectEAjoParticipant(
  tx: Tx,
  params: { eajoMemberId: string; actor: EAjoActorRef; reason: string },
) {
  const reason = params.reason?.trim()
  if (!reason) {
    throw new AppError('REASON_REQUIRED', 'A rejection reason is required.', { statusCode: 422 })
  }
  const first = await loadParticipantForUpdate(tx, params.eajoMemberId)
  await lockEAjoGroup(tx, first.groupId)
  await lockMembers(tx, [first.userId])

  await transition(
    tx.eAjoMember,
    first.id,
    EAjoMemberStatus.PENDING,
    { status: EAjoMemberStatus.REJECTED, rejectionReason: reason, approvedBy: params.actor.id },
    'Only a pending application can be rejected.',
  )
  await releaseEAjoReservations(tx, first.id, 'E-ajo application rejected')

  await recordAuditEvent(
    {
      actorId: params.actor.id,
      actorRole: params.actor.role,
      affectedUserId: first.userId,
      action: AuditAction.EAJO_PARTICIPANT_REJECTED,
      entityType: 'EAjoMember',
      entityId: first.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: { groupId: first.groupId, reason },
    },
    tx,
  )
  return tx.eAjoMember.findUniqueOrThrow({ where: { id: first.id } })
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * Activates a group (§2.8 rule 3): freezes roster and amounts, snapshots each participant's slot
 * penalty and late-penalty terms, creates their contribution periods and their payout record.
 * Applications still pending at activation are rejected and their reservations released.
 * The group does not need every slot filled; `minParticipants` is an optional admin setting.
 */
export async function activateEAjoGroup(
  tx: Tx,
  params: { groupId: string; actor: EAjoActorRef; startDate?: string | Date | null; today?: string },
) {
  const today = params.today ?? lagosToday()
  await lockEAjoGroup(tx, params.groupId)

  const group = await tx.eAjoGroup.findUnique({
    where: { id: params.groupId },
    include: { slotPolicies: true, members: true },
  })
  if (!group) throw new AppError('NOT_FOUND', 'E-ajo group not found.', { statusCode: 404 })
  if (group.status !== EAjoStatus.PENDING) {
    throw new AppError('STALE_STATE', `Group is ${group.status} and cannot be activated.`, { statusCode: 409 })
  }
  if (group.latePenaltyDailyPercent === null || group.penaltyCapType === null || group.penaltyCapValue === null) {
    throw new AppError('TERMS_INCOMPLETE', 'Set the late-payment penalty and cap before activating.', { statusCode: 422 })
  }
  for (let s = 1; s <= group.totalSlots; s++) {
    if (!group.slotPolicies.some((p) => p.slotNumber === s)) {
      throw new AppError('SLOT_POLICY_MISSING', `Slot ${s} has no early-slot penalty.`, { statusCode: 422 })
    }
  }

  const startRaw = params.startDate ?? group.startDate ?? today
  const startDate = dateOnly(startRaw)
  if (lagosDateKey(startDate) < today) {
    throw new AppError('INVALID_START_DATE', 'The start date cannot be in the past.', {
      statusCode: 422,
      fieldErrors: { startDate: ['Start date cannot be in the past'] },
    })
  }

  const approved = group.members.filter((m) => m.status === EAjoMemberStatus.APPROVED)
  const pending = group.members.filter((m) => m.status === EAjoMemberStatus.PENDING)
  const minimum = Math.max(1, group.minParticipants ?? 1)
  if (approved.length < minimum) {
    throw new AppError(
      'NOT_ENOUGH_PARTICIPANTS',
      `At least ${minimum} approved participant(s) are needed to activate (currently ${approved.length}).`,
      { statusCode: 422 },
    )
  }

  const reservations = await tx.guaranteeReservation.findMany({
    where: { eajoMemberId: { in: approved.map((m) => m.id) } },
  })
  await lockMembers(tx, [
    ...approved.map((m) => m.userId),
    ...pending.map((m) => m.userId),
    ...reservations.map((r) => r.guarantorId),
  ])

  const missingConsent = approved.filter(
    (m) => !reservations.some((r) => r.eajoMemberId === m.id && r.state === GuaranteeState.CONSENTED),
  )
  if (missingConsent.length > 0) {
    throw new AppError(
      'GUARANTOR_CONSENT_REQUIRED',
      `${missingConsent.length} approved participant(s) no longer have a consented guarantor. Cancel them or arrange a replacement before activating.`,
      { statusCode: 422 },
    )
  }

  for (const m of pending) {
    await transition(tx.eAjoMember, m.id, EAjoMemberStatus.PENDING, {
      status: EAjoMemberStatus.REJECTED,
      rejectionReason: 'The group was activated before this application was approved.',
      approvedBy: params.actor.id,
    })
    await releaseEAjoReservations(tx, m.id, 'Group activated before approval')
  }

  for (const m of approved) {
    const policy = group.slotPolicies.find((p) => p.slotNumber === m.payoutPosition)!
    const calc = calculateEAjoPayout({
      monthlyContribution: group.contributionAmount,
      totalSlots: group.totalSlots,
      slotNumber: m.payoutPosition,
      earlySlotPenaltyPercent: policy.earlySlotPenaltyPercent,
    })

    await transition(tx.eAjoMember, m.id, EAjoMemberStatus.APPROVED, {
      status: EAjoMemberStatus.ACTIVE,
      activatedAt: new Date(),
      earlySlotPenaltyPercent: policy.earlySlotPenaltyPercent,
      feePercentage: policy.earlySlotPenaltyPercent,
      feeAmount: calc.earlySlotPenalty,
      totalExpectedPayout: calc.expectedPayout,
      netPayoutAmount: calc.netPayout,
      latePenaltyDailyPercent: group.latePenaltyDailyPercent,
      penaltyCapType: group.penaltyCapType,
      penaltyCapValue: group.penaltyCapValue,
    })

    const periods = await generateAndPersistEAjoSchedule(tx, {
      eAjoMemberId: m.id,
      contributionAmount: group.contributionAmount,
      totalSlots: group.totalSlots,
      groupStartDate: startDate,
    })
    const payoutPeriod = periods.find((p) => p.periodNumber === m.payoutPosition)

    await tx.eAjoPayout.create({
      data: {
        eajoMemberId: m.id,
        expectedPayout: calc.expectedPayout,
        advanceAmount: calc.advanceAmount,
        earlySlotPenaltyPercent: policy.earlySlotPenaltyPercent,
        earlySlotPenalty: calc.earlySlotPenalty,
        netPayout: calc.netPayout,
        payoutDueDate: payoutPeriod?.dueDate ?? null,
        status: EAjoPayoutStatus.NOT_ELIGIBLE,
      },
    })
  }

  await transition(tx.eAjoGroup, group.id, EAjoStatus.PENDING, {
    status: EAjoStatus.ACTIVE,
    startDate,
    endDate: addMonthsClamped(startDate, group.totalSlots - 1),
    activatedAt: new Date(),
    activatedById: params.actor.id,
    filledSlots: approved.length,
  })

  await recordAuditEvent(
    {
      actorId: params.actor.id,
      actorRole: params.actor.role,
      action: AuditAction.EAJO_GROUP_ACTIVATED,
      entityType: 'EAjoGroup',
      entityId: group.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: {
        startDate: lagosDateKey(startDate),
        participants: approved.length,
        pendingRejected: pending.length,
      },
    },
    tx,
  )

  return tx.eAjoGroup.findUniqueOrThrow({ where: { id: group.id } })
}

// ---------------------------------------------------------------------------
// Eligibility, reservation and completion (the post-change hook)
// ---------------------------------------------------------------------------

async function loadParticipantState(tx: Tx, eajoMemberId: string) {
  return tx.eAjoMember.findUnique({
    where: { id: eajoMemberId },
    include: {
      group: true,
      payout: true,
      contributionPeriods: { orderBy: { periodNumber: 'asc' } },
    },
  })
}

function periodStates(
  periods: Array<{
    periodNumber: number
    dueDate: Date
    contributionDue: Prisma.Decimal
    contributionPaid: Prisma.Decimal
    penaltyAssessed: Prisma.Decimal
    penaltyPaid: Prisma.Decimal
    penaltyWaived: Prisma.Decimal
  }>,
) {
  return periods.map((p) => ({
    periodNumber: p.periodNumber,
    dueDate: p.dueDate,
    contributionDue: p.contributionDue,
    contributionPaid: p.contributionPaid,
    penaltyOutstanding: Prisma.Decimal.max(0, p.penaltyAssessed.minus(p.penaltyPaid).minus(p.penaltyWaived)),
  }))
}

/** Live payout eligibility for one participant (pure rule + this participant's own periods). */
export async function getEAjoPayoutEligibility(
  tx: Tx | typeof prisma,
  eajoMemberId: string,
  today: string = lagosToday(),
): Promise<EAjoPayoutEligibility> {
  const state = await loadParticipantState(tx as Tx, eajoMemberId)
  if (!state) throw new AppError('NOT_FOUND', 'E-ajo participant not found.', { statusCode: 404 })
  return evaluateEAjoPayoutEligibility({
    slotNumber: state.payoutPosition,
    periods: periodStates(state.contributionPeriods),
    today,
  })
}

export interface RefreshEAjoParticipantResult {
  eligibilityChanged: boolean
  payoutStatus: EAjoPayoutStatus | null
  reservedAmount: Prisma.Decimal | null
  completed: boolean
}

/**
 * Idempotent post-change hook: after a confirmation, reversal, penalty accrual, payout or a date
 * change, re-derive (1) payout eligibility NOT_ELIGIBLE ↔ ELIGIBLE, (2) the guarantee reservation
 * (§2.1: advance before payout, remaining unpaid contributions after), and (3) completion.
 * The caller must hold the participant's member lock.
 */
export async function refreshEAjoParticipant(
  tx: Tx,
  eajoMemberId: string,
  options: { today?: string; actorId?: string | null } = {},
): Promise<RefreshEAjoParticipantResult> {
  const today = options.today ?? lagosToday()
  const state = await loadParticipantState(tx, eajoMemberId)
  const result: RefreshEAjoParticipantResult = {
    eligibilityChanged: false,
    payoutStatus: state?.payout?.status ?? null,
    reservedAmount: null,
    completed: false,
  }
  if (!state || state.status !== EAjoMemberStatus.ACTIVE || !state.payout) return result

  const payout = state.payout
  const states = periodStates(state.contributionPeriods)

  // 1. Payout eligibility (HELD/APPROVED/PAID/FAILED/CANCELLED are not touched here)
  if (payout.status === EAjoPayoutStatus.NOT_ELIGIBLE || payout.status === EAjoPayoutStatus.ELIGIBLE) {
    const evaluation = evaluateEAjoPayoutEligibility({ slotNumber: state.payoutPosition, periods: states, today })
    const target = evaluation.eligible ? EAjoPayoutStatus.ELIGIBLE : EAjoPayoutStatus.NOT_ELIGIBLE
    if (target !== payout.status) {
      await transition(tx.eAjoPayout, payout.id, payout.status, {
        status: target,
        eligibleAt: evaluation.eligible ? new Date() : null,
      })
      result.eligibilityChanged = true
      result.payoutStatus = target
      await recordAuditEvent(
        {
          actorId: options.actorId ?? null,
          affectedUserId: state.userId,
          action: AuditAction.EAJO_PAYOUT_ELIGIBILITY_CHANGED,
          entityType: 'EAjoPayout',
          entityId: payout.id,
          outcome: AuditOutcome.SUCCESS,
          metadata: { from: payout.status, to: target, reason: evaluation.reason, evaluatedFor: today },
        },
        tx,
      )
    }
  }

  // 2. Guarantee reservation (§2.1)
  const unpaidContributions = states.reduce(
    (acc, p) => acc.plus(Prisma.Decimal.max(0, new Prisma.Decimal(p.contributionDue).minus(p.contributionPaid))),
    ZERO,
  )
  const payoutPaid = payout.status === EAjoPayoutStatus.PAID
  const required = payoutPaid
    ? roundMoney(Prisma.Decimal.min(payout.advanceAmount, unpaidContributions))
    : roundMoney(payout.advanceAmount)
  const reservation = await tx.guaranteeReservation.findFirst({
    where: { eajoMemberId: state.id, state: GuaranteeState.CONSENTED },
  })
  if (reservation && !roundMoney(reservation.reservedAmount).equals(required)) {
    await tx.guaranteeReservation.update({ where: { id: reservation.id }, data: { reservedAmount: required } })
    await recordAuditEvent(
      {
        actorId: options.actorId ?? null,
        affectedUserId: reservation.guarantorId,
        action: AuditAction.EAJO_RESERVATION_RECALCULATED,
        entityType: 'GuaranteeReservation',
        entityId: reservation.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: { eajoMemberId: state.id, from: reservation.reservedAmount.toFixed(2), to: required.toFixed(2) },
      },
      tx,
    )
  }
  result.reservedAmount = required

  // 3. Completion: payout received and every contribution and assessed penalty settled
  const nothingOutstanding = states.every((p) =>
    Prisma.Decimal.max(0, new Prisma.Decimal(p.contributionDue).minus(p.contributionPaid))
      .plus(p.penaltyOutstanding)
      .lte(0),
  )
  if (payoutPaid && nothingOutstanding) {
    await transition(tx.eAjoMember, state.id, EAjoMemberStatus.ACTIVE, {
      status: EAjoMemberStatus.COMPLETED,
      completedAt: new Date(),
    })
    await releaseEAjoReservations(tx, state.id, 'E-ajo participation completed')
    result.completed = true
    await recordAuditEvent(
      {
        actorId: options.actorId ?? null,
        affectedUserId: state.userId,
        action: AuditAction.EAJO_PARTICIPANT_COMPLETED,
        entityType: 'EAjoMember',
        entityId: state.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: { groupId: state.groupId },
      },
      tx,
    )
    await completeEAjoGroupIfFinished(tx, state.groupId, options.actorId ?? null)
  }

  return result
}

async function completeEAjoGroupIfFinished(tx: Tx, groupId: string, actorId: string | null) {
  const group = await tx.eAjoGroup.findUnique({ where: { id: groupId }, include: { members: true } })
  if (!group || group.status !== EAjoStatus.ACTIVE) return
  const stillRunning = group.members.some(
    (m) => m.status === EAjoMemberStatus.ACTIVE || m.status === EAjoMemberStatus.APPROVED,
  )
  if (stillRunning) return
  await transition(tx.eAjoGroup, group.id, EAjoStatus.ACTIVE, { status: EAjoStatus.COMPLETED, completedAt: new Date() })
  await recordAuditEvent(
    {
      actorId,
      action: AuditAction.EAJO_GROUP_COMPLETED,
      entityType: 'EAjoGroup',
      entityId: group.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: {},
    },
    tx,
  )
}

/**
 * Called by payment confirmation/reversal (lib/services/payments.service.ts, EAJO branch) after
 * allocations to e-ajo periods changed. The member lock is already held by the caller.
 */
export async function afterEAjoAllocationsChanged(
  tx: Tx,
  eajoMemberIds: string[],
  options: { actorId?: string | null; today?: string } = {},
) {
  for (const id of [...new Set(eajoMemberIds)]) {
    await refreshEAjoParticipant(tx, id, options)
  }
}

// ---------------------------------------------------------------------------
// Cancellation (§2.8 rule 7)
// ---------------------------------------------------------------------------

/**
 * Admin cancels a participant before their payout. Before activation the application simply
 * ends. After activation, confirmed contributions held for the participant go to their wallet
 * (no early-slot penalty), the payout is cancelled and the reservation released.
 * Refused after the payout has been approved or paid (A-09). Unpaid late fees block it
 * (`PENALTIES_OUTSTANDING`) unless the admin passes `deductPenalties`: the fees are then paid out of
 * the contributions held and only the remainder is refunded (owner decision OQ-18).
 */
export async function cancelEAjoParticipant(
  tx: Tx,
  params: { eajoMemberId: string; actor: EAjoActorRef; reason: string; deductPenalties?: boolean },
) {
  const reason = params.reason?.trim()
  if (!reason) throw new AppError('REASON_REQUIRED', 'A cancellation reason is required.', { statusCode: 422 })

  const first = await loadParticipantForUpdate(tx, params.eajoMemberId)
  await lockEAjoGroup(tx, first.groupId)
  await lockMembers(tx, [first.userId])

  const state = await loadParticipantState(tx, first.id)
  if (!state) throw new AppError('NOT_FOUND', 'E-ajo participant not found.', { statusCode: 404 })

  let refunded = ZERO
  let penaltiesDeducted = ZERO
  let journalEntryId: string | null = null

  if (state.status === EAjoMemberStatus.PENDING || state.status === EAjoMemberStatus.APPROVED) {
    await transition(tx.eAjoMember, state.id, state.status, {
      status: EAjoMemberStatus.CANCELLED,
      cancelledAt: new Date(),
      cancelledById: params.actor.id,
      cancellationReason: reason,
    })
    if (state.status === EAjoMemberStatus.APPROVED && state.group.filledSlots > 0) {
      await tx.eAjoGroup.update({ where: { id: state.groupId }, data: { filledSlots: { decrement: 1 } } })
    }
  } else if (state.status === EAjoMemberStatus.ACTIVE) {
    const payout = state.payout
    if (!payout || !PAYOUT_CANCELLABLE_STATUSES.includes(payout.status)) {
      throw new AppError(
        'CANCELLATION_NOT_ALLOWED',
        payout?.status === EAjoPayoutStatus.PAID
          ? 'This participant has already received their payout and must keep contributing; cancellation is not allowed.'
          : 'The payout is being processed; cancellation is not allowed.',
        { statusCode: 409 },
      )
    }
    const penaltyOutstanding = state.contributionPeriods.reduce(
      (acc, p) => acc.plus(Prisma.Decimal.max(0, p.penaltyAssessed.minus(p.penaltyPaid).minus(p.penaltyWaived))),
      ZERO,
    )
    const held = Prisma.Decimal.max(
      0,
      await getEAjoParticipantLedgerBalance(tx, state.id, LedgerAccountType.EAJO_CONTRIBUTION_LIABILITY),
    )

    // OQ-18 (owner decision): unpaid late fees block cancellation unless the admin chooses to deduct
    // them from the contributions held; the remainder is refunded to the wallet.
    if (penaltyOutstanding.gt(0)) {
      if (!params.deductPenalties) {
        throw new AppError(
          'PENALTIES_OUTSTANDING',
          `This member can't leave the group until their late fees of ₦${penaltyOutstanding.toFixed(2)} are paid.`,
          { statusCode: 409 },
        )
      }
      if (held.lt(penaltyOutstanding)) {
        throw new AppError(
          'INSUFFICIENT_CONTRIBUTIONS',
          `The member's contributions (₦${held.toFixed(2)}) are less than the late fees owed (₦${penaltyOutstanding.toFixed(2)}). The fees must be paid before they can leave.`,
          { statusCode: 409 },
        )
      }
      // Settle the fees, oldest period first
      for (const p of state.contributionPeriods) {
        const owed = Prisma.Decimal.max(0, p.penaltyAssessed.minus(p.penaltyPaid).minus(p.penaltyWaived))
        if (owed.gt(0)) {
          await tx.eAjoContributionPeriod.update({ where: { id: p.id }, data: { penaltyPaid: { increment: owed } } })
        }
      }
      penaltiesDeducted = roundMoney(penaltyOutstanding)
    }

    refunded = roundMoney(held.minus(penaltiesDeducted))
    if (held.gt(0)) {
      const lines: JournalLineInput[] = [
        {
          accountType: LedgerAccountType.EAJO_CONTRIBUTION_LIABILITY,
          debit: held,
          credit: 0,
          memberId: state.userId,
          accountRefType: 'EAJO_MEMBER',
          accountRefId: state.id,
        },
      ]
      if (penaltiesDeducted.gt(0)) {
        lines.push({
          accountType: LedgerAccountType.EAJO_PENALTY_RECEIVABLE,
          debit: 0,
          credit: penaltiesDeducted,
          memberId: state.userId,
          accountRefType: 'EAJO_MEMBER',
          accountRefId: state.id,
        })
      }
      if (refunded.gt(0)) {
        lines.push({
          accountType: LedgerAccountType.MEMBER_WALLET_LIABILITY,
          debit: 0,
          credit: refunded,
          memberId: state.userId,
          accountRefType: 'WALLET',
          accountRefId: state.userId,
        })
      }
      const entry = await postJournalEntry(tx, {
        sourceType: 'EAJO_CANCELLATION',
        sourceId: state.id,
        idempotencyKey: `eajo-cancel-refund:${state.id}`,
        description: penaltiesDeducted.gt(0)
          ? 'E-ajo participation cancelled before payout: late fees deducted, remaining contributions returned to wallet'
          : 'E-ajo participation cancelled before payout: contributions returned to wallet',
        effectiveDate: parseDateOnly(lagosToday()),
        postedById: params.actor.id,
        reason,
        lines,
      })
      journalEntryId = entry.id
    }

    await transition(tx.eAjoPayout, payout.id, payout.status, {
      status: EAjoPayoutStatus.CANCELLED,
      cancelledAt: new Date(),
    })
    await transition(tx.eAjoMember, state.id, EAjoMemberStatus.ACTIVE, {
      status: EAjoMemberStatus.CANCELLED,
      cancelledAt: new Date(),
      cancelledById: params.actor.id,
      cancellationReason: reason,
    })
  } else {
    throw new AppError('STALE_STATE', `A ${state.status} participant cannot be cancelled.`, { statusCode: 409 })
  }

  await releaseEAjoReservations(tx, state.id, 'E-ajo participation cancelled')

  await recordAuditEvent(
    {
      actorId: params.actor.id,
      actorRole: params.actor.role,
      affectedUserId: state.userId,
      action: AuditAction.EAJO_PARTICIPANT_CANCELLED,
      entityType: 'EAjoMember',
      entityId: state.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: {
        groupId: state.groupId,
        previousStatus: state.status,
        refundedToWallet: refunded.toFixed(2),
        penaltiesDeducted: penaltiesDeducted.toFixed(2),
        journalEntryId,
        reason,
      },
    },
    tx,
  )

  if (state.status === EAjoMemberStatus.ACTIVE) {
    await completeEAjoGroupIfFinished(tx, state.groupId, params.actor.id)
  }

  return { refundedToWallet: refunded, penaltiesDeducted, journalEntryId }
}

// ---------------------------------------------------------------------------
// Payout: hold, approve, record paid
// ---------------------------------------------------------------------------

async function loadPayout(tx: Tx, payoutId: string) {
  const payout = await tx.eAjoPayout.findUnique({
    where: { id: payoutId },
    include: { eajoMember: { include: { group: true } } },
  })
  if (!payout) throw new AppError('NOT_FOUND', 'E-ajo payout not found.', { statusCode: 404 })
  return payout
}

export async function holdEAjoPayout(tx: Tx, params: { payoutId: string; actor: EAjoActorRef; reason: string }) {
  const reason = params.reason?.trim()
  if (!reason) throw new AppError('REASON_REQUIRED', 'A reason is required to hold a payout.', { statusCode: 422 })
  const payout = await loadPayout(tx, params.payoutId)
  await lockMembers(tx, [payout.eajoMember.userId])
  await transition(
    tx.eAjoPayout,
    payout.id,
    [EAjoPayoutStatus.NOT_ELIGIBLE, EAjoPayoutStatus.ELIGIBLE],
    { status: EAjoPayoutStatus.HELD, heldAt: new Date(), heldById: params.actor.id, holdReason: reason },
    'Only a payout that has not been approved can be put on hold.',
  )
  await recordAuditEvent(
    {
      actorId: params.actor.id,
      actorRole: params.actor.role,
      affectedUserId: payout.eajoMember.userId,
      action: AuditAction.EAJO_PAYOUT_HELD,
      entityType: 'EAjoPayout',
      entityId: payout.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: { reason, previousStatus: payout.status },
    },
    tx,
  )
}

export async function releaseEAjoPayoutHold(
  tx: Tx,
  params: { payoutId: string; actor: EAjoActorRef; today?: string },
) {
  const payout = await loadPayout(tx, params.payoutId)
  await lockMembers(tx, [payout.eajoMember.userId])
  await transition(
    tx.eAjoPayout,
    payout.id,
    EAjoPayoutStatus.HELD,
    { status: EAjoPayoutStatus.NOT_ELIGIBLE, heldAt: null, heldById: null, holdReason: null },
    'This payout is not on hold.',
  )
  await recordAuditEvent(
    {
      actorId: params.actor.id,
      actorRole: params.actor.role,
      affectedUserId: payout.eajoMember.userId,
      action: AuditAction.EAJO_PAYOUT_HOLD_RELEASED,
      entityType: 'EAjoPayout',
      entityId: payout.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: {},
    },
    tx,
  )
  await refreshEAjoParticipant(tx, payout.eajoMemberId, { today: params.today, actorId: params.actor.id })
}

/**
 * Staff with EAJO_PAYOUTS_MANAGE approve an ELIGIBLE payout (§2.8 rule 4). Eligibility is
 * re-checked live. An approved EAJO_PAYOUT disbursement is created for the participant's verified
 * bank account; it is paid only through `recordEAjoPayoutPaid` (never the generic disbursement flow).
 */
export async function approveEAjoPayout(
  tx: Tx,
  params: { payoutId: string; actor: EAjoActorRef; today?: string },
) {
  const today = params.today ?? lagosToday()
  const first = await loadPayout(tx, params.payoutId)
  await lockMembers(tx, [first.eajoMember.userId])

  // Re-derive eligibility from the participant's current periods before approving
  await refreshEAjoParticipant(tx, first.eajoMemberId, { today, actorId: params.actor.id })
  const payout = await loadPayout(tx, params.payoutId)
  if (payout.eajoMember.status !== EAjoMemberStatus.ACTIVE) {
    throw new AppError('STALE_STATE', 'This participant is not active.', { statusCode: 409 })
  }
  if (payout.status !== EAjoPayoutStatus.ELIGIBLE) {
    const evaluation = await getEAjoPayoutEligibility(tx, payout.eajoMemberId, today)
    throw new AppError(
      'PAYOUT_NOT_ELIGIBLE',
      payout.status === EAjoPayoutStatus.NOT_ELIGIBLE
        ? `Payout is not eligible yet: ${evaluation.reason ?? 'conditions not met'}`
        : `Payout is ${payout.status} and cannot be approved.`,
      { statusCode: 409 },
    )
  }

  const bankAccounts = await tx.bankAccount.findMany({
    where: { userId: payout.eajoMember.userId, isVerified: true },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  })
  const bankAccount = bankAccounts[0]
  if (!bankAccount) {
    throw new AppError(
      'NO_VERIFIED_BANK_ACCOUNT',
      'The member has no verified bank account to receive the payout.',
      { statusCode: 422 },
    )
  }

  await lockSequence(tx, 'DSB') // shared with loan and savings disbursements (P3-03/P3-04)
  const lastDisbursement = await tx.disbursement.findFirst({
    orderBy: { disbursementNumber: 'desc' },
    select: { disbursementNumber: true },
  })
  const disbursement = await tx.disbursement.create({
    data: {
      disbursementNumber: formatSequentialNumber('DSB', nextSequenceAfter(lastDisbursement?.disbursementNumber)),
      recipientUserId: payout.eajoMember.userId,
      purpose: DisbursementPurpose.EAJO_PAYOUT,
      amount: payout.netPayout,
      bankAccountId: bankAccount.id,
      valueDate: parseDateOnly(today),
      status: DisbursementStatus.APPROVED,
      requestedById: params.actor.id,
      approvedById: params.actor.id,
      idempotencyKey: `eajo-payout:${payout.id}`,
    },
  })

  await transition(tx.eAjoPayout, payout.id, EAjoPayoutStatus.ELIGIBLE, {
    status: EAjoPayoutStatus.APPROVED,
    approvedAt: new Date(),
    approvedById: params.actor.id,
    disbursementId: disbursement.id,
  })

  await recordAuditEvent(
    {
      actorId: params.actor.id,
      actorRole: params.actor.role,
      affectedUserId: payout.eajoMember.userId,
      action: AuditAction.EAJO_PAYOUT_APPROVED,
      entityType: 'EAjoPayout',
      entityId: payout.id,
      outcome: AuditOutcome.SUCCESS,
      metadata: {
        disbursementId: disbursement.id,
        disbursementNumber: disbursement.disbursementNumber,
        netPayout: payout.netPayout.toFixed(2),
      },
    },
    tx,
  )

  return { payoutId: payout.id, disbursement }
}

export interface RecordEAjoPayoutPaidParams {
  payoutId: string
  actor: StaffActor
  valueDate: string | Date
  bankReference: string
  evidenceFileId: string
  today?: string
}

/**
 * Records the offline payout (§2.8 rule 4, §2.12, Appendix C4) under dual control (A-19): the
 * staff member recording the payment must differ from the approver when two eligible staff exist.
 *
 * Journal: Dr EAJO_CONTRIBUTION_LIABILITY (contributions actually held for the participant)
 *          Dr EAJO_ADVANCE_RECEIVABLE    (c × N − held)
 *          Cr COOPERATIVE_CASH           (netPayout)
 *          Cr EAJO_EARLY_SLOT_INCOME     (earlySlotPenalty — applied exactly once, here)
 * With exactly c × s held this is the C4 posting; a participant who paid ahead has a smaller
 * advance, and every later contribution clears the advance receivable to zero.
 */
export async function recordEAjoPayoutPaid(tx: Tx, params: RecordEAjoPayoutPaidParams) {
  const today = params.today ?? lagosToday()
  const bankReference = params.bankReference?.trim()
  if (!bankReference) {
    throw new AppError('BANK_REFERENCE_REQUIRED', 'Enter the bank transfer reference.', {
      statusCode: 422,
      fieldErrors: { bankReference: ['Required'] },
    })
  }
  if (!params.evidenceFileId) {
    throw new AppError('EVIDENCE_REQUIRED', 'Upload the transfer evidence.', {
      statusCode: 422,
      fieldErrors: { evidence: ['Required'] },
    })
  }

  const first = await loadPayout(tx, params.payoutId)
  await lockMembers(tx, [first.eajoMember.userId])
  const payout = await loadPayout(tx, params.payoutId)

  if (payout.status === EAjoPayoutStatus.PAID) {
    return { payoutId: payout.id, journalEntryId: payout.journalEntryId, isReplay: true, singleOperator: false }
  }
  if (payout.status !== EAjoPayoutStatus.APPROVED || !payout.disbursementId) {
    throw new AppError('STALE_STATE', `Payout is ${payout.status}; approve it before recording the payment.`, {
      statusCode: 409,
    })
  }

  const dual = await enforceDualControl(
    {
      actor: params.actor,
      previousActorId: payout.approvedById,
      requiredPermission: AdminPermission.EAJO_PAYOUTS_MANAGE,
    },
    tx as unknown as typeof prisma,
  )

  const valueDate = dateOnly(params.valueDate)
  const valueKey = lagosDateKey(valueDate)
  if (valueKey > today) {
    throw new AppError('INVALID_VALUE_DATE', 'The payout value date cannot be in the future.', {
      statusCode: 422,
      fieldErrors: { valueDate: ['Cannot be in the future'] },
    })
  }
  if (payout.payoutDueDate && valueKey < lagosDateKey(payout.payoutDueDate)) {
    throw new AppError('INVALID_VALUE_DATE', 'The payout value date cannot be before the payout month.', {
      statusCode: 422,
      fieldErrors: { valueDate: ['Before the payout month'] },
    })
  }

  const evidence = await tx.storedFile.findUnique({ where: { id: params.evidenceFileId } })
  if (!evidence || evidence.uploadedById !== params.actor.id) {
    throw new AppError('EVIDENCE_INVALID', 'The evidence file was not found.', { statusCode: 422 })
  }

  const held = Prisma.Decimal.max(
    0,
    await getEAjoParticipantLedgerBalance(tx, payout.eajoMemberId, LedgerAccountType.EAJO_CONTRIBUTION_LIABILITY),
  )
  const advancePortion = roundMoney(payout.expectedPayout.minus(held))
  if (advancePortion.lt(0)) {
    throw new AppError('LEDGER_MISMATCH', 'Contributions held exceed the expected payout; refer to the owner.', {
      statusCode: 409,
    })
  }

  const entry = await postEajoPayout(tx, {
    memberId: payout.eajoMember.userId,
    eAjoMemberId: payout.eajoMemberId,
    contributionsHeld: held,
    advanceAmount: advancePortion,
    netPayout: payout.netPayout,
    earlySlotPenalty: payout.earlySlotPenalty,
    effectiveDate: valueDate,
    idempotencyKey: `eajo-payout-paid:${payout.id}`,
    postedById: params.actor.id,
    description: `E-ajo payout (slot ${payout.eajoMember.payoutPosition}) for ${payout.eajoMember.group.title}`,
  })

  await transition(
    tx.disbursement,
    payout.disbursementId,
    DisbursementStatus.APPROVED,
    {
      status: DisbursementStatus.PAID,
      disbursedById: params.actor.id,
      disbursedAt: new Date(),
      bankReference,
      valueDate,
      journalEntryId: entry.id,
    },
  )

  await transition(tx.eAjoPayout, payout.id, EAjoPayoutStatus.APPROVED, {
    status: EAjoPayoutStatus.PAID,
    disbursedAt: valueDate,
    disbursedById: params.actor.id,
    disbursementReference: bankReference,
    disbursementEvidenceFileId: evidence.id,
    contributionsHeldAtPayout: held,
    journalEntryId: entry.id,
  })

  await tx.storedFile.update({
    where: { id: evidence.id },
    data: { associatedType: 'EAJO_PAYOUT', associatedId: payout.id, ownerUserId: payout.eajoMember.userId },
  })

  await tx.eAjoMember.update({
    where: { id: payout.eajoMemberId },
    data: { hasReceivedPayout: true, payoutDate: valueDate },
  })

  await recordAuditEvent(
    {
      actorId: params.actor.id,
      actorRole: params.actor.role,
      affectedUserId: payout.eajoMember.userId,
      action: AuditAction.EAJO_PAYOUT_EXECUTED,
      entityType: 'EAjoPayout',
      entityId: payout.id,
      outcome: AuditOutcome.SUCCESS,
      isSingleOperator: dual.singleOperator,
      metadata: {
        disbursementId: payout.disbursementId,
        valueDate: valueKey,
        bankReference,
        netPayout: payout.netPayout.toFixed(2),
        earlySlotPenalty: payout.earlySlotPenalty.toFixed(2),
        contributionsHeld: held.toFixed(2),
        advanceReceivable: advancePortion.toFixed(2),
        journalEntryId: entry.id,
      },
    },
    tx,
  )

  await refreshEAjoParticipant(tx, payout.eajoMemberId, { today, actorId: params.actor.id })

  return { payoutId: payout.id, journalEntryId: entry.id, isReplay: false, singleOperator: dual.singleOperator }
}

// ---------------------------------------------------------------------------
// Late penalties (§2.3) — the e-ajo part of the penalty job
// ---------------------------------------------------------------------------

/**
 * Writes every missing daily late penalty for one participant up to `throughDate` (a completed
 * Lagos day, normally yesterday), with cap, grace and review shield. Idempotent: the unique key
 * `(eajoContributionPeriodId, penaltyDate)` and the journal idempotency key prevent duplicates.
 * Value-date reversal of accruals that a later backdated payment invalidates is P3-06's
 * `recalculateLateness()`.
 */
export async function accrueEAjoPenaltiesForParticipant(
  tx: Tx,
  params: { eajoMemberId: string; throughDate: string; actorId?: string | null; today?: string },
) {
  const participant = await tx.eAjoMember.findUnique({
    where: { id: params.eajoMemberId },
    include: { group: true, contributionPeriods: { include: { penalties: true } } },
  })
  if (!participant || participant.status !== EAjoMemberStatus.ACTIVE) return { accrued: 0, total: ZERO }
  if (
    participant.latePenaltyDailyPercent === null ||
    participant.penaltyCapType === null ||
    participant.penaltyCapValue === null
  ) {
    return { accrued: 0, total: ZERO }
  }

  const periodIds = participant.contributionPeriods.map((p) => p.id)
  const allocations = await tx.paymentAllocation.findMany({
    where: {
      targetType: AllocationTargetType.EAJO,
      periodId: { in: periodIds },
      componentType: PaymentComponentType.CONTRIBUTION,
      status: AllocationStatus.ACTIVE,
      payment: { status: PaymentStatus.CONFIRMED },
    },
    include: { payment: { select: { valueDate: true } } },
  })
  const shieldTargets = await tx.submissionTarget.findMany({
    where: {
      targetType: AllocationTargetType.EAJO,
      OR: [{ targetPeriodId: { in: periodIds } }, { targetId: participant.id, targetPeriodId: null }],
      submission: { status: PaymentSubmissionStatus.SUBMITTED },
    },
    include: { submission: { select: { paidOn: true } } },
  })

  const assessedNet = participant.contributionPeriods
    .flatMap((p) => p.penalties)
    .filter((a) => !a.reversedAt)
    .reduce((s, a) => s.plus(a.amount), ZERO)

  const plan = planEAjoPenaltyAccruals({
    terms: {
      latePenaltyDailyPercent: participant.latePenaltyDailyPercent,
      penaltyCapType: participant.penaltyCapType,
      penaltyCapValue: participant.penaltyCapValue,
      // Owner decision OQ-16: PERCENT_OF_PRINCIPAL cap base = c × N
      capBase: participant.group.contributionAmount.mul(participant.group.totalSlots),
    },
    penaltiesAssessedNet: assessedNet,
    throughDate: params.throughDate,
    periods: participant.contributionPeriods.map((p) => ({
      periodId: p.id,
      periodNumber: p.periodNumber,
      dueDate: p.dueDate,
      contributionDue: p.contributionDue,
      contributionAllocations: allocations
        .filter((a) => a.periodId === p.id)
        .map((a) => ({ amount: a.amount, valueDate: a.payment.valueDate })),
      accruedDates: p.penalties.map((a) => lagosDateKey(a.penaltyDate)),
      shieldPaidOnDates: shieldTargets
        .filter((t) => t.targetPeriodId === p.id || t.targetPeriodId === null)
        .map((t) => lagosDateKey(t.submission.paidOn)),
    })),
  })

  let total = ZERO
  for (const a of plan.accruals) {
    const entry = await postJournalEntry(tx, {
      sourceType: 'EAJO_PENALTY',
      sourceId: a.periodId,
      idempotencyKey: `eajo-penalty:${a.periodId}:${a.penaltyDate}`,
      description: `E-ajo late-payment penalty for ${a.penaltyDate}`,
      effectiveDate: parseDateOnly(a.penaltyDate),
      postedById: params.actorId ?? null,
      lines: [
        {
          accountType: LedgerAccountType.EAJO_PENALTY_RECEIVABLE,
          debit: a.amount,
          credit: 0,
          memberId: participant.userId,
          accountRefType: 'EAJO_MEMBER',
          accountRefId: participant.id,
        },
        { accountType: LedgerAccountType.PENALTY_INCOME, debit: 0, credit: a.amount },
      ],
    })
    await recordEAjoPenaltyAccrual(tx, {
      eajoContributionPeriodId: a.periodId,
      penaltyDate: a.penaltyDate,
      amount: a.amount,
      journalEntryId: entry.id,
    })
    total = total.plus(a.amount)
  }

  if (plan.accruals.length > 0) {
    await recordAuditEvent(
      {
        actorId: params.actorId ?? null,
        affectedUserId: participant.userId,
        action: AuditAction.EAJO_PENALTY_ACCRUED,
        entityType: 'EAjoMember',
        entityId: participant.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: {
          accruals: plan.accruals.length,
          total: total.toFixed(2),
          throughDate: params.throughDate,
          capReached: plan.capReached,
        },
      },
      tx,
    )
    await refreshEAjoParticipant(tx, participant.id, { today: params.today, actorId: params.actorId })
  }

  return { accrued: plan.accruals.length, total: roundMoney(total) }
}

/** Yesterday in Lagos: the last completed day a daily penalty can be assessed for. */
export function lastCompletedLagosDay(today: string = lagosToday()): string {
  return lagosDateKey(addDays(parseDateOnly(today), -1))
}

// ---------------------------------------------------------------------------
// Member entry points (wrapping their own transactions)
// ---------------------------------------------------------------------------

/** Resolves the guarantor by email and joins inside one transaction. */
export async function applyToEAjoGroup(params: {
  memberId: string
  groupId: string
  slotNumber: number
  guarantorEmail: string
  actor: EAjoActorRef
}) {
  const email = params.guarantorEmail?.trim().toLowerCase()
  if (!email) {
    throw new AppError('GUARANTOR_REQUIRED', 'Enter the email address of a member who will guarantee you.', {
      statusCode: 422,
      fieldErrors: { guarantorEmail: ['Required'] },
    })
  }
  const guarantor = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } })
  if (!guarantor || guarantor.role !== UserRole.USER) {
    throw new AppError('GUARANTOR_NOT_FOUND', 'No cooperative member was found with that email.', {
      statusCode: 422,
      fieldErrors: { guarantorEmail: ['Not a member'] },
    })
  }
  const res = await prisma.$transaction((tx) =>
    joinEAjoGroup(tx, {
      memberId: params.memberId,
      groupId: params.groupId,
      slotNumber: params.slotNumber,
      guarantorId: guarantor.id,
      actor: params.actor,
    }),
  )
  return {
    id: res.participant.id,
    status: res.participant.status,
    slotNumber: res.participant.payoutPosition,
    netPayout: res.preview.netPayout.toFixed(2),
  }
}

/**
 * Creates a payment submission for a member's own contribution periods (§2.10). The targets ask
 * for each selected period's outstanding amount (penalty first, then contribution, at confirmation).
 */
export async function applyEAjoContribution(params: {
  memberId: string
  eajoMemberId: string
  amount: number
  paidOn: string
  receiptFileId: string
  periodIds: string[]
  bankReference?: string
  narration?: string
  actorId: string
}) {
  const participant = await prisma.eAjoMember.findFirst({
    where: { id: params.eajoMemberId, userId: params.memberId },
    include: { contributionPeriods: { orderBy: { periodNumber: 'asc' } } },
  })
  if (!participant) throw new AppError('NOT_FOUND', 'E-ajo participation not found.', { statusCode: 404 })
  if (participant.status !== EAjoMemberStatus.ACTIVE) {
    throw new AppError('NOT_ACTIVE', 'Contributions open once the group is active.', { statusCode: 409 })
  }
  const selected = participant.contributionPeriods.filter((p) => params.periodIds.includes(p.id))
  if (selected.length === 0 || selected.length !== new Set(params.periodIds).size) {
    throw new AppError('VALIDATION_ERROR', 'Select at least one of your contribution months.', {
      statusCode: 422,
      fieldErrors: { periodIds: ['Select a month'] },
    })
  }
  const outstanding = (p: (typeof selected)[number]) =>
    roundMoney(
      Prisma.Decimal.max(0, p.contributionDue.minus(p.contributionPaid)).plus(
        Prisma.Decimal.max(0, p.penaltyAssessed.minus(p.penaltyPaid).minus(p.penaltyWaived)),
      ),
    )
  const targets = selected.filter((p) => outstanding(p).gt(0))
  if (targets.length === 0) {
    throw new AppError('NOTHING_OUTSTANDING', 'The selected months are already paid.', { statusCode: 422 })
  }

  const receipt = await prisma.storedFile.findUnique({ where: { id: params.receiptFileId } })
  if (!receipt || (receipt.ownerUserId !== params.memberId && receipt.uploadedById !== params.actorId)) {
    throw new AppError('RECEIPT_REQUIRED', 'Upload the payment receipt.', {
      statusCode: 422,
      fieldErrors: { receipt: ['Required'] },
    })
  }

  const { createPaymentSubmission } = await import('@/lib/services/payments.service')
  const result = await createPaymentSubmission({
    memberId: params.memberId,
    claimedAmount: params.amount,
    paidOn: params.paidOn,
    purpose: 'EAJO_CONTRIBUTION',
    receiptFileId: receipt.id,
    bankReference: params.bankReference?.trim() || undefined,
    narration: params.narration?.trim() || undefined,
    targets: targets.map((p) => ({
      targetType: AllocationTargetType.EAJO,
      targetId: participant.id,
      targetPeriodId: p.id,
      requestedAmount: outstanding(p),
    })),
  })
  await prisma.storedFile.update({
    where: { id: receipt.id },
    data: { associatedType: 'PAYMENT_SUBMISSION', associatedId: result.submission.id },
  })
  return result
}
