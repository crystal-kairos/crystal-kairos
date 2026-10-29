import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import {
  DisbursementPurpose,
  DisbursementStatus,
  LedgerAccountType,
} from '@/generated/prisma/client'
import { AppError } from '@/lib/errors/app-error'
import { lockMembers } from '@/lib/db/concurrency'
import { formatSequentialNumber } from '@/lib/domain/payment-reference'
import { postJournalEntry } from '@/lib/services/ledger.service'
import { recordAuditEvent, AuditAction, AuditOutcome } from '@/lib/services/audit.service'
import { enforceDualControl } from '@/lib/authz/guards'
import { AdminPermission } from '@/generated/prisma/enums'

export interface RequestDisbursementInput {
  recipientUserId: string
  purpose: DisbursementPurpose
  amount: number | Prisma.Decimal
  bankAccountId: string
  requestedById: string
  idempotencyKey?: string
}

export interface ApproveDisbursementInput {
  disbursementId: string
  approvedById: string
}

export interface DisbursePaymentInput {
  disbursementId: string
  disbursedById: string
  bankReference: string
  valueDate: Date | string
  actorStaff?: any
}

/**
 * Requests money paid out of cooperative cash (§1.4, §1.5, §2.11, §3.4.5)
 */
export async function requestDisbursement(
  input: RequestDisbursementInput,
  db: typeof prisma = prisma,
) {
  const { recipientUserId, purpose, amount, bankAccountId, requestedById } = input
  const numAmount = Number(amount)

  if (numAmount <= 0) {
    throw new AppError('INVALID_AMOUNT', 'Disbursement amount must be greater than zero.', {
      statusCode: 400,
    })
  }

  const count = await db.disbursement.count()
  const disbursementNumber = formatSequentialNumber('DSB', count + 1)
  const idempotencyKey = input.idempotencyKey || `disb-req:${disbursementNumber}`

  const disbursement = await db.disbursement.create({
    data: {
      disbursementNumber,
      recipientUserId,
      purpose,
      amount: numAmount,
      bankAccountId,
      requestedById,
      status: DisbursementStatus.REQUESTED,
      valueDate: new Date(),
      idempotencyKey,
    },
  })

  await recordAuditEvent({
    actorId: requestedById,
    affectedUserId: recipientUserId,
    action: AuditAction.DISBURSEMENT_REQUESTED,
    entityType: 'Disbursement',
    entityId: disbursement.id,
    outcome: AuditOutcome.SUCCESS,
    metadata: {
      disbursementNumber,
      purpose,
      amount: numAmount,
    },
  })

  return disbursement
}

/**
 * Approves a requested disbursement.
 */
export async function approveDisbursement(
  input: ApproveDisbursementInput,
  db: typeof prisma = prisma,
) {
  const { disbursementId, approvedById } = input

  const disbursement = await db.disbursement.findUnique({
    where: { id: disbursementId },
  })

  if (!disbursement) {
    throw new AppError('NOT_FOUND', 'Disbursement not found.', { statusCode: 404 })
  }

  if (disbursement.status !== DisbursementStatus.REQUESTED) {
    throw new AppError(
      'INVALID_STATUS',
      `Disbursement in ${disbursement.status} status cannot be approved.`,
      { statusCode: 400 },
    )
  }

  const updated = await db.disbursement.update({
    where: { id: disbursementId },
    data: {
      status: DisbursementStatus.APPROVED,
      approvedById,
    },
  })

  await recordAuditEvent({
    actorId: approvedById,
    affectedUserId: disbursement.recipientUserId,
    action: AuditAction.DISBURSEMENT_APPROVED,
    entityType: 'Disbursement',
    entityId: disbursement.id,
    outcome: AuditOutcome.SUCCESS,
    metadata: {
      disbursementNumber: disbursement.disbursementNumber,
      approvedById,
    },
  })

  return updated
}

/**
 * Executes a disbursement: confirms cash payout with valueDate and bankReference,
 * enforces dual control (A-19), posts double-entry journal entry.
 */
export async function disbursePayment(
  input: DisbursePaymentInput,
  db: typeof prisma = prisma,
) {
  const { disbursementId, disbursedById, bankReference, valueDate, actorStaff } = input

  if (!bankReference || bankReference.trim().length === 0) {
    throw new AppError('BANK_REFERENCE_REQUIRED', 'Bank reference is required for disbursement.', {
      statusCode: 400,
    })
  }

  return db.$transaction(async (tx) => {
    const disbursement = await tx.disbursement.findUnique({
      where: { id: disbursementId },
    })

    if (!disbursement) {
      throw new AppError('NOT_FOUND', 'Disbursement not found.', { statusCode: 404 })
    }

    if (disbursement.status === DisbursementStatus.PAID) {
      return { disbursement, isReplay: true }
    }

    if (disbursement.status !== DisbursementStatus.APPROVED) {
      throw new AppError(
        'INVALID_STATUS',
        `Disbursement must be APPROVED before paying out (current status: ${disbursement.status}).`,
        { statusCode: 400 },
      )
    }

    // Dual control check (A-19): if staff actor object passed
    if (actorStaff) {
      await enforceDualControl(
        {
          actor: actorStaff,
          previousActorId: disbursement.approvedById,
          requiredPermission: AdminPermission.LOANS_DISBURSE,
        },
        tx as any,
      )
    }

    // Advisory lock on recipient
    await lockMembers(tx, [disbursement.recipientUserId])

    const payoutDate = new Date(valueDate)
    const amountNum = Number(disbursement.amount)

    // Debit account determination per §2.12
    let debitAccount: LedgerAccountType = LedgerAccountType.LOAN_RECEIVABLE_PRINCIPAL
    if (disbursement.purpose === DisbursementPurpose.SAVINGS_PAYOUT) {
      debitAccount = LedgerAccountType.SAVINGS_PRINCIPAL_LIABILITY
    } else if (disbursement.purpose === DisbursementPurpose.WALLET_WITHDRAWAL) {
      debitAccount = LedgerAccountType.MEMBER_WALLET_LIABILITY
    } else if (disbursement.purpose === DisbursementPurpose.EAJO_PAYOUT) {
      debitAccount = LedgerAccountType.EAJO_ADVANCE_RECEIVABLE
    } else if (disbursement.purpose === DisbursementPurpose.MEMBER_SETTLEMENT) {
      debitAccount = LedgerAccountType.MEMBER_SETTLEMENT_PAYABLE
    }

    const journalEntry = await postJournalEntry(tx, {
      sourceType: 'DISBURSEMENT',
      sourceId: disbursement.id,
      idempotencyKey: `disbursement:${disbursement.id}`,
      description: `Disbursement ${disbursement.disbursementNumber} (${disbursement.purpose})`,
      effectiveDate: payoutDate,
      postedById: disbursedById,
      lines: [
        {
          accountType: debitAccount,
          debit: amountNum,
          credit: 0,
          memberId: disbursement.recipientUserId,
        },
        {
          accountType: LedgerAccountType.COOPERATIVE_CASH,
          debit: 0,
          credit: amountNum,
          memberId: disbursement.recipientUserId,
        },
      ],
    })

    const updated = await tx.disbursement.update({
      where: { id: disbursement.id },
      data: {
        status: DisbursementStatus.PAID,
        disbursedById,
        disbursedAt: new Date(),
        bankReference: bankReference.trim(),
        valueDate: payoutDate,
        journalEntryId: journalEntry.id,
      },
    })

    await recordAuditEvent(
      {
        actorId: disbursedById,
        affectedUserId: disbursement.recipientUserId,
        action: AuditAction.DISBURSEMENT_EXECUTED,
        entityType: 'Disbursement',
        entityId: disbursement.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: {
          disbursementNumber: disbursement.disbursementNumber,
          purpose: disbursement.purpose,
          amount: amountNum,
          bankReference: bankReference.trim(),
          journalEntryId: journalEntry.id,
        },
      },
      tx,
    )

    return {
      disbursement: updated,
      journalEntry,
    }
  })
}
