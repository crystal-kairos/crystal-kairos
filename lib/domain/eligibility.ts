import { MembershipStatus, UserRole } from '@/generated/prisma/enums'
import { AppError } from '@/lib/errors/app-error'

export interface ProfileInputData {
  userInfo?: {
    address?: string | null
    dateOfBirth?: Date | null
    gender?: string | null
    occupation?: string | null
    phoneNumber?: string | null
  } | null
  bankAccounts?: Array<{
    id?: string
    bankName?: string | null
    accountNumber?: string | null
    accountName?: string | null
  }> | null
  nextOfKin?: {
    name?: string | null
    phoneNumber?: string | null
    relationship?: string | null
    bankName?: string | null
    accountNumber?: string | null
    accountName?: string | null
    address?: string | null
  } | null
}

export interface ProfileCompletenessResult {
  isComplete: boolean
  hasPersonalInfo: boolean
  hasBankAccount: boolean
  hasNextOfKin: boolean
  missingSections: string[]
  completionPercentage: number
}

/**
 * Pure function evaluating a user's profile completeness according to §1.1.
 * Profile completion is evaluated independently of membership status.
 */
export function calculateProfileCompleteness(
  profile: ProfileInputData,
): ProfileCompletenessResult {
  const missingSections: string[] = []

  const hasPersonalInfo = Boolean(
    profile.userInfo?.address &&
      profile.userInfo?.dateOfBirth &&
      profile.userInfo?.gender &&
      profile.userInfo?.occupation &&
      profile.userInfo?.phoneNumber,
  )
  if (!hasPersonalInfo) {
    missingSections.push('Personal Details')
  }

  const hasBankAccount = Boolean(
    profile.bankAccounts &&
      profile.bankAccounts.length > 0 &&
      profile.bankAccounts[0].accountNumber &&
      profile.bankAccounts[0].bankName,
  )
  if (!hasBankAccount) {
    missingSections.push('Bank Account')
  }

  const hasNextOfKin = Boolean(
    profile.nextOfKin?.name &&
      profile.nextOfKin?.phoneNumber &&
      profile.nextOfKin?.relationship,
  )
  if (!hasNextOfKin) {
    missingSections.push('Next of Kin')
  }

  const completedCount =
    (hasPersonalInfo ? 1 : 0) +
    (hasBankAccount ? 1 : 0) +
    (hasNextOfKin ? 1 : 0)

  const completionPercentage = Math.round((completedCount / 3) * 100)

  return {
    isComplete: completedCount === 3,
    hasPersonalInfo,
    hasBankAccount,
    hasNextOfKin,
    missingSections,
    completionPercentage,
  }
}

/**
 * Asserts that a user account is active. Inactive (soft-deactivated) users
 * are forbidden from authenticating or initiating any actions (§4.6, P1-07).
 */
export function assertUserActive(user: {
  isActive: boolean
  deactivationReason?: string | null
}): void {
  if (!user.isActive) {
    throw new AppError(
      'ACCOUNT_DEACTIVATED',
      'This account has been deactivated. Please contact society administration.',
      { statusCode: 403 },
    )
  }
}

/**
 * Non-negotiable invariant D-15: Staff are never members.
 * Users with role OWNER or ADMIN can never hold a membership, savings, loans,
 * e-ajo participation, guarantees, or wallet.
 */
export function assertStaffNotMember(user: {
  role: UserRole
  membership?: unknown | null
  hasMemberRecords?: boolean
}): void {
  if (user.role === UserRole.OWNER || user.role === UserRole.ADMIN) {
    if (user.membership || user.hasMemberRecords) {
      throw new AppError(
        'STAFF_CANNOT_BE_MEMBER',
        'Staff accounts (OWNER/ADMIN) cannot hold membership or participate in financial products (D-15).',
      )
    }
  }
}

/**
 * Non-negotiable invariant D-15: Members cannot be granted staff roles if they
 * currently hold or have held member records.
 */
export function assertMemberNotPromotedToStaff(
  targetRole: UserRole,
  hasMemberRecords: boolean,
): void {
  if (targetRole === UserRole.OWNER || targetRole === UserRole.ADMIN) {
    if (hasMemberRecords) {
      throw new AppError(
        'MEMBER_CANNOT_BE_STAFF',
        'A member with financial or membership records cannot be assigned a staff role (D-15).',
      )
    }
  }
}

export interface ProductEligibilityCheckParams {
  user: {
    id: string
    role: UserRole
    isActive: boolean
    deactivationReason?: string | null
    membership?: {
      status: MembershipStatus
    } | null
  }
  profile: ProfileInputData
  productType: 'SAVINGS' | 'LOAN' | 'EAJO' | 'RECEIPT_UPLOAD'
}

/**
 * Pure domain check verifying eligibility for a specific cooperative product.
 * Enforces:
 * 1. User must be active
 * 2. User cannot be staff (D-15)
 * 3. Membership must be APPROVED
 * 4. Profile must be complete
 */
export function assertProductEligibility(
  params: ProductEligibilityCheckParams,
): void {
  const { user, profile, productType } = params

  // 1. Check soft-deactivation
  assertUserActive(user)

  // 2. Staff are never members (D-15)
  if (user.role === UserRole.OWNER || user.role === UserRole.ADMIN) {
    throw new AppError(
      'STAFF_INELIGIBLE_FOR_PRODUCTS',
      `Staff users (${user.role}) cannot subscribe to or participate in ${productType} (D-15).`,
    )
  }

  // 3. Membership status
  if (!user.membership || user.membership.status !== MembershipStatus.APPROVED) {
    throw new AppError(
      'MEMBERSHIP_NOT_APPROVED',
      `Membership must be approved before participating in ${productType}. Current status: ${user.membership?.status ?? 'NONE'}.`,
    )
  }

  // 4. Profile completeness
  const completeness = calculateProfileCompleteness(profile)
  if (!completeness.isComplete) {
    throw new AppError(
      'PROFILE_INCOMPLETE',
      `Please complete your profile before participating in ${productType}. Missing: ${completeness.missingSections.join(', ')}.`,
      { statusCode: 422 },
    )
  }
}

/**
 * Validates and normalises a Nigerian or international phone number to E.164.
 * Rejects malformed or invalid lengths.
 */
export function normalizePhoneNumber(phoneNumber: string): string {
  const cleaned = phoneNumber.trim().replace(/[\s-]/g, '')
  if (!cleaned) {
    throw new AppError('INVALID_PHONE_NUMBER', 'Phone number is required.')
  }

  // Nigerian local format e.g. 08012345678 -> +2348012345678
  if (/^0\d{10}$/.test(cleaned)) {
    return `+234${cleaned.slice(1)}`
  }

  // E.164 format e.g. +2348012345678
  if (/^\+\d{11,15}$/.test(cleaned)) {
    return cleaned
  }

  throw new AppError(
    'INVALID_PHONE_NUMBER',
    'Invalid phone number: must be a valid 11-digit Nigerian number (080...) or international E.164 format (+234...).',
  )
}
