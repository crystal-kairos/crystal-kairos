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
import {
  AdminPermission,
  PasswordSetupTokenPurpose,
} from '@/generated/prisma/enums'
import { AuthzError, requireAnyPermission } from '@/lib/authz/guards'

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
          phoneNumber: parsedPersonalInfo.phoneNumber,
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
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Invalid data',
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
        error: 'Unauthorized to issue setup tokens.',
      }
    }
    return {
      success: false,
      error:
        error instanceof TokenError
          ? error.message
          : 'Unable to issue setup token.',
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
