'use server'

import { onMemberRegistered } from '@/features/notification/triggers/member.triggers'
import { prisma } from '@/lib/prisma'
import {
  bankInfoSchema,
  nextOfKinSchema,
  personalInfoSchema,
  membershipInfoSchema,
  reviewAndSubmitSchema,
  setPasswordSchema,
  SetPasswordFormSchema,
} from '@/schema/auth.schema'
import {
  Step1State,
  Step2State,
  Step3State,
  Step4State,
  Step5State,
} from '@/types/register.interface'
import { hash } from 'bcryptjs'
import {
  consumePasswordSetupTokenAndSetPassword,
  issuePasswordSetupToken,
  TokenError,
  verifyPasswordSetupToken,
} from '@/lib/authz/tokens'
import { AdminPermission, PasswordSetupTokenPurpose } from '@/generated/prisma/enums'
import { AuthzError, requireAnyPermission } from '@/lib/authz/guards'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { normalizePhoneNumber } from '@/lib/domain/eligibility'

export const register = async (
  personalInfo: Partial<Step1State['data']> & {
    name: string
    email: string
    phoneNumber: string
    address?: string
    dateOfBirth?: Date | string
    gender?: any
    occupation?: string
    privacyConsent?: boolean
  },
  bankInfo?: Partial<Step2State['data']> | null,
  nextOfKin?: Partial<Step3State['data']> | null,
  membershipInfo?: Partial<Step4State['data']> | null,
  reviewAndSubmit?: Partial<Step5State['data']> | null,
) => {
  try {
    if (!personalInfo?.name || !personalInfo?.email || !personalInfo?.phoneNumber) {
      return {
        success: false,
        error: 'Full name, email address, and phone number are required for registration.',
      }
    }

    const email = personalInfo.email.trim().toLowerCase()
    const name = personalInfo.name.trim()

    // Normalise and check phone number uniqueness (A-22)
    const normalizedPhone = normalizePhoneNumber(personalInfo.phoneNumber)

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    })
    if (existingUser) {
      return {
        success: false,
        error: 'Unable to complete registration with the provided details.',
      }
    }

    const existingPhone = await prisma.userInfo.findFirst({
      where: { phoneNumber: normalizedPhone },
    })
    if (existingPhone) {
      return {
        success: false,
        error:
          'A member with this phone number is already registered. Please contact an administrator.',
      }
    }

    // Check optional bank account if provided
    const hasBankDetails = Boolean(
      bankInfo?.bankName &&
      bankInfo?.accountNumber &&
      bankInfo?.accountName,
    )

    if (hasBankDetails && bankInfo?.accountNumber) {
      const existingBank = await prisma.bankAccount.findFirst({
        where: {
          accountNumber: bankInfo.accountNumber.trim(),
          user: { isActive: true },
        },
      })
      if (existingBank) {
        return {
          success: false,
          error:
            'This bank account is already registered by another member. Please contact an administrator.',
        }
      }
    }

    // Parse date of birth if present
    let dob: Date | null = null
    if (personalInfo.dateOfBirth) {
      const parsed = new Date(personalInfo.dateOfBirth)
      if (!isNaN(parsed.getTime())) {
        dob = parsed
      }
    }

    // Create a new user
    const { user } = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email,
          name,
        },
      })

      await tx.userInfo.create({
        data: {
          userId: newUser.id,
          address: personalInfo.address?.trim() || null,
          dateOfBirth: dob,
          gender: personalInfo.gender || null,
          occupation: personalInfo.occupation?.trim() || null,
          phoneNumber: normalizedPhone,
        },
      })

      if (hasBankDetails && bankInfo) {
        await tx.bankAccount.create({
          data: {
            userId: newUser.id,
            bankName: bankInfo.bankName!.trim(),
            accountNumber: bankInfo.accountNumber!.trim(),
            accountName: bankInfo.accountName!.trim(),
            isPrimary: true,
          },
        })
      }

      const hasNextOfKinDetails = Boolean(
        nextOfKin?.name &&
        nextOfKin?.phoneNumber &&
        nextOfKin?.relationship,
      )

      if (hasNextOfKinDetails && nextOfKin) {
        await tx.nextOfKin.create({
          data: {
            userId: newUser.id,
            name: nextOfKin.name!.trim(),
            phoneNumber: nextOfKin.phoneNumber!.trim(),
            relationship: nextOfKin.relationship!,
            occupation: nextOfKin.occupation?.trim() || 'Not Specified',
            address: nextOfKin.address?.trim() || 'Not Specified',
            bankName: nextOfKin.bankName?.trim() || 'Not Specified',
            accountNumber: nextOfKin.accountNumber?.trim() || 'Not Specified',
            accountName: nextOfKin.accountName?.trim() || 'Not Specified',
          },
        })
      }

      await tx.membership.create({
        data: {
          userId: newUser.id,
          interests: membershipInfo?.interests || [],
          referralName: membershipInfo?.referralName?.trim() || null,
          referralPhoneNumber: membershipInfo?.referralPhoneNumber?.trim() || null,
          assumptions: membershipInfo?.assumptions || [],
        },
      })

      // Record technical baseline privacy consent (D-21, §1.10)
      await tx.privacyConsent.create({
        data: {
          userId: newUser.id,
          noticeVersion: 'v1.0',
          acceptedAt: new Date(),
        },
      })

      return { user: newUser }
    })

    if (user) {
      try {
        await onMemberRegistered(user.id)
      } catch (error) {
        console.error('Registration notification failed:', error)
      }
    }

    return { success: true, message: 'Registration successful', user }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'register',
      fallbackMessage: 'Unable to complete registration. Please try again.',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      fieldErrors: err.fieldErrors,
      correlationId: err.correlationId,
    }
  }
}

/**
 * Issues a single-use password setup token.
 * Requires an authenticated staff user with member approval/creation or staff management permissions.
 */
export const signUser = async (userId: string, userEmail: string) => {
  try {
    const actor = await requireAnyPermission([
      AdminPermission.MEMBERS_APPROVE,
      AdminPermission.MEMBERS_CREATE,
      AdminPermission.STAFF_MANAGE,
    ])

    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, hasSetPassword: true },
    })

    if (
      !targetUser ||
      targetUser.email.trim().toLowerCase() !== userEmail.trim().toLowerCase()
    ) {
      return {
        success: false,
        error: 'Unable to issue setup token for this account.',
      }
    }

    const issued = await issuePasswordSetupToken({
      userId: targetUser.id,
      purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
      createdById: actor.id,
    })

    return { success: true, token: issued.rawToken }
  } catch (error) {
    if (error instanceof AuthzError) {
      return {
        success: false,
        code: error.code,
        error: 'Unauthorized to issue setup tokens.',
      }
    }
    const err = toActionErrorResult(error, {
      actionName: 'signUser',
      fallbackMessage: 'Unable to issue setup token.',
      context: { userId },
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      correlationId: err.correlationId,
    }
  }
}

export const verifyToken = async (token: string) => {
  try {
    const verified = await verifyPasswordSetupToken({
      rawToken: token,
      purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
    })

    return {
      success: true,
      data: {
        userId: verified.userId,
        userEmail: verified.userEmail,
      },
    }
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof TokenError
          ? error.message
          : 'This setup link is no longer valid.',
    }
  }
}

export const verifyPasswordSetToken = async (token: string) => {
  try {
    const verified = await verifyPasswordSetupToken({
      rawToken: token,
      purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
    })

    return {
      success: true,
      data: {
        userId: verified.userId,
        userEmail: verified.userEmail,
      },
    }
  } catch (error) {
    if (error instanceof TokenError && error.code === 'ACCOUNT_NOT_ELIGIBLE') {
      return {
        success: false,
        error: error.message,
        redirect: '/login',
      }
    }
    return {
      success: false,
      data: null,
      error:
        error instanceof TokenError
          ? error.message
          : 'This setup link is no longer valid.',
    }
  }
}

export const setPassword = async (
  formData: SetPasswordFormSchema,
  token: string,
) => {
  try {
    const parsed = setPasswordSchema.parse(formData)
    const hashedPassword = await hash(parsed.password, 12)

    const result = await consumePasswordSetupTokenAndSetPassword({
      rawToken: token,
      email: parsed.email,
      passwordHash: hashedPassword,
      purpose: PasswordSetupTokenPurpose.SET_PASSWORD,
    })

    return {
      success: true,
      data: {
        id: result.userId,
        email: result.email,
      },
    }
  } catch (error) {
    if (error instanceof TokenError) {
      return {
        success: false,
        data: null,
        code: error.code,
        error: error.message,
      }
    }
    const err = toActionErrorResult(error, {
      actionName: 'setPassword',
      fallbackMessage: 'This setup link is no longer valid.',
    })
    return {
      success: false,
      data: null,
      error: err.error,
      code: err.code,
      fieldErrors: err.fieldErrors,
      correlationId: err.correlationId,
    }
  }
}
