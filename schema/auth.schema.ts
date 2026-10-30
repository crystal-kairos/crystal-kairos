import {
  Assumptions,
  Gender,
  MembershipInterest,
  Relationship,
} from '@/generated/prisma/enums'
import * as z from 'zod'

export const loginSchema = z.object({
  email: z.email('Invalid email address'),
  password: z.string().trim().min(1, 'Password is required'),
})

export const personalInfoSchema = z.object({
  name: z.string().trim().min(1, 'Full name is required'),
  email: z.email('Invalid email address'),
  address: z.string().trim().min(1, 'Address is required'),
  dateOfBirth: z.date(),
  gender: z.enum(Object.values(Gender)),
  phoneNumber: z.string().trim().min(1, 'Phone number is required'),
  occupation: z.string().trim().min(1, 'Occupation is required'),
  privacyConsent: z.boolean().optional(),
})

export const simplifiedRegistrationSchema = z.object({
  name: z.string().trim().min(1, 'Full name is required'),
  email: z.email('Invalid email address'),
  phoneNumber: z.string().trim().min(1, 'Phone number is required'),
  privacyConsent: z.boolean().refine((val) => val === true, {
    message: 'You must accept the privacy policy to register.',
  }),
  address: z.string().trim().optional(),
  dateOfBirth: z.date().optional(),
  gender: z.enum(Object.values(Gender)).optional(),
  occupation: z.string().trim().optional(),
  referralName: z.string().trim().optional(),
  referralPhoneNumber: z.string().trim().optional(),
})

export const bankInfoSchema = z.object({
  bankName: z.string().trim().min(1, 'Bank name is required'),
  accountNumber: z
    .string()
    .trim()
    .length(10, 'Account number must be 10 digits'),
  accountName: z.string().trim().min(1, 'Account name is required'),
})

export const nextOfKinSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  phoneNumber: z.string().trim().min(1, 'Phone number is required'),
  relationship: z.enum(Object.values(Relationship)),
  occupation: z.string().trim().min(1, 'Occupation is required'),
  address: z.string().trim().min(1, 'Address is required'),
  bankName: z.string().trim().min(1, 'Bank name is required'),
  accountNumber: z
    .string()
    .trim()
    .length(10, 'Account number must be 10 digits'),
  accountName: z.string().trim().min(1, 'Account name is required'),
})

export const membershipInfoSchema = z.object({
  interests: z
    .array(z.enum(Object.values(MembershipInterest) as [string, ...string[]]))
    .min(1, 'Select at least one interest'),
  referralName: z.string().trim().min(1, 'Referral name is required'),
  referralPhoneNumber: z
    .string()
    .trim()
    .min(1, 'Referral phone number is required'),
  assumptions: z
    .array(z.enum(Object.values(Assumptions) as [string, ...string[]]))
    .min(Object.values(Assumptions).length, 'All box must be checked'),
})

export const reviewAndSubmitSchema = z.object({
  termsAndConditions: z.boolean().refine((val) => val, {
    message: 'You must accept the terms and conditions',
  }),
})

export const setPasswordSchema = z
  .object({
    email: z.string().trim().min(1, 'Email is required'),
    password: z
      .string()
      .trim()
      .min(10, 'Password must be at least 10 characters long'),
    confirmPassword: z.string().trim().min(1, 'Confirm password is required'),
  })
  .refine((data) => data.password.toLowerCase() !== data.email.toLowerCase(), {
    message: 'Password must not match your email address',
    path: ['password'],
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })

export type SetPasswordFormSchema = z.infer<typeof setPasswordSchema>
