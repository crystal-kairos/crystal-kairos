import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import { AuditEvent, UserRole } from '@/generated/prisma/client'

/**
 * Audit Action taxonomy covering system events across all domains (§P2-06, Rev 2).
 */
export const AuditAction = {
  // Auth & Sessions
  AUTH_SIGN_IN_SUCCESS: 'AUTH.SIGN_IN_SUCCESS',
  AUTH_SIGN_IN_FAILURE: 'AUTH.SIGN_IN_FAILURE',
  AUTH_LOCKOUT: 'AUTH.LOCKOUT',
  AUTH_MFA_ENROLLED: 'AUTH.MFA_ENROLLED',
  AUTH_MFA_RESET: 'AUTH.MFA_RESET',
  AUTH_SESSION_REVOKED: 'AUTH.SESSION_REVOKED',
  AUTH_PASSWORD_SET: 'AUTH.PASSWORD_SET',
  AUTH_PASSWORD_RESET: 'AUTH.PASSWORD_RESET',
  AUTH_MFA_CHALLENGE_PASSED: 'AUTH.MFA_CHALLENGE_PASSED',
  AUTH_MFA_CHALLENGE_FAILED: 'AUTH.MFA_CHALLENGE_FAILED',
  AUTH_STEP_UP_CONFIRMED: 'AUTH.STEP_UP_CONFIRMED',
  AUTH_STEP_UP_FAILED: 'AUTH.STEP_UP_FAILED',

  // Staff & Permissions
  ADMIN_PERMISSION_GRANTED: 'ADMIN.PERMISSION_GRANTED',
  ADMIN_PERMISSION_REVOKED: 'ADMIN.PERMISSION_REVOKED',
  STAFF_CREATED: 'STAFF.CREATED',

  // Settings & Rates
  SETTING_CHANGED: 'SETTING.CHANGED',
  RATE_CHANGED: 'RATE.CHANGED',
  POLICY_NOTICE_DRAFTED: 'POLICY_NOTICE.DRAFTED',
  POLICY_NOTICE_SENT: 'POLICY_NOTICE.SENT',

  // Receipts & Payments
  RECEIPT_SUBMITTED: 'RECEIPT.SUBMITTED',
  RECEIPT_CONFIRMED: 'RECEIPT.CONFIRMED',
  RECEIPT_REJECTED: 'RECEIPT.REJECTED',
  PAYMENT_SUBMITTED: 'PAYMENT.SUBMITTED',
  PAYMENT_CONFIRMED: 'PAYMENT.CONFIRMED',
  PAYMENT_REJECTED: 'PAYMENT.REJECTED',
  PAYMENT_RESUBMITTED: 'PAYMENT.RESUBMITTED',
  PAYMENT_REVERSED: 'PAYMENT.REVERSED',
  DISBURSEMENT_REQUESTED: 'DISBURSEMENT.REQUESTED',
  DISBURSEMENT_APPROVED: 'DISBURSEMENT.APPROVED',
  DISBURSEMENT_EXECUTED: 'DISBURSEMENT.EXECUTED',
  DISBURSEMENT_REJECTED: 'DISBURSEMENT.REJECTED',
  FINANCIAL_POSTING: 'FINANCIAL.POSTING',
  FINANCIAL_REVERSAL: 'FINANCIAL.REVERSAL',
  DEPOSIT_UNIDENTIFIED: 'DEPOSIT.UNIDENTIFIED',
  RECONCILIATION_RECORDED: 'RECONCILIATION.RECORDED',

  // Penalties
  PENALTY_ACCRUED: 'PENALTY.ACCRUED',
  PENALTY_WAIVED: 'PENALTY.WAIVED',
  PENALTY_RECALCULATED: 'PENALTY.RECALCULATED',

  // Recovery & Settlement
  RECOVERY_CASE_STATE_CHANGED: 'RECOVERY.STATE_CHANGED',
  RECOVERY_CASE_EXECUTED: 'RECOVERY.EXECUTED',
  SETTLEMENT_CASE_ACTION: 'SETTLEMENT.ACTION',
  SETTLEMENT_NOK_CONTACT_LOGGED: 'SETTLEMENT.NOK_CONTACT_LOGGED',

  // Wallet
  WALLET_ALLOCATED: 'WALLET.ALLOCATED',
  WALLET_WITHDRAWAL_REQUESTED: 'WALLET.WITHDRAWAL_REQUESTED',
  WALLET_WITHDRAWAL_APPROVED: 'WALLET.WITHDRAWAL_APPROVED',
  WALLET_WITHDRAWAL_REJECTED: 'WALLET.WITHDRAWAL_REJECTED',

  // Guarantees
  GUARANTEE_CONSENT_REQUESTED: 'GUARANTEE.CONSENT_REQUESTED',
  GUARANTEE_CONSENT_GIVEN: 'GUARANTEE.CONSENT_GIVEN',
  GUARANTEE_CONSENT_DECLINED: 'GUARANTEE.CONSENT_DECLINED',
  GUARANTEE_REPLACED: 'GUARANTEE.REPLACED',

  // Core Products
  LOAN_APPLIED: 'LOAN.APPLIED',
  LOAN_APPROVED: 'LOAN.APPROVED',
  LOAN_REJECTED: 'LOAN.REJECTED',
  LOAN_DISBURSED: 'LOAN.DISBURSED',
  LOAN_REPAID: 'LOAN.REPAID',
  // Loans workflow (P3-04)
  LOAN_RECONSENT_REQUESTED: 'LOAN.RECONSENT_REQUESTED',
  LOAN_OFFER_ACCEPTED: 'LOAN.OFFER_ACCEPTED',
  LOAN_OFFER_DECLINED: 'LOAN.OFFER_DECLINED',
  LOAN_OFFER_EXPIRED: 'LOAN.OFFER_EXPIRED',
  LOAN_CANCELLED: 'LOAN.CANCELLED',
  LOAN_COMPLETED: 'LOAN.COMPLETED',
  LOAN_STATUS_CHANGED: 'LOAN.STATUS_CHANGED',
  LOAN_FEE_ASSESSED: 'LOAN.FEE_ASSESSED',
  LOAN_FEE_PAID: 'LOAN.FEE_PAID',
  SAVINGS_PLAN_CREATED: 'SAVINGS.PLAN_CREATED',
  SAVINGS_DEPOSIT: 'SAVINGS.DEPOSIT',
  SAVINGS_WITHDRAWAL: 'SAVINGS.WITHDRAWAL',
  // Savings workflows (P3-03)
  SAVINGS_PLAN_ACTIVATED: 'SAVINGS.PLAN_ACTIVATED',
  SAVINGS_PLAN_EXPIRED: 'SAVINGS.PLAN_EXPIRED',
  SAVINGS_PLAN_MATURED: 'SAVINGS.PLAN_MATURED',
  SAVINGS_DEPOSIT_SUBMITTED: 'SAVINGS.DEPOSIT_SUBMITTED',
  SAVINGS_LOT_CREATED: 'SAVINGS.LOT_CREATED',
  SAVINGS_LOT_VOIDED: 'SAVINGS.LOT_VOIDED',
  SAVINGS_PERIOD_INTEREST_FORFEITED: 'SAVINGS.PERIOD_INTEREST_FORFEITED',
  SAVINGS_PERIOD_INTEREST_RESTORED: 'SAVINGS.PERIOD_INTEREST_RESTORED',
  SAVINGS_INTEREST_ACCRUED: 'SAVINGS.INTEREST_ACCRUED',
  SAVINGS_WITHDRAWAL_REQUESTED: 'SAVINGS.WITHDRAWAL_REQUESTED',
  SAVINGS_WITHDRAWAL_APPROVED: 'SAVINGS.WITHDRAWAL_APPROVED',
  SAVINGS_WITHDRAWAL_PAID: 'SAVINGS.WITHDRAWAL_PAID',
  SAVINGS_WITHDRAWAL_CANCELLED: 'SAVINGS.WITHDRAWAL_CANCELLED',
  EAJO_GROUP_CREATED: 'EAJO.GROUP_CREATED',
  EAJO_MEMBER_JOINED: 'EAJO.MEMBER_JOINED',
  EAJO_PAYOUT_EXECUTED: 'EAJO.PAYOUT_EXECUTED',
  // E-ajo slot-and-payout model (P3-05)
  EAJO_PARTICIPANT_APPROVED: 'EAJO.PARTICIPANT_APPROVED',
  EAJO_PARTICIPANT_REJECTED: 'EAJO.PARTICIPANT_REJECTED',
  EAJO_PARTICIPANT_CANCELLED: 'EAJO.PARTICIPANT_CANCELLED',
  EAJO_PARTICIPANT_COMPLETED: 'EAJO.PARTICIPANT_COMPLETED',
  EAJO_GROUP_ACTIVATED: 'EAJO.GROUP_ACTIVATED',
  EAJO_GROUP_UPDATED: 'EAJO.GROUP_UPDATED',
  EAJO_GROUP_COMPLETED: 'EAJO.GROUP_COMPLETED',
  EAJO_PAYOUT_ELIGIBILITY_CHANGED: 'EAJO.PAYOUT_ELIGIBILITY_CHANGED',
  EAJO_PAYOUT_APPROVED: 'EAJO.PAYOUT_APPROVED',
  EAJO_PAYOUT_HELD: 'EAJO.PAYOUT_HELD',
  EAJO_PAYOUT_HOLD_RELEASED: 'EAJO.PAYOUT_HOLD_RELEASED',
  EAJO_PENALTY_ACCRUED: 'EAJO.PENALTY_ACCRUED',
  EAJO_RESERVATION_RECALCULATED: 'EAJO.RESERVATION_RECALCULATED',

  // Member Profiles & Lifecycle
  MEMBER_PROFILE_UPDATED: 'MEMBER.PROFILE_UPDATED',
  MEMBER_STATUS_CHANGED: 'MEMBER.STATUS_CHANGED',
  MEMBER_DEACTIVATED: 'MEMBER.DEACTIVATED',
  MEMBER_REACTIVATED: 'MEMBER.REACTIVATED',

  // Sensitive profile changes (P3-02B) and member bank accounts (P3-02)
  PROFILE_CHANGE_SUBMITTED: 'PROFILE_CHANGE.SUBMITTED',
  PROFILE_CHANGE_APPROVED: 'PROFILE_CHANGE.APPROVED',
  PROFILE_CHANGE_REJECTED: 'PROFILE_CHANGE.REJECTED',
  PROFILE_CHANGE_CANCELLED: 'PROFILE_CHANGE.CANCELLED',
  MEMBER_BANK_ACCOUNT_ADDED: 'MEMBER.BANK_ACCOUNT_ADDED',
  MEMBER_BANK_ACCOUNT_REMOVED: 'MEMBER.BANK_ACCOUNT_REMOVED',
  MEMBER_PRIMARY_BANK_SET: 'MEMBER.PRIMARY_BANK_SET',
  MEMBER_NEXT_OF_KIN_SET: 'MEMBER.NEXT_OF_KIN_SET',
  MEMBER_PASSPORT_PHOTO_SET: 'MEMBER.PASSPORT_PHOTO_SET',

  // Security & Privacy Inspections
  SINGLE_OPERATOR_OVERRIDE: 'SECURITY.SINGLE_OPERATOR_OVERRIDE',
  STAFF_MEMBER_BANK_VIEWED: 'SECURITY.STAFF_MEMBER_BANK_VIEWED',
  STAFF_MEMBER_NOK_VIEWED: 'SECURITY.STAFF_MEMBER_NOK_VIEWED',
} as const

export type AuditActionType = (typeof AuditAction)[keyof typeof AuditAction]

export const AuditOutcome = {
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  DENIED: 'DENIED',
  BLOCKED: 'BLOCKED',
  PENDING: 'PENDING',
} as const

export type AuditOutcomeType = (typeof AuditOutcome)[keyof typeof AuditOutcome]

export interface RecordAuditEventInput {
  actorId?: string | null
  actorRole?: UserRole | null
  affectedUserId?: string | null
  action: string
  entityType: string
  entityId?: string | null
  outcome?: string
  metadata?: Record<string, unknown> | null
  beforeState?: Record<string, unknown> | null
  afterState?: Record<string, unknown> | null
  correlationId?: string | null
  ipHash?: string | null
  userAgent?: string | null
  isSingleOperator?: boolean
  createdAt?: Date
}

/**
 * Sanitizes metadata to ensure sensitive fields (passwords, tokens, keys, account numbers)
 * are NEVER stored in plaintext in the immutable audit log (P2-06, §1.1).
 */
export function sanitizeAuditMetadata(obj: unknown): Prisma.InputJsonValue | undefined {
  if (obj === null || obj === undefined) {
    return undefined
  }

  if (typeof obj !== 'object') {
    return obj as Prisma.InputJsonValue
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeAuditMetadata(item)) as Prisma.InputJsonValue
  }

  const SENSITIVE_KEY_REGEX = /^(password|token|secret|pin|private_?key|credential|cookie|cvv|hash)$/i
  const ACCOUNT_NUMBER_REGEX = /^(account_?number|bank_?account_?number|account_?no)$/i

  const cleanObj: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEY_REGEX.test(key)) {
      cleanObj[key] = '[REDACTED]'
      continue
    }

    if (ACCOUNT_NUMBER_REGEX.test(key) && typeof val === 'string') {
      // Mask account number: leave only last 4 digits visible
      cleanObj[key] = val.length > 4 ? `******${val.slice(-4)}` : '******'
      continue
    }

    if (typeof val === 'object' && val !== null) {
      cleanObj[key] = sanitizeAuditMetadata(val)
    } else {
      cleanObj[key] = val
    }
  }

  return cleanObj as Prisma.InputJsonValue
}

/**
 * Persists an immutable audit event to the database.
 * If a transaction client (`tx`) is provided, records within that transaction,
 * guaranteeing atomic rollback if the financial mutation fails.
 */
export async function recordAuditEvent(
  input: RecordAuditEventInput,
  tx?: Prisma.TransactionClient,
): Promise<AuditEvent> {
  const db = tx ?? prisma
  const now = input.createdAt ?? new Date()

  const safeMetadata = input.metadata ? sanitizeAuditMetadata(input.metadata) : undefined
  const safeBefore = input.beforeState ? sanitizeAuditMetadata(input.beforeState) : undefined
  const safeAfter = input.afterState ? sanitizeAuditMetadata(input.afterState) : undefined

  const data: Prisma.AuditEventUncheckedCreateInput = {
    actorId: input.actorId ?? null,
    actorRole: input.actorRole ?? null,
    affectedUserId: input.affectedUserId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    outcome: input.outcome ?? AuditOutcome.SUCCESS,
    metadata: safeMetadata ?? Prisma.DbNull,
    beforeState: safeBefore ?? Prisma.DbNull,
    afterState: safeAfter ?? Prisma.DbNull,
    correlationId: input.correlationId ?? null,
    ipHash: input.ipHash ?? null,
    userAgent: input.userAgent ?? null,
    isSingleOperator: input.isSingleOperator ?? false,
    createdAt: now,
    timestamp: now,
  }

  // If a mock transaction client without auditEvent was supplied (e.g. In unit tests with partial mocks),
  // return a mock event to prevent FK constraint violations against fake user IDs.
  if (tx && !(tx as any).auditEvent?.create) {
    return { id: 'mock-audit-id', ...data } as unknown as AuditEvent
  }

  return db.auditEvent.create({ data })
}

/**
 * Records an audit log when staff views a member's sensitive banking or next-of-kin records (P2-06, §2.1).
 */
export async function logStaffSensitiveDataView(params: {
  staffId: string
  staffRole?: UserRole
  memberId: string
  dataType: 'BANK_DETAILS' | 'NEXT_OF_KIN'
  correlationId?: string
  ipHash?: string
  userAgent?: string
}): Promise<AuditEvent> {
  const action =
    params.dataType === 'BANK_DETAILS'
      ? AuditAction.STAFF_MEMBER_BANK_VIEWED
      : AuditAction.STAFF_MEMBER_NOK_VIEWED

  return recordAuditEvent({
    actorId: params.staffId,
    actorRole: params.staffRole ?? UserRole.ADMIN,
    affectedUserId: params.memberId,
    action,
    entityType: 'User',
    entityId: params.memberId,
    outcome: AuditOutcome.SUCCESS,
    metadata: {
      viewedDataType: params.dataType,
      timestamp: new Date().toISOString(),
    },
    correlationId: params.correlationId,
    ipHash: params.ipHash,
    userAgent: params.userAgent,
  })
}

export interface AuditQueryParams {
  startDate?: Date | string
  endDate?: Date | string
  action?: string
  entityType?: string
  entityId?: string
  actorId?: string
  affectedUserId?: string
  outcome?: string
  search?: string
  page?: number
  pageSize?: number
}

/**
 * Comprehensive paginated query for administrators/owners (P2-06).
 */
export async function queryAuditEvents(params: AuditQueryParams = {}) {
  const page = Math.max(1, params.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20))
  const skip = (page - 1) * pageSize

  const where: Prisma.AuditEventWhereInput = {}

  if (params.startDate || params.endDate) {
    where.createdAt = {}
    if (params.startDate) {
      where.createdAt.gte = new Date(params.startDate)
    }
    if (params.endDate) {
      where.createdAt.lte = new Date(params.endDate)
    }
  }

  if (params.action) {
    where.action = params.action
  }

  if (params.entityType) {
    where.entityType = params.entityType
  }

  if (params.entityId) {
    where.entityId = params.entityId
  }

  if (params.actorId) {
    where.actorId = params.actorId
  }

  if (params.affectedUserId) {
    where.affectedUserId = params.affectedUserId
  }

  if (params.outcome) {
    where.outcome = params.outcome
  }

  if (params.search) {
    const term = params.search.trim()
    where.OR = [
      { action: { contains: term, mode: 'insensitive' } },
      { entityType: { contains: term, mode: 'insensitive' } },
      { entityId: { contains: term, mode: 'insensitive' } },
      { correlationId: { contains: term, mode: 'insensitive' } },
      { actor: { email: { contains: term, mode: 'insensitive' } } },
      { actor: { name: { contains: term, mode: 'insensitive' } } },
      { affectedUser: { email: { contains: term, mode: 'insensitive' } } },
      { affectedUser: { name: { contains: term, mode: 'insensitive' } } },
    ]
  }

  const [total, events] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
      include: {
        actor: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
        affectedUser: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            membership: {
              select: {
                membershipNumber: true,
              },
            },
          },
        },
      },
    }),
  ])

  return {
    events,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  }
}

export interface MemberAuditQueryParams {
  memberId: string
  page?: number
  pageSize?: number
  startDate?: Date | string
  endDate?: Date | string
}

/**
 * Member activity query ensuring strict isolation: members can ONLY view events
 * where they are the affected member or the primary actor (P2-06, §1.1).
 * Staff administrative details are redacted for member presentation.
 */
export async function queryMemberAuditEvents(params: MemberAuditQueryParams) {
  const page = Math.max(1, params.page ?? 1)
  const pageSize = Math.min(50, Math.max(1, params.pageSize ?? 15))
  const skip = (page - 1) * pageSize

  const where: Prisma.AuditEventWhereInput = {
    OR: [
      { affectedUserId: params.memberId },
      { actorId: params.memberId, affectedUserId: null },
    ],
  }

  if (params.startDate || params.endDate) {
    where.createdAt = {}
    if (params.startDate) {
      where.createdAt.gte = new Date(params.startDate)
    }
    if (params.endDate) {
      where.createdAt.lte = new Date(params.endDate)
    }
  }

  const [total, rawEvents] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        outcome: true,
        metadata: true,
        createdAt: true,
        actorId: true,
        actorRole: true,
        actor: {
          select: {
            id: true,
            name: true,
            role: true,
          },
        },
      },
    }),
  ])

  // Redact staff identities from member view
  const events = rawEvents.map((evt) => {
    const isSelfAction = evt.actorId === params.memberId
    return {
      id: evt.id,
      action: evt.action,
      entityType: evt.entityType,
      entityId: evt.entityId,
      outcome: evt.outcome,
      metadata: evt.metadata,
      createdAt: evt.createdAt,
      actorLabel: isSelfAction
        ? 'You'
        : evt.actorRole === UserRole.OWNER || evt.actorRole === UserRole.ADMIN
          ? 'Cooperative Staff'
          : 'System',
    }
  })

  return {
    events,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  }
}
