import { prisma } from '@/lib/prisma'
import { MembershipStatus, UserRole } from '@/generated/prisma/enums'
import { AppError } from '@/lib/errors/app-error'

export interface ProfileRequirementStatus {
  field: string
  label: string
  completed: boolean
}

export interface ProfileCompletionReport {
  userId: string
  membershipStatus: MembershipStatus | 'NONE'
  isApproved: boolean
  isComplete: boolean
  completionPercentage: number
  sections: {
    personalInfo: {
      isComplete: boolean
      requirements: ProfileRequirementStatus[]
    }
    bankAccount: {
      isComplete: boolean
      requirements: ProfileRequirementStatus[]
    }
    nextOfKin: {
      isComplete: boolean
      requirements: ProfileRequirementStatus[]
    }
    passportPhoto: {
      isComplete: boolean
      requirements: ProfileRequirementStatus[]
    }
  }
  missingSections: string[]
  productEligibility: {
    SAVINGS: { eligible: boolean; reasons: string[] }
    LOAN: { eligible: boolean; reasons: string[] }
    EAJO: { eligible: boolean; reasons: string[] }
  }
}

/**
 * Evaluates profile completion and product eligibility for a member centrally (§1.1, P3-01).
 */
export async function getProfileCompletion(
  userId: string,
  db: typeof prisma = prisma,
): Promise<ProfileCompletionReport> {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: {
      userInfo: true,
      bankAccounts: { where: { isPrimary: true } },
      nextOfKin: true,
      membership: true,
      uploadedFiles: {
        where: { purpose: 'PASSPORT_PHOTO' },
        take: 1,
      },
    },
  })

  if (!user) {
    throw new AppError('NOT_FOUND', 'User not found.', { statusCode: 404 })
  }

  // 1. Personal Details Requirements
  const personalRequirements: ProfileRequirementStatus[] = [
    {
      field: 'phoneNumber',
      label: 'Phone Number',
      completed: Boolean(user.userInfo?.phoneNumber),
    },
    {
      field: 'address',
      label: 'Home Address',
      completed: Boolean(user.userInfo?.address),
    },
    {
      field: 'dateOfBirth',
      label: 'Date of Birth',
      completed: Boolean(user.userInfo?.dateOfBirth),
    },
    {
      field: 'gender',
      label: 'Gender',
      completed: Boolean(user.userInfo?.gender),
    },
    {
      field: 'occupation',
      label: 'Occupation',
      completed: Boolean(user.userInfo?.occupation),
    },
  ]
  const hasPersonalInfo = personalRequirements.every((r) => r.completed)

  // 2. Bank Account Requirements
  const bankRequirements: ProfileRequirementStatus[] = [
    {
      field: 'accountNumber',
      label: 'Bank Account Number',
      completed: Boolean(user.bankAccounts?.[0]?.accountNumber),
    },
    {
      field: 'bankName',
      label: 'Bank Name',
      completed: Boolean(user.bankAccounts?.[0]?.bankName),
    },
    {
      field: 'accountName',
      label: 'Account Name',
      completed: Boolean(user.bankAccounts?.[0]?.accountName),
    },
  ]
  const hasBankAccount = bankRequirements.every((r) => r.completed)

  // 3. Next of Kin Requirements
  const nokRequirements: ProfileRequirementStatus[] = [
    {
      field: 'name',
      label: 'Next of Kin Name',
      completed: Boolean(user.nextOfKin?.name),
    },
    {
      field: 'phoneNumber',
      label: 'Next of Kin Phone',
      completed: Boolean(user.nextOfKin?.phoneNumber),
    },
    {
      field: 'relationship',
      label: 'Relationship',
      completed: Boolean(user.nextOfKin?.relationship),
    },
  ]
  const hasNextOfKin = nokRequirements.every((r) => r.completed)

  // 4. Passport Photo Requirement
  const hasPassportPhoto = Boolean(
    user.photoUrl || user.uploadedFiles.length > 0,
  )
  const passportRequirements: ProfileRequirementStatus[] = [
    {
      field: 'passportPhoto',
      label: 'Passport Photo',
      completed: hasPassportPhoto,
    },
  ]

  const missingSections: string[] = []
  if (!hasPersonalInfo) missingSections.push('Personal Details')
  if (!hasBankAccount) missingSections.push('Bank Account')
  if (!hasNextOfKin) missingSections.push('Next of Kin')
  if (!hasPassportPhoto) missingSections.push('Passport Photograph')

  const totalSections = 4
  const completedSections =
    (hasPersonalInfo ? 1 : 0) +
    (hasBankAccount ? 1 : 0) +
    (hasNextOfKin ? 1 : 0) +
    (hasPassportPhoto ? 1 : 0)

  const completionPercentage = Math.round(
    (completedSections / totalSections) * 100,
  )
  const isComplete = completedSections === totalSections

  const membershipStatus = user.membership?.status || 'NONE'
  const isApproved = membershipStatus === MembershipStatus.APPROVED

  // Product eligibility evaluation (§1.1):
  // Must be active, USER role (not staff), membership APPROVED, and profile complete.
  const evaluateProduct = (productName: string) => {
    const reasons: string[] = []
    if (user.isActive === false) {
      reasons.push('Account has been deactivated. Please contact society administration.')
    }
    if (user.role === UserRole.OWNER || user.role === UserRole.ADMIN) {
      reasons.push(`Staff accounts (${user.role}) cannot participate in ${productName} (D-15).`)
    }
    if (!isApproved) {
      reasons.push(
        `Membership must be approved before applying for ${productName}. Current status: ${membershipStatus}.`,
      )
    }
    if (!isComplete) {
      reasons.push(
        `Profile completion required before applying for ${productName}. Missing: ${missingSections.join(', ')}.`,
      )
    }
    return {
      eligible: reasons.length === 0,
      reasons,
    }
  }

  return {
    userId,
    membershipStatus,
    isApproved,
    isComplete,
    completionPercentage,
    sections: {
      personalInfo: {
        isComplete: hasPersonalInfo,
        requirements: personalRequirements,
      },
      bankAccount: {
        isComplete: hasBankAccount,
        requirements: bankRequirements,
      },
      nextOfKin: {
        isComplete: hasNextOfKin,
        requirements: nokRequirements,
      },
      passportPhoto: {
        isComplete: hasPassportPhoto,
        requirements: passportRequirements,
      },
    },
    missingSections,
    productEligibility: {
      SAVINGS: evaluateProduct('Savings Plans'),
      LOAN: evaluateProduct('Loans'),
      EAJO: evaluateProduct('Digital Ajo'),
    },
  }
}

/**
 * Enforces product eligibility server-side on every product action (§1.1).
 * Throws clean AppError if user is not eligible.
 */
export async function assertProductEligibility(
  userId: string,
  product: 'SAVINGS' | 'LOAN' | 'EAJO',
  db: typeof prisma = prisma,
): Promise<void> {
  const report = await getProfileCompletion(userId, db)
  const productInfo = report.productEligibility[product]

  if (!productInfo.eligible) {
    const reason = productInfo.reasons[0] || 'You are not currently eligible for this product.'
    throw new AppError('INELIGIBLE_FOR_PRODUCT', reason, { statusCode: 422 })
  }
}
