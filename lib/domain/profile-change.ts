import { z } from 'zod'
import { ProfileChangeStatus, ProfileChangeType } from '@/generated/prisma/enums'
import { nextOfKinSchema } from '@/schema/auth.schema'

/**
 * Pure domain rules for sensitive profile changes (PR P3-02B).
 *
 * Everything here is free of I/O so it can be unit-tested directly and reused by
 * both the member submission actions and the admin review actions.
 */

const ACCOUNT_NUMBER_RE = /^\d{10}$/

/** Masks an account number to its last four digits, e.g. `******6789`. */
export function maskAccountNumber(accountNumber: string | null | undefined): string {
  const clean = (accountNumber ?? '').trim()
  if (clean.length <= 4) return '****'
  return '******' + clean.slice(-4)
}

/**
 * Allowed status transitions. Only PENDING requests may move, and only to a terminal state.
 */
export function canTransitionProfileChange(
  from: ProfileChangeStatus,
  to: ProfileChangeStatus,
): boolean {
  if (from !== ProfileChangeStatus.PENDING) return false
  return (
    to === ProfileChangeStatus.APPROVED ||
    to === ProfileChangeStatus.REJECTED ||
    to === ProfileChangeStatus.CANCELLED
  )
}

// ---------------------------------------------------------------------------
// Proposed-value schemas, one per change type. Approval re-parses the stored JSON
// with these, so arbitrary JSON can never reach a Prisma update.
// ---------------------------------------------------------------------------

export const primaryBankProposedSchema = z.object({
  targetBankAccountId: z.string().trim().min(1),
  bankName: z.string().trim().min(1),
  bankCode: z.string().trim().nullable().optional(),
  accountName: z.string().trim().min(1),
  accountNumberMasked: z.string().trim().min(1),
})

export const bankDetailsProposedSchema = z.object({
  bankAccountId: z.string().trim().min(1),
  bankCode: z.string().trim().min(1, 'Bank selection is required'),
  bankName: z.string().trim().min(1, 'Bank name is required'),
  accountNumber: z
    .string()
    .trim()
    .regex(ACCOUNT_NUMBER_RE, 'Account number must be exactly 10 digits'),
  accountName: z.string().trim().min(1, 'Account name is required'),
  accountNumberMasked: z.string().trim().min(1),
  nameMatch: z
    .object({ isMatch: z.boolean(), similarityScore: z.number() })
    .optional(),
})

export const nextOfKinProposedSchema = nextOfKinSchema.extend({
  accountNumber: z
    .string()
    .trim()
    .regex(ACCOUNT_NUMBER_RE, 'Account number must be exactly 10 digits'),
  accountNumberMasked: z.string().trim().optional(),
})

export type PrimaryBankProposed = z.infer<typeof primaryBankProposedSchema>
export type BankDetailsProposed = z.infer<typeof bankDetailsProposedSchema>
export type NextOfKinProposed = z.infer<typeof nextOfKinProposedSchema>

export type ParsedProposedValue =
  | { changeType: typeof ProfileChangeType.PRIMARY_BANK; value: PrimaryBankProposed }
  | { changeType: typeof ProfileChangeType.BANK_DETAILS; value: BankDetailsProposed }
  | { changeType: typeof ProfileChangeType.NEXT_OF_KIN; value: NextOfKinProposed }

/**
 * Validates a stored `proposedValue` against the schema for its change type.
 * Throws a ZodError when the payload is malformed.
 */
export function parseProposedValue(
  changeType: ProfileChangeType,
  proposedValue: unknown,
): ParsedProposedValue {
  switch (changeType) {
    case ProfileChangeType.PRIMARY_BANK:
      return { changeType, value: primaryBankProposedSchema.parse(proposedValue) }
    case ProfileChangeType.BANK_DETAILS:
      return { changeType, value: bankDetailsProposedSchema.parse(proposedValue) }
    case ProfileChangeType.NEXT_OF_KIN:
      return { changeType, value: nextOfKinProposedSchema.parse(proposedValue) }
    default: {
      const exhaustive: never = changeType
      throw new Error(`Unsupported profile change type: ${String(exhaustive)}`)
    }
  }
}

/**
 * Removes full account numbers from a stored previous/proposed value so it can be
 * shown in list views or sent to the browser. Masked numbers are kept.
 */
export function redactChangeValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? null
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(source)) {
    if (key === 'accountNumber') continue
    out[key] = val
  }
  if (typeof source.accountNumber === 'string' && !out.accountNumberMasked) {
    out.accountNumberMasked = maskAccountNumber(source.accountNumber)
  }
  return out
}

/** Returns a copy of a change request with both value snapshots redacted. */
export function toRedactedProfileChange<
  T extends { previousValue: unknown; proposedValue: unknown },
>(request: T): T {
  return {
    ...request,
    previousValue: redactChangeValue(request.previousValue),
    proposedValue: redactChangeValue(request.proposedValue),
  }
}
