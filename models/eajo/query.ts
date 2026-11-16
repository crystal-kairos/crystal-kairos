import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import {
  AdminPermission,
  AllocationStatus,
  AllocationTargetType,
  EAjoMemberStatus,
  EAjoPayoutStatus,
  EAjoStatus,
  GuaranteeType,
  PaymentPeriodStatus,
  PaymentStatus,
  PaymentSubmissionStatus,
} from '@/generated/prisma/enums'
import {
  requireAnyPermission,
  requireAuthenticatedSession,
  requireMemberOrStaffWithPermission,
} from '@/lib/authz/guards'
import { addMonthsClamped, lagosToday, toLagosDateString } from '@/lib/domain/dates'
import {
  buildEAjoSlotPreviews,
  calculateEAjoFundingSchedule,
  evaluateEAjoPayoutEligibility,
} from '@/lib/domain/eajo-payout'
import { computePeriodStatus } from '@/lib/services/schedules.service'
import { getWalletSummary } from '@/lib/services/wallet.service'
import { summarizePaymentBreakdown } from '@/lib/services/allocation.service'

/*
 * E-ajo read models (PR P3-05). Money leaves this file as numbers for display only; every
 * calculation that matters runs on Prisma.Decimal in lib/domain and lib/services.
 * Members never see other participants' identities (§1.5).
 */

const n = (d: Prisma.Decimal | number | null | undefined) => (d === null || d === undefined ? 0 : Number(d))
const dateKey = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)
const ZERO = new Prisma.Decimal(0)

const SLOT_OCCUPYING: EAjoMemberStatus[] = [
  EAjoMemberStatus.PENDING,
  EAjoMemberStatus.APPROVED,
  EAjoMemberStatus.ACTIVE,
  EAjoMemberStatus.COMPLETED,
]

function slotOccupancy(members: { payoutPosition: number; status: EAjoMemberStatus }[], totalSlots: number) {
  const counts = Array.from({ length: totalSlots }, () => 0)
  for (const m of members) {
    if (SLOT_OCCUPYING.includes(m.status) && m.payoutPosition >= 1 && m.payoutPosition <= totalSlots) {
      counts[m.payoutPosition - 1]++
    }
  }
  return counts
}

/** Groups accepting applications (PENDING), with per-slot occupancy only. */
export const getOpenEAjoGroups = async () => {
  try {
    await requireAuthenticatedSession()
    const groups = await prisma.eAjoGroup.findMany({
      where: { status: EAjoStatus.PENDING },
      orderBy: { createdAt: 'desc' },
      include: { members: { select: { payoutPosition: true, status: true } } },
    })
    const data = groups.map((g) => {
      const occupancy = slotOccupancy(g.members, g.totalSlots)
      const fullSlots =
        g.maxMembersPerSlot === null ? 0 : occupancy.filter((c) => c >= (g.maxMembersPerSlot ?? Infinity)).length
      return {
        id: g.id,
        title: g.title,
        description: g.description,
        contributionAmount: n(g.contributionAmount),
        totalSlots: g.totalSlots,
        startDate: dateKey(g.startDate),
        maxMembersPerSlot: g.maxMembersPerSlot,
        applicants: occupancy.reduce((a, b) => a + b, 0),
        availableSlots: g.totalSlots - fullSlots,
        expectedPayout: n(g.contributionAmount) * g.totalSlots,
      }
    })
    return { success: true, data }
  } catch (error) {
    return { success: false, data: [], error: (error as Error).message }
  }
}

/** Join flow: every slot with payout month, expected payout, early-slot penalty and net payout. */
export const getEAjoGroupForJoin = async (groupId: string) => {
  try {
    await requireAuthenticatedSession()
    const group = await prisma.eAjoGroup.findUnique({
      where: { id: groupId },
      include: { slotPolicies: true, members: { select: { payoutPosition: true, status: true } } },
    })
    if (!group || group.status !== EAjoStatus.PENDING) {
      return { success: false, data: null, error: 'Group not found or not accepting applications.' }
    }
    const previews = buildEAjoSlotPreviews({
      monthlyContribution: group.contributionAmount,
      totalSlots: group.totalSlots,
      slotPolicies: group.slotPolicies,
    })
    const occupancy = slotOccupancy(group.members, group.totalSlots)
    return {
      success: true,
      data: {
        id: group.id,
        title: group.title,
        description: group.description,
        contributionAmount: n(group.contributionAmount),
        totalSlots: group.totalSlots,
        startDate: dateKey(group.startDate),
        maxMembersPerSlot: group.maxMembersPerSlot,
        latePenaltyDailyPercent: n(group.latePenaltyDailyPercent),
        penaltyCapType: group.penaltyCapType,
        penaltyCapValue: n(group.penaltyCapValue),
        slots: previews.map((p) => ({
          slotNumber: p.slotNumber,
          // Indicative until activation fixes the start date
          payoutMonth: group.startDate ? toLagosDateString(addMonthsClamped(group.startDate, p.slotNumber - 1)) : null,
          expectedPayout: n(p.expectedPayout),
          advanceAmount: n(p.advanceAmount),
          earlySlotPenaltyPercent: n(p.earlySlotPenaltyPercent),
          earlySlotPenalty: n(p.earlySlotPenalty),
          netPayout: n(p.netPayout),
          taken: occupancy[p.slotNumber - 1],
          isFull: group.maxMembersPerSlot !== null && occupancy[p.slotNumber - 1] >= group.maxMembersPerSlot,
        })),
      },
    }
  } catch (error) {
    return { success: false, data: null, error: (error as Error).message }
  }
}

type PeriodRow = {
  id: string
  periodNumber: number
  dueDate: Date
  contributionDue: Prisma.Decimal
  contributionPaid: Prisma.Decimal
  penaltyAssessed: Prisma.Decimal
  penaltyPaid: Prisma.Decimal
  penaltyWaived: Prisma.Decimal
}

function periodView(p: PeriodRow, inReviewPeriodIds: Set<string>, today: string) {
  const contributionOutstanding = Prisma.Decimal.max(0, p.contributionDue.minus(p.contributionPaid))
  const penaltyOutstanding = Prisma.Decimal.max(0, p.penaltyAssessed.minus(p.penaltyPaid).minus(p.penaltyWaived))
  const totalOutstanding = contributionOutstanding.plus(penaltyOutstanding)
  const inReview = inReviewPeriodIds.has(p.id)
  const status = computePeriodStatus({
    dueDate: p.dueDate,
    totalOutstanding,
    totalPaid: p.contributionPaid.plus(p.penaltyPaid),
    isShielded: inReview,
    today,
  })
  return {
    id: p.id,
    periodNumber: p.periodNumber,
    dueDate: dateKey(p.dueDate)!,
    contributionDue: n(p.contributionDue),
    contributionPaid: n(p.contributionPaid),
    penaltyAssessed: n(p.penaltyAssessed),
    penaltyOutstanding: n(penaltyOutstanding),
    totalOutstanding: n(totalOutstanding),
    inReview,
    status: inReview && status !== PaymentPeriodStatus.COMPLETED ? PaymentPeriodStatus.IN_REVIEW : status,
  }
}

async function inReviewPeriods(periodIds: string[]) {
  if (periodIds.length === 0) return new Set<string>()
  const targets = await prisma.submissionTarget.findMany({
    where: {
      targetType: AllocationTargetType.EAJO,
      targetPeriodId: { in: periodIds },
      submission: { status: PaymentSubmissionStatus.SUBMITTED },
    },
    select: { targetPeriodId: true },
  })
  return new Set(targets.map((t) => t.targetPeriodId!).filter(Boolean))
}

/** A member's own participations with periods, payout and guarantee state. */
export const getUserEAjoMemberships = async (userId: string) => {
  try {
    await requireMemberOrStaffWithPermission(userId, [
      AdminPermission.EAJO_READ,
      AdminPermission.EAJO_MANAGE,
      AdminPermission.EAJO_PAYMENTS_REVIEW,
      AdminPermission.EAJO_PAYOUTS_MANAGE,
      AdminPermission.MEMBERS_READ,
    ])
    const today = lagosToday()
    const memberships = await prisma.eAjoMember.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        group: { select: { id: true, title: true, contributionAmount: true, totalSlots: true, status: true, startDate: true } },
        contributionPeriods: { orderBy: { periodNumber: 'asc' } },
        payout: true,
        guaranteeReservations: {
          where: { guaranteeType: GuaranteeType.EAJO },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { guarantor: { select: { name: true } } },
        },
      },
    })
    const reviewSet = await inReviewPeriods(memberships.flatMap((m) => m.contributionPeriods.map((p) => p.id)))
    const walletSummary = await getWalletSummary(userId, prisma)
    const membershipIds = memberships.map((m) => m.id)
    const confirmedPayments = membershipIds.length
      ? await prisma.payment.findMany({
          where: {
            memberId: userId,
            status: PaymentStatus.CONFIRMED,
            allocations: {
              some: {
                targetType: AllocationTargetType.EAJO,
                targetId: { in: membershipIds },
                status: AllocationStatus.ACTIVE,
              },
            },
          },
          orderBy: { valueDate: 'desc' },
          include: {
            allocations: {
              where: {
                targetType: AllocationTargetType.EAJO,
                status: AllocationStatus.ACTIVE,
              },
            },
          },
        })
      : []

    const data = memberships.map((m) => {
      const periods = m.contributionPeriods.map((p) => periodView(p, reviewSet, today))
      const eligibility =
        m.payout && (m.payout.status === EAjoPayoutStatus.NOT_ELIGIBLE || m.payout.status === EAjoPayoutStatus.ELIGIBLE)
          ? evaluateEAjoPayoutEligibility({
              slotNumber: m.payoutPosition,
              periods: m.contributionPeriods.map((p) => ({
                periodNumber: p.periodNumber,
                dueDate: p.dueDate,
                contributionDue: p.contributionDue,
                contributionPaid: p.contributionPaid,
                penaltyOutstanding: Prisma.Decimal.max(0, p.penaltyAssessed.minus(p.penaltyPaid).minus(p.penaltyWaived)),
              })),
              today,
            })
          : null
      const guarantee = m.guaranteeReservations[0]
      const mPayments = confirmedPayments
        .map((p) => {
          const mAllocs = p.allocations.filter((a) => a.targetId === m.id)
          if (mAllocs.length === 0) return null
          return {
            id: p.id,
            paymentNumber: p.paymentNumber,
            source: p.source,
            valueDate: dateKey(p.valueDate)!,
            breakdown: summarizePaymentBreakdown(mAllocs),
          }
        })
        .filter(Boolean) as Array<{
        id: string
        paymentNumber: string
        source: string
        valueDate: string
        breakdown: ReturnType<typeof summarizePaymentBreakdown>
      }>

      return {
        id: m.id,
        status: m.status,
        slotNumber: m.payoutPosition,
        rejectionReason: m.rejectionReason,
        cancellationReason: m.cancellationReason,
        availableWallet: n(walletSummary.availableBalance),
        walletSummary: {
          totalBalance: n(walletSummary.totalBalance),
          heldBalance: n(walletSummary.heldBalance),
          availableBalance: n(walletSummary.availableBalance),
        },
        group: {
          id: m.group.id,
          title: m.group.title,
          contributionAmount: n(m.group.contributionAmount),
          totalSlots: m.group.totalSlots,
          status: m.group.status,
          startDate: dateKey(m.group.startDate),
        },
        preview: {
          expectedPayout: n(m.totalExpectedPayout),
          earlySlotPenaltyPercent: n(m.earlySlotPenaltyPercent),
          earlySlotPenalty: n(m.feeAmount),
          netPayout: n(m.netPayoutAmount),
        },
        payout: m.payout
          ? {
              id: m.payout.id,
              status: m.payout.status,
              expectedPayout: n(m.payout.expectedPayout),
              advanceAmount: n(m.payout.advanceAmount),
              earlySlotPenalty: n(m.payout.earlySlotPenalty),
              netPayout: n(m.payout.netPayout),
              payoutDueDate: dateKey(m.payout.payoutDueDate),
              paidOn: dateKey(m.payout.disbursedAt),
              evidenceFileId: m.payout.disbursementEvidenceFileId,
              eligibilityReason: eligibility?.reason ?? null,
            }
          : null,
        guarantee: guarantee
          ? { guarantorName: guarantee.guarantor.name, state: guarantee.state, reservedAmount: n(guarantee.reservedAmount) }
          : null,
        periods,
        payments: mPayments,
        totals: {
          confirmed: periods.reduce((s, p) => s + p.contributionPaid, 0),
          outstanding: periods.filter((p) => p.dueDate <= today).reduce((s, p) => s + p.totalOutstanding, 0),
          overdueCount: periods.filter((p) => p.status === PaymentPeriodStatus.OVERDUE).length,
        },
      }
    })
    return { success: true, data }
  } catch (error) {
    return { success: false, data: [], error: (error as Error).message }
  }
}

/** E-ajo guarantee requests addressed to this member (as guarantor). */
export const getMyEAjoGuaranteeRequests = async (userId: string) => {
  try {
    const actor = await requireMemberOrStaffWithPermission(userId, [AdminPermission.EAJO_READ, AdminPermission.EAJO_MANAGE])
    const rows = await prisma.guaranteeReservation.findMany({
      where: { guarantorId: userId, guaranteeType: GuaranteeType.EAJO },
      orderBy: { createdAt: 'desc' },
      include: {
        applicant: { select: { name: true } },
        eajoMember: {
          select: {
            payoutPosition: true,
            status: true,
            group: { select: { title: true, contributionAmount: true, totalSlots: true } },
          },
        },
      },
    })
    return {
      success: true,
      viewerIsGuarantor: actor.id === userId,
      data: rows.map((r) => ({
        id: r.id,
        state: r.state,
        applicantName: r.applicant.name,
        groupTitle: r.eajoMember?.group.title ?? '',
        slotNumber: r.eajoMember?.payoutPosition ?? null,
        totalSlots: r.eajoMember?.group.totalSlots ?? null,
        contributionAmount: n(r.eajoMember?.group.contributionAmount),
        participantStatus: r.eajoMember?.status ?? null,
        amount: n(r.state === 'CONSENTED' ? r.reservedAmount : r.requestedAmount),
        createdAt: r.createdAt.toISOString(),
      })),
    }
  } catch (error) {
    return { success: false, viewerIsGuarantor: false, data: [], error: (error as Error).message }
  }
}

/**
 * Admin group dashboard (§2.8 rule 6, guide P3-05 "Admin dashboards"): participants by slot,
 * contributions confirmed/outstanding, overdue items, payouts and the monthly funding requirement.
 */
export const getAdminEAjoGroupDashboard = async (groupId: string) => {
  try {
    const actor = await requireAnyPermission([
      AdminPermission.EAJO_READ,
      AdminPermission.EAJO_MANAGE,
      AdminPermission.EAJO_PAYMENTS_REVIEW,
      AdminPermission.EAJO_PAYOUTS_MANAGE,
    ])
    const today = lagosToday()
    const group = await prisma.eAjoGroup.findUnique({
      where: { id: groupId },
      include: {
        slotPolicies: { orderBy: { slotNumber: 'asc' } },
        createdByUser: { select: { name: true } },
        members: {
          orderBy: [{ payoutPosition: 'asc' }, { createdAt: 'asc' }],
          include: {
            user: { select: { id: true, name: true, membership: { select: { membershipNumber: true } } } },
            contributionPeriods: { orderBy: { periodNumber: 'asc' } },
            payout: true,
            guaranteeReservations: {
              where: { guaranteeType: GuaranteeType.EAJO },
              orderBy: { createdAt: 'desc' },
              take: 1,
              include: { guarantor: { select: { name: true } } },
            },
          },
        },
      },
    })
    if (!group) return { success: false, data: null, error: 'Group not found.' }

    const allPeriodIds = group.members.flatMap((m) => m.contributionPeriods.map((p) => p.id))
    const reviewSet = await inReviewPeriods(allPeriodIds)

    const participants = group.members.map((m) => {
      const periods = m.contributionPeriods.map((p) => periodView(p, reviewSet, today))
      const eligibility = m.payout
        ? evaluateEAjoPayoutEligibility({
            slotNumber: m.payoutPosition,
            periods: m.contributionPeriods.map((p) => ({
              periodNumber: p.periodNumber,
              dueDate: p.dueDate,
              contributionDue: p.contributionDue,
              contributionPaid: p.contributionPaid,
              penaltyOutstanding: Prisma.Decimal.max(0, p.penaltyAssessed.minus(p.penaltyPaid).minus(p.penaltyWaived)),
            })),
            today,
          })
        : null
      const g = m.guaranteeReservations[0]
      return {
        id: m.id,
        userId: m.user.id,
        name: m.user.name,
        membershipNumber: m.user.membership?.membershipNumber ?? null,
        slotNumber: m.payoutPosition,
        status: m.status,
        rejectionReason: m.rejectionReason,
        cancellationReason: m.cancellationReason,
        appliedAt: m.createdAt.toISOString(),
        guarantee: g ? { guarantorName: g.guarantor.name, state: g.state, reservedAmount: n(g.reservedAmount) } : null,
        confirmed: periods.reduce((s, p) => s + p.contributionPaid, 0),
        outstandingDue: periods.filter((p) => p.dueDate <= today).reduce((s, p) => s + p.totalOutstanding, 0),
        penaltyOutstanding: periods.reduce((s, p) => s + p.penaltyOutstanding, 0),
        overdueMonths: periods.filter((p) => p.status === PaymentPeriodStatus.OVERDUE).map((p) => p.periodNumber),
        payout: m.payout
          ? {
              id: m.payout.id,
              status: m.payout.status,
              expectedPayout: n(m.payout.expectedPayout),
              advanceAmount: n(m.payout.advanceAmount),
              earlySlotPenalty: n(m.payout.earlySlotPenalty),
              netPayout: n(m.payout.netPayout),
              payoutDueDate: dateKey(m.payout.payoutDueDate),
              approvedById: m.payout.approvedById,
              holdReason: m.payout.holdReason,
              paidOn: dateKey(m.payout.disbursedAt),
              reference: m.payout.disbursementReference,
              eligibilityReason: eligibility && !eligibility.eligible ? eligibility.reason : null,
            }
          : null,
      }
    })

    const active = group.members.filter(
      (m) => m.status === EAjoMemberStatus.ACTIVE || m.status === EAjoMemberStatus.COMPLETED,
    )
    const monthDueDates = group.startDate
      ? Array.from({ length: group.totalSlots }, (_, i) => addMonthsClamped(group.startDate!, i))
      : []
    const funding = group.startDate
      ? calculateEAjoFundingSchedule({
          totalSlots: group.totalSlots,
          monthDueDates,
          participants: active.map((m) => ({
            slotNumber: m.payoutPosition,
            netPayout: m.payout?.netPayout ?? ZERO,
            periods: m.contributionPeriods,
          })),
        }).map((r) => ({
          month: r.month,
          dueDate: r.dueDate,
          payoutCount: r.payoutCount,
          payoutsDue: n(r.payoutsDue),
          expectedContributions: n(r.expectedContributions),
          confirmedContributions: n(r.confirmedContributions),
          fundingRequirement: n(r.fundingRequirement),
        }))
      : []

    const submissions = allPeriodIds.length
      ? await prisma.paymentSubmission.findMany({
          where: {
            status: PaymentSubmissionStatus.SUBMITTED,
            targets: { some: { targetType: AllocationTargetType.EAJO, targetId: { in: group.members.map((m) => m.id) } } },
          },
          orderBy: { submittedAt: 'asc' },
          include: { member: { select: { name: true } }, targets: true },
        })
      : []
    const periodNumberById = new Map(
      group.members.flatMap((m) => m.contributionPeriods.map((p) => [p.id, p.periodNumber] as const)),
    )

    const previews = buildEAjoSlotPreviews({
      monthlyContribution: group.contributionAmount,
      totalSlots: group.totalSlots,
      slotPolicies: group.slotPolicies,
    })

    return {
      success: true,
      data: {
        viewerId: actor.id,
        viewerRole: actor.role,
        permissions: actor.permissions,
        group: {
          id: group.id,
          title: group.title,
          description: group.description,
          status: group.status,
          contributionAmount: n(group.contributionAmount),
          totalSlots: group.totalSlots,
          maxMembersPerSlot: group.maxMembersPerSlot,
          minParticipants: group.minParticipants,
          latePenaltyDailyPercent: n(group.latePenaltyDailyPercent),
          penaltyCapType: group.penaltyCapType,
          penaltyCapValue: n(group.penaltyCapValue),
          startDate: dateKey(group.startDate),
          endDate: dateKey(group.endDate),
          createdBy: group.createdByUser.name,
        },
        slots: previews.map((p) => ({
          slotNumber: p.slotNumber,
          earlySlotPenaltyPercent: n(p.earlySlotPenaltyPercent),
          advanceAmount: n(p.advanceAmount),
          earlySlotPenalty: n(p.earlySlotPenalty),
          netPayout: n(p.netPayout),
        })),
        participants,
        funding,
        pendingContributions: submissions.map((s) => ({
          id: s.id,
          submissionNumber: s.submissionNumber,
          memberName: s.member.name,
          claimedAmount: n(s.claimedAmount),
          paidOn: dateKey(s.paidOn),
          bankReference: s.bankReference,
          receiptFileId: s.receiptFileId,
          months: s.targets
            .map((t) => (t.targetPeriodId ? periodNumberById.get(t.targetPeriodId) : undefined))
            .filter((x): x is number => x !== undefined)
            .sort((a, b) => a - b),
        })),
        today,
      },
    }
  } catch (error) {
    return { success: false, data: null, error: (error as Error).message }
  }
}
