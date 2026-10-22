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
  personalInfo: Step1State['data'],
  bankInfo: Step2State['data'],
  nextOfKin: Step3State['data'],
  membershipInfo: Step4State['data'],
  reviewAndSubmit: Step5State['data'],
) => {
  try {
    // Validations
    const parsedPersonalInfo = personalInfoSchema.parse({
      ...personalInfo,
      dateOfBirth: new Date(personalInfo.dateOfBirth),
    })
    const parsedBankInfo = bankInfoSchema.parse(bankInfo)
    const parsedNextOfKin = nextOfKinSchema.parse(nextOfKin)
    membershipInfoSchema.parse(membershipInfo)
    reviewAndSubmitSchema.parse(reviewAndSubmit)

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: {
        email: personalInfo.email,
      },
    })
    if (existingUser) {
      return {
        success: false,
        error: 'Unable to complete registration with the provided details.',
      }
    }

    // Normalise and check phone number uniqueness (A-22)
    const normalizedPhone = normalizePhoneNumber(parsedPersonalInfo.phoneNumber)
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

    // Check duplicate active bank account across active members (A-22)
    const existingBank = await prisma.bankAccount.findFirst({
      where: {
        accountNumber: parsedBankInfo.accountNumber,
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

    // Create a new user
    const { user } = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email: parsedPersonalInfo.email,
          name: parsedPersonalInfo.name,
        },
      })

      await tx.userInfo.create({
        data: {
          userId: newUser.id,
          address: parsedPersonalInfo.address,
          dateOfBirth: parsedPersonalInfo.dateOfBirth,
          gender: parsedPersonalInfo.gender,
          occupation: parsedPersonalInfo.occupation,
          phoneNumber: normalizedPhone,
        },
      })

      await tx.bankAccount.create({
        data: {
          userId: newUser.id,
          bankName: parsedBankInfo.bankName,
          accountNumber: parsedBankInfo.accountNumber,
          accountName: parsedBankInfo.accountName,
        },
      })

      await tx.nextOfKin.create({
        data: {
          userId: newUser.id,
          name: parsedNextOfKin.name,
          phoneNumber: parsedNextOfKin.phoneNumber,
          relationship: parsedNextOfKin.relationship,
          occupation: parsedNextOfKin.occupation,
          address: parsedNextOfKin.address,
          bankName: parsedNextOfKin.bankName,
          accountNumber: parsedNextOfKin.accountNumber,
          accountName: parsedNextOfKin.accountName,
        },
      })

      await tx.membership.create({
        data: {
          userId: newUser.id,
          interests: membershipInfo.interests,
          referralName: membershipInfo.referralName,
          referralPhoneNumber: membershipInfo.referralPhoneNumber,
          assumptions: membershipInfo.assumptions,
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
