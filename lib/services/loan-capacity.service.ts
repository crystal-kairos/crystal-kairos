import { Prisma } from '@/generated/prisma/client'
import { GuaranteeState, GuaranteeType, SavingsStatus } from '@/generated/prisma/enums'
import { prisma } from '@/lib/prisma'
import {
  calculateRequiredGuaranteeSupport,
  getBorrowerStandaloneLimit,
} from '@/lib/domain/capacity'
import { roundMoney, toDecimal, type DecimalValue } from '@/lib/domain/money'
import {
  LOAN_EXPOSURE_STATUSES,
  maxNewLoanPrincipal,
  principalOutstanding,
} from '@/lib/domain/loan-workflow'

/**
 * Portfolio-wide loan capacity (§2.1, C3). Interest and penalties never count:
 * exposure is principal only — outstanding principal on disbursed loans plus
 * approved-but-not-disbursed principal.
 *
 * Kept separate from guarantees.service so both it and loans.service can use
 * it without a circular import.
 */

type Db = Prisma.TransactionClient | typeof prisma

const ZERO = new Prisma.Decimal(0)

/** States of a loan guarantee that hold guarantor capacity for the applicant's own loans. */
const HOLDING_STATES: GuaranteeState[] = [
  GuaranteeState.CONSENTED,
  GuaranteeState.AWAITING_RECONSENT,
]

/**
 * Eligible savings principal supporting lending (§2.1). Same rule as
 * guarantees.service#getMemberEligibleSavingsPrincipal (P3-03): ACTIVE and
 * MATURED plans count; WITHDRAWAL_PENDING principal is frozen and excluded.
 */
export async function getEligibleSavingsPrincipal(memberId: string, db: Db = prisma) {
  const rows = await db.savings.findMany({
    where: { userId: memberId, status: { in: [SavingsStatus.ACTIVE, SavingsStatus.MATURED] } },
    select: { currentBalance: true },
  })
  return rows.reduce((sum, r) => sum.plus(r.currentBalance), new Prisma.Decimal(0))
}

/** Sum of the applicant's loan principal exposure, optionally excluding one loan. */
export async function getApplicantLoanExposure(
  applicantId: string,
  db: Db = prisma,
  excludeLoanId?: string,
): Promise<Prisma.Decimal> {
  const loans = await db.loan.findMany({
    where: {
      userId: applicantId,
      status: { in: [...LOAN_EXPOSURE_STATUSES] },
      ...(excludeLoanId ? { id: { not: excludeLoanId } } : {}),
    },
    select: {
      approvedAmount: true,
      requestedAmount: true,
      instalments: { select: { principalPaid: true } },
    },
  })
  let total = ZERO
  for (const loan of loans) {
    const principal = loan.approvedAmount ?? loan.requestedAmount
    total = total.plus(principalOutstanding(principal, loan.instalments))
  }
  return roundMoney(total)
}

/**
 * Guarantee support already reserved for the applicant's own exposure loans
 * (not their guarantees of other people, not e-ajo reservations — §2.1).
 */
export async function getApplicantOwnLoanSupport(
  applicantId: string,
  db: Db = prisma,
  excludeLoanId?: string,
): Promise<Prisma.Decimal> {
  const rows = await db.guaranteeReservation.findMany({
    where: {
      applicantId,
      guaranteeType: GuaranteeType.LOAN,
      state: { in: HOLDING_STATES },
      loan: {
        status: { in: [...LOAN_EXPOSURE_STATUSES] },
        ...(excludeLoanId ? { id: { not: excludeLoanId } } : {}),
      },
    },
    select: { reservedAmount: true },
  })
  return roundMoney(rows.reduce((s, r) => s.plus(r.reservedAmount), ZERO))
}

export interface LoanSupportNeeded {
  standaloneLimit: Prisma.Decimal
  otherExposure: Prisma.Decimal
  projectedExposure: Prisma.Decimal
  otherSupport: Prisma.Decimal
  requiredSupport: Prisma.Decimal
  /** Guarantee support this loan's guarantor must reserve. */
  needed: Prisma.Decimal
}

/**
 * Support a specific loan needs from its guarantor if `principal` is approved:
 * max(0, (otherExposure + principal − standaloneLimit) − otherOwnLoanSupport).
 */
export async function computeLoanSupportNeeded(
  params: { applicantId: string; loanId: string; principal: DecimalValue },
  db: Db = prisma,
): Promise<LoanSupportNeeded> {
  const savings = await getEligibleSavingsPrincipal(params.applicantId, db)
  const standaloneLimit = getBorrowerStandaloneLimit(savings)
  const otherExposure = await getApplicantLoanExposure(params.applicantId, db, params.loanId)
  const projectedExposure = otherExposure.plus(toDecimal(params.principal))
  const otherSupport = await getApplicantOwnLoanSupport(params.applicantId, db, params.loanId)
  const requiredSupport = calculateRequiredGuaranteeSupport(projectedExposure, standaloneLimit)
  const needed = roundMoney(Prisma.Decimal.max(ZERO, requiredSupport.minus(otherSupport)))
  return { standaloneLimit, otherExposure, projectedExposure, otherSupport, requiredSupport, needed }
}

/**
 * Guarantor's free capacity: eligible savings − every reservation they hold
 * (loan and e-ajo share the pool, §2.1), optionally excluding one reservation.
 */
export async function getGuarantorFreeCapacity(
  guarantorId: string,
  db: Db = prisma,
  excludeReservationId?: string,
): Promise<Prisma.Decimal> {
  const savings = await getEligibleSavingsPrincipal(guarantorId, db)
  const rows = await db.guaranteeReservation.findMany({
    where: {
      guarantorId,
      state: { in: [GuaranteeState.PENDING, ...HOLDING_STATES] },
      ...(excludeReservationId ? { id: { not: excludeReservationId } } : {}),
    },
    select: { state: true, reservedAmount: true, requestedAmount: true },
  })
  let held = ZERO
  for (const r of rows) {
    // A pending request conservatively holds what it asks for.
    held = held.plus(r.state === GuaranteeState.PENDING ? r.requestedAmount : r.reservedAmount)
  }
  return roundMoney(Prisma.Decimal.max(ZERO, savings.minus(held)))
}

/**
 * Re-allocates the applicant's existing loan guarantee reservations after
 * exposure changed (repayment, settlement, approval, cancellation), in one
 * locked transaction (the caller holds lockMembers on the applicant).
 *
 * Reservations are visited in loan approval order; each keeps at most what is
 * still required, and only the amount no longer required is released. A
 * reservation is never increased here (that needs consent or an approval check).
 */
export async function recomputeApplicantLoanReservations(
  tx: Prisma.TransactionClient,
  applicantId: string,
): Promise<{ released: Prisma.Decimal; uncoveredSupport: Prisma.Decimal }> {
  const savings = await getEligibleSavingsPrincipal(applicantId, tx)
  const standaloneLimit = getBorrowerStandaloneLimit(savings)
  const exposure = await getApplicantLoanExposure(applicantId, tx)
  let remaining = calculateRequiredGuaranteeSupport(exposure, standaloneLimit)

  const reservations = await tx.guaranteeReservation.findMany({
    where: {
      applicantId,
      guaranteeType: GuaranteeType.LOAN,
      state: { in: HOLDING_STATES },
      loan: { status: { in: [...LOAN_EXPOSURE_STATUSES] } },
    },
    include: { loan: { select: { approvedAt: true, createdAt: true } } },
  })
  reservations.sort((a, b) => {
    const ta = (a.loan?.approvedAt ?? a.loan?.createdAt ?? a.createdAt).getTime()
    const tb = (b.loan?.approvedAt ?? b.loan?.createdAt ?? b.createdAt).getTime()
    return ta - tb || a.id.localeCompare(b.id)
  })

  let released = ZERO
  for (const r of reservations) {
    const keep = Prisma.Decimal.min(r.reservedAmount, remaining)
    remaining = Prisma.Decimal.max(ZERO, remaining.minus(keep))
    if (keep.lt(r.reservedAmount)) {
      released = released.plus(r.reservedAmount.minus(keep))
      await tx.guaranteeReservation.update({
        where: { id: r.id },
        data: { reservedAmount: roundMoney(keep) },
      })
    }
  }
  // `remaining` > 0 means the reservations no longer cover the exposure (e.g.
  // savings fell). Nothing is seized; P3-09 adds the CapacityBreachAlert.
  return { released: roundMoney(released), uncoveredSupport: roundMoney(remaining) }
}

export interface LoanEligibilitySummary {
  eligibleSavings: Prisma.Decimal
  standaloneLimit: Prisma.Decimal
  existingExposure: Prisma.Decimal
  existingOwnLoanSupport: Prisma.Decimal
  guarantorFreeCapacity: Prisma.Decimal | null
  /** Without a guarantor's extra support. */
  maxWithoutExtraSupport: Prisma.Decimal
  /** Including the chosen guarantor's free capacity (when a guarantor is given). */
  maxWithGuarantor: Prisma.Decimal | null
}

/** Borrowing ceiling for the application form and admin review (§2.1). */
export async function getLoanEligibilitySummary(
  applicantId: string,
  guarantorId?: string | null,
  db: Db = prisma,
): Promise<LoanEligibilitySummary> {
  const eligibleSavings = await getEligibleSavingsPrincipal(applicantId, db)
  const standaloneLimit = getBorrowerStandaloneLimit(eligibleSavings)
  const existingExposure = await getApplicantLoanExposure(applicantId, db)
  const existingOwnLoanSupport = await getApplicantOwnLoanSupport(applicantId, db)
  const guarantorFreeCapacity = guarantorId
    ? await getGuarantorFreeCapacity(guarantorId, db)
    : null
  return {
    eligibleSavings,
    standaloneLimit,
    existingExposure,
    existingOwnLoanSupport,
    guarantorFreeCapacity,
    maxWithoutExtraSupport: maxNewLoanPrincipal({
      standaloneLimit,
      existingExposure,
      existingOwnLoanSupport,
      guarantorFreeCapacity: 0,
    }),
    maxWithGuarantor:
      guarantorFreeCapacity === null
        ? null
        : maxNewLoanPrincipal({
            standaloneLimit,
            existingExposure,
            existingOwnLoanSupport,
            guarantorFreeCapacity,
          }),
  }
}
