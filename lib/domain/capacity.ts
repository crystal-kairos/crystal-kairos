import { Prisma } from '@/generated/prisma/client'
import { LoanStatus, UserRole } from '@/generated/prisma/enums'
import { roundMoney, toDecimal } from './money'

export const STANDALONE_MULTIPLIER = 2

/**
 * Calculates the borrower's standalone borrowing capacity limit (§2.1).
 * borrowerStandaloneLimit = 2 * borrowerEligibleUnencumberedSavingsPrincipal
 */
export function getBorrowerStandaloneLimit(
  eligibleUnencumberedSavings: Prisma.Decimal | string | number,
  multiplier: number = STANDALONE_MULTIPLIER,
): Prisma.Decimal {
  const savings = toDecimal(eligibleUnencumberedSavings)
  if (savings.lte(0)) {
    return new Prisma.Decimal(0)
  }
  return roundMoney(savings.times(multiplier))
}

/**
 * Calculates the required guarantee support for a loan exposure (§2.1).
 * requiredGuaranteeSupport = max(0, projectedLoanExposure - borrowerStandaloneLimit)
 */
export function calculateRequiredGuaranteeSupport(
  projectedLoanExposure: Prisma.Decimal | string | number,
  standaloneLimit: Prisma.Decimal | string | number,
): Prisma.Decimal {
  const exposure = toDecimal(projectedLoanExposure)
  const limit = toDecimal(standaloneLimit)
  return Prisma.Decimal.max(0, exposure.minus(limit))
}

/**
 * Calculates the total outstanding/active exposure of an applicant across their loan portfolio (§2.1).
 */
export function calculateApplicantTotalLoanExposure(
  loans: {
    approvedAmount?: Prisma.Decimal | string | number | null
    requestedAmount?: Prisma.Decimal | string | number
  }[],
): Prisma.Decimal {
  let total = new Prisma.Decimal(0)
  for (const loan of loans) {
    const amount =
      loan.approvedAmount !== null && loan.approvedAmount !== undefined
        ? toDecimal(loan.approvedAmount)
        : toDecimal(loan.requestedAmount || 0)
    total = total.plus(amount)
  }
  return roundMoney(total)
}

/**
 * Calculates the additional guarantee support needed for an application (§2.1).
 * additionalSupportNeeded = max(0, requiredGuaranteeSupport - existingApplicantReservations)
 */
export function calculateAdditionalSupportNeeded(
  requiredGuaranteeSupport: Prisma.Decimal | string | number,
  existingApplicantReservations: Prisma.Decimal | string | number,
): Prisma.Decimal {
  const required = toDecimal(requiredGuaranteeSupport)
  const existing = toDecimal(existingApplicantReservations)
  return Prisma.Decimal.max(0, required.minus(existing))
}

/**
 * Calculates a guarantor's remaining available capacity (§2.1).
 * guaranteeCapacity = guarantorEligibleUnencumberedSavingsPrincipal - activeAndConsentedReservations
 */
export function getGuarantorAvailableCapacity(
  guarantorEligibleSavings: Prisma.Decimal | string | number,
  activeAndConsentedReservations: Prisma.Decimal | string | number,
): Prisma.Decimal {
  const savings = toDecimal(guarantorEligibleSavings)
  const activeReservations = toDecimal(activeAndConsentedReservations)
  return Prisma.Decimal.max(0, savings.minus(activeReservations))
}

export interface GuarantorEligibilityCheckInput {
  guarantorId: string
  applicantId: string
  role: UserRole
  isActive: boolean
  eligibleUnencumberedSavings: Prisma.Decimal | string | number
}

export interface GuarantorEligibilityResult {
  eligible: boolean
  reason?: string
}

/**
 * Verifies that a nominated guarantor is eligible under cooperative rules (§2.1, D-15).
 */
export function checkGuarantorEligibility(
  input: GuarantorEligibilityCheckInput,
): GuarantorEligibilityResult {
  if (input.guarantorId === input.applicantId) {
    return {
      eligible: false,
      reason: 'Applicant cannot be their own guarantor.',
    }
  }

  if (input.role !== UserRole.USER) {
    return {
      eligible: false,
      reason: 'Staff users (OWNER, ADMIN) can never be guarantors or borrowers.',
    }
  }

  if (!input.isActive) {
    return {
      eligible: false,
      reason: 'Deactivated members cannot serve as guarantors.',
    }
  }

  const savings = toDecimal(input.eligibleUnencumberedSavings)
  if (savings.lte(0)) {
    return {
      eligible: false,
      reason:
        'Selected guarantor must have positive eligible unencumbered savings.',
    }
  }

  return { eligible: true }
}

export interface LoanForLienCheck {
  status: LoanStatus
  approvedAmount?: Prisma.Decimal | string | number | null
  requestedAmount?: Prisma.Decimal | string | number
  outstandingBalance?: Prisma.Decimal | string | number
}

export const ACTIVE_LOAN_LIEN_STATUSES: readonly LoanStatus[] = [
  LoanStatus.APPROVED,
  LoanStatus.ACCEPTED,
  LoanStatus.DISBURSED,
  LoanStatus.ACTIVE,
  LoanStatus.OVERDUE,
  LoanStatus.DEFAULTED,
]

export interface OwnSavingsLienResult {
  isLocked: boolean
  activeLoanCount: number
  lienMode: 'FULL'
  reason?: string
}

/**
 * Evaluates the own-savings lock under ownSavingsLienMode = FULL (D-02, A-04, §2.1).
 * While a borrower has any loan approved, accepted, active, overdue or in default,
 * ALL of the borrower's confirmed savings principal is locked.
 */
export function evaluateOwnSavingsLien(
  borrowerLoans: LoanForLienCheck[],
): OwnSavingsLienResult {
  const activeLoans = borrowerLoans.filter((loan) =>
    ACTIVE_LOAN_LIEN_STATUSES.includes(loan.status),
  )

  if (activeLoans.length > 0) {
    return {
      isLocked: true,
      activeLoanCount: activeLoans.length,
      lienMode: 'FULL',
      reason: `Borrower has ${activeLoans.length} active or approved loan(s). All confirmed savings principal is locked under FULL lien policy (D-02).`,
    }
  }

  return {
    isLocked: false,
    activeLoanCount: 0,
    lienMode: 'FULL',
  }
}

/**
 * Calculates E-Ajo advance exposure for guarantee reservations (§2.1, §2.8).
 * Before member payout: advanceAmount = (payoutPosition - 1) * contributionAmount
 * After member payout: remaining unpaid scheduled contributions (never more than advanceAmount)
 */
export function calculateEAjoAdvanceExposure(params: {
  payoutPosition: number
  contributionAmount: Prisma.Decimal | string | number
  hasReceivedPayout?: boolean
  unpaidScheduledContributions?: Prisma.Decimal | string | number
}): Prisma.Decimal {
  const position = params.payoutPosition
  const contribution = toDecimal(params.contributionAmount)

  if (position <= 1) {
    // Slot 1 members receive payout after period 1; advance exposure is zero
    return new Prisma.Decimal(0)
  }

  const advanceAmount = roundMoney(contribution.times(position - 1))

  if (params.hasReceivedPayout && params.unpaidScheduledContributions !== undefined) {
    const unpaid = toDecimal(params.unpaidScheduledContributions)
    return Prisma.Decimal.min(advanceAmount, Prisma.Decimal.max(0, unpaid))
  }

  return advanceAmount
}
