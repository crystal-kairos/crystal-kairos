import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import {
  AllocationStatus,
  AllocationTargetType,
  PaymentComponentType,
  PaymentPeriodStatus,
  PaymentSource,
  PaymentStatus,
  PaymentSubmissionStatus,
  SubmissionPurpose,
} from '@/generated/prisma/client'
import { AppError } from '@/lib/errors/app-error'
import { lockMembers } from '@/lib/db/concurrency'
import {
  calculatePaymentAllocation,
  AllocationPeriodItem,
} from '@/lib/services/allocation.service'
import { formatSequentialNumber } from '@/lib/domain/payment-reference'
import { postJournalEntry, reverseJournalEntry } from '@/lib/services/ledger.service'
import { LedgerAccountType } from '@/generated/prisma/enums'
import { recordAuditEvent, AuditAction, AuditOutcome } from '@/lib/services/audit.service'

export interface CreatePaymentSubmissionInput {
  memberId: string
  claimedAmount: number | Prisma.Decimal
  paidOn: Date | string
  purpose?: SubmissionPurpose
  receivingBankAccountId?: string
  bankReference?: string
  payerAccountName?: string
  receiptFileId?: string
  fileHash?: string
  narration?: string
  targets: {
    targetType: AllocationTargetType
    targetId: string
    targetPeriodId?: string
    requestedAmount: number | Prisma.Decimal
  }[]
}

export interface ConfirmPaymentSubmissionInput {
  submissionId: string
  confirmedById: string
  confirmedAmount?: number | Prisma.Decimal
  valueDate?: Date | string
  valueDateChangeReason?: string
  allowDuplicateOverride?: boolean
  isOwner?: boolean
}

export interface ReversePaymentInput {
  paymentId: string
  reversedById: string
  reversalReason: string
  isOwner?: boolean
}

/**
 * Creates a member payment submission (§2.10, §3.4.1)
 * Enforces date validations, duplicate detection, and sequential numbering.
 */
export async function createPaymentSubmission(
  input: CreatePaymentSubmissionInput,
  db: typeof prisma = prisma,
) {
  const { memberId, claimedAmount, paidOn, targets } = input
  const numAmount = Number(claimedAmount)

  if (numAmount <= 0 || isNaN(numAmount)) {
    throw new AppError(
      'INVALID_AMOUNT',
      'Claimed payment amount must be greater than zero.',
      { statusCode: 400 },
    )
  }

  const member = await db.user.findUnique({
    where: { id: memberId },
    select: { id: true, isActive: true },
  })

  if (!member || member.isActive === false) {
    throw new AppError(
      'MEMBER_INACTIVE',
      'Payment submission rejected: member account is inactive or not found.',
      { statusCode: 403 },
    )
  }

  const paymentDate = new Date(paidOn)
  if (isNaN(paymentDate.getTime())) {
    throw new AppError('INVALID_DATE', 'Invalid payment date.', {
      statusCode: 400,
    })
  }

  // paidOn cannot be in the future (relative to today)
  const now = new Date()
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  if (paymentDate > todayEnd) {
    throw new AppError(
      'FUTURE_DATE_NOT_ALLOWED',
      'Payment date cannot be in the future.',
      { statusCode: 400 },
    )
  }

  // paidOn cannot be older than maxBackdateDays (default 30)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  thirtyDaysAgo.setHours(0, 0, 0, 0)
  if (paymentDate < thirtyDaysAgo) {
    throw new AppError(
      'PAYMENT_DATE_TOO_OLD',
      'Payment date cannot be older than 30 days.',
      { statusCode: 400 },
    )
  }

  let hasDuplicateHashWarning = false
  let hasDuplicateReferenceWarning = false

  // Duplicate detection (§2.10)
  if (input.fileHash) {
    const confirmedWithHash = await db.paymentSubmission.findFirst({
      where: {
        fileHash: input.fileHash,
        status: PaymentSubmissionStatus.CONFIRMED,
      },
      select: { id: true },
    })
    if (confirmedWithHash) {
      throw new AppError(
        'DUPLICATE_PAYMENT',
        'Duplicate receipt detected: This file has already been confirmed in another payment.',
        { statusCode: 409 },
      )
    }

    const pendingWithHash = await db.paymentSubmission.findFirst({
      where: {
        fileHash: input.fileHash,
        status: PaymentSubmissionStatus.SUBMITTED,
      },
      select: { id: true },
    })
    if (pendingWithHash) {
      hasDuplicateHashWarning = true
    }
  }

  if (input.bankReference) {
    const confirmedRef = await db.paymentSubmission.findFirst({
      where: {
        bankReference: input.bankReference,
        claimedAmount: numAmount,
        paidOn: paymentDate,
        status: PaymentSubmissionStatus.CONFIRMED,
      },
      select: { id: true },
    })
    if (confirmedRef) {
      throw new AppError(
        'DUPLICATE_PAYMENT',
        'Duplicate payment detected: A confirmed payment with this bank reference, amount, and date already exists.',
        { statusCode: 409 },
      )
    }

    const pendingRef = await db.paymentSubmission.findFirst({
      where: {
        bankReference: input.bankReference,
        claimedAmount: numAmount,
        paidOn: paymentDate,
        status: PaymentSubmissionStatus.SUBMITTED,
      },
      select: { id: true },
    })
    if (pendingRef) {
      hasDuplicateReferenceWarning = true
    }
  }

  // Generate sequential submissionNumber (SUB-000001)
  const count = await db.paymentSubmission.count()
  const submissionNumber = formatSequentialNumber('SUB', count + 1)

  const submission = await db.paymentSubmission.create({
    data: {
      submissionNumber,
      memberId,
      purpose: input.purpose,
      receivingBankAccountId: input.receivingBankAccountId,
      claimedAmount: numAmount,
      paidOn: paymentDate,
      bankReference: input.bankReference,
      payerAccountName: input.payerAccountName,
      receiptFileId: input.receiptFileId,
      fileHash: input.fileHash,
      narration: input.narration,
      status: PaymentSubmissionStatus.SUBMITTED,
      targets: {
        create: targets.map((t) => ({
          targetType: t.targetType,
          targetId: t.targetId,
          targetPeriodId: t.targetPeriodId,
          requestedAmount: Number(t.requestedAmount),
        })),
      },
    },
    include: {
      targets: true,
    },
  })

  await recordAuditEvent({
    actorId: memberId,
    affectedUserId: memberId,
    action: AuditAction.PAYMENT_SUBMITTED,
    entityType: 'PaymentSubmission',
    entityId: submission.id,
    outcome: AuditOutcome.SUCCESS,
    metadata: {
      submissionNumber,
      claimedAmount: numAmount,
      paidOn: paymentDate.toISOString(),
      bankReference: input.bankReference,
      targetCount: targets.length,
    },
  })

  return {
    submission,
    warnings: {
      hasDuplicateHashWarning,
      hasDuplicateReferenceWarning,
    },
  }
}

/**
 * Confirms a payment submission atomically under lockMembers (§2.10, §2.12).
 * Applies allocation waterfall, updates periods, posts double-entry journal entry,
 * and updates submission status.
 */
export async function confirmPaymentSubmission(
  input: ConfirmPaymentSubmissionInput,
  db: typeof prisma = prisma,
) {
  const { submissionId, confirmedById } = input

  return db.$transaction(async (tx) => {
    const submission = await tx.paymentSubmission.findUnique({
      where: { id: submissionId },
      include: { targets: true, payment: true },
    })

    if (!submission) {
      throw new AppError('NOT_FOUND', 'Payment submission not found.', {
        statusCode: 404,
      })
    }

    // Idempotent replay: if already confirmed, return existing payment
    if (submission.status === PaymentSubmissionStatus.CONFIRMED && submission.payment) {
      return {
        payment: submission.payment,
        submission,
        isReplay: true,
      }
    }

    if (submission.status !== PaymentSubmissionStatus.SUBMITTED) {
      throw new AppError(
        'INVALID_STATUS',
        `Payment submission is in ${submission.status} status and cannot be confirmed.`,
        { statusCode: 400 },
      )
    }

    // 1. Advisory Lock for member
    await lockMembers(tx, [submission.memberId])

    // Duplicate check on confirmed payments
    if (submission.fileHash && !input.allowDuplicateOverride) {
      const duplicateConfirmed = await tx.paymentSubmission.findFirst({
        where: {
          fileHash: submission.fileHash,
          status: PaymentSubmissionStatus.CONFIRMED,
          id: { not: submission.id },
        },
        select: { id: true },
      })
      if (duplicateConfirmed) {
        throw new AppError(
          'DUPLICATE_PAYMENT',
          'A confirmed payment with this receipt already exists. Owner override required.',
          { statusCode: 409 },
        )
      }
    }

    const confirmedAmount = input.confirmedAmount !== undefined
      ? Number(input.confirmedAmount)
      : Number(submission.claimedAmount)

    if (confirmedAmount <= 0) {
      throw new AppError(
        'INVALID_AMOUNT',
        'Confirmed amount must be greater than zero.',
        { statusCode: 400 },
      )
    }

    const valueDate = input.valueDate
      ? new Date(input.valueDate)
      : new Date(submission.paidOn)

    if (
      input.valueDate &&
      new Date(input.valueDate).toDateString() !== new Date(submission.paidOn).toDateString() &&
      !input.valueDateChangeReason
    ) {
      throw new AppError(
        'REASON_REQUIRED',
        'A reason is required when changing the payment value date.',
        { statusCode: 400 },
      )
    }

    // 2. Fetch target periods
    const periodItems: AllocationPeriodItem[] = []

    for (const target of submission.targets) {
      if (target.targetType === AllocationTargetType.LOAN && target.targetPeriodId) {
        const instalment = await tx.loanInstalment.findUnique({
          where: { id: target.targetPeriodId },
        })
        if (instalment) {
          const penaltyDue = Math.max(
            0,
            Number(instalment.penaltyAssessed) -
              Number(instalment.penaltyPaid) -
              Number(instalment.penaltyWaived),
          )
          const interestDue = Math.max(
            0,
            Number(instalment.interestDue) - Number(instalment.interestPaid),
          )
          const principalDue = Math.max(
            0,
            Number(instalment.principalDue) - Number(instalment.principalPaid),
          )

          periodItems.push({
            periodId: instalment.id,
            targetType: 'LOAN',
            targetId: instalment.loanId,
            periodNumber: instalment.instalmentNumber,
            dueDate: instalment.dueDate,
            penaltyDue,
            interestDue,
            principalDue,
          })
        }
      } else if (target.targetType === AllocationTargetType.SAVINGS && target.targetPeriodId) {
        const period = await tx.savingsPeriod.findUnique({
          where: { id: target.targetPeriodId },
        })
        if (period) {
          const principalDue = Math.max(
            0,
            Number(period.amountDue) - Number(period.amountPaid),
          )

          periodItems.push({
            periodId: period.id,
            targetType: 'SAVINGS',
            targetId: period.savingsId,
            periodNumber: period.periodNumber,
            dueDate: period.dueDate,
            penaltyDue: 0,
            interestDue: 0,
            principalDue,
          })
        }
      } else if (target.targetType === AllocationTargetType.EAJO && target.targetPeriodId) {
        const period = await tx.eAjoContributionPeriod.findUnique({
          where: { id: target.targetPeriodId },
        })
        if (period) {
          const penaltyDue = Math.max(
            0,
            Number(period.penaltyAssessed) -
              Number(period.penaltyPaid) -
              Number(period.penaltyWaived),
          )
          const principalDue = Math.max(
            0,
            Number(period.contributionDue) - Number(period.contributionPaid),
          )

          periodItems.push({
            periodId: period.id,
            targetType: 'EAJO',
            targetId: period.eajoMemberId,
            periodNumber: period.periodNumber,
            dueDate: period.dueDate,
            penaltyDue,
            interestDue: 0,
            principalDue,
          })
        }
      }
    }

    // 3. Compute allocation waterfall
    const allocationResult = calculatePaymentAllocation({
      amount: confirmedAmount,
      memberId: submission.memberId,
      periods: periodItems,
    })

    // 4. Create Payment record
    const paymentCount = await tx.payment.count()
    const paymentNumber = formatSequentialNumber('PAY', paymentCount + 1)
    const idempotencyKey = `payment:${submission.id}`

    const payment = await tx.payment.create({
      data: {
        paymentNumber,
        source: PaymentSource.RECEIPT,
        submissionId: submission.id,
        memberId: submission.memberId,
        totalConfirmedAmount: confirmedAmount,
        valueDate,
        status: PaymentStatus.CONFIRMED,
        confirmedById,
        idempotencyKey,
      },
    })

    // 5. Create PaymentAllocation records & update period records
    const createdAllocations = []
    for (const alloc of allocationResult.allocations) {
      const createdAlloc = await tx.paymentAllocation.create({
        data: {
          paymentId: payment.id,
          targetType: alloc.targetType,
          targetId: alloc.targetId,
          periodId: alloc.periodId,
          componentType: alloc.componentType,
          amount: alloc.amount,
          status: AllocationStatus.ACTIVE,
        },
      })
      createdAllocations.push(createdAlloc)

      // Apply to periods
      if (alloc.periodId) {
        if (alloc.targetType === AllocationTargetType.LOAN) {
          const updateData: Prisma.LoanInstalmentUpdateInput = {}
          if (alloc.componentType === PaymentComponentType.PENALTY) {
            updateData.penaltyPaid = { increment: alloc.amount }
          } else if (alloc.componentType === PaymentComponentType.INTEREST) {
            updateData.interestPaid = { increment: alloc.amount }
          } else if (alloc.componentType === PaymentComponentType.PRINCIPAL) {
            updateData.principalPaid = { increment: alloc.amount }
          }
          await tx.loanInstalment.update({
            where: { id: alloc.periodId },
            data: updateData,
          })
          // Update status if fully paid
          const refreshed = await tx.loanInstalment.findUnique({
            where: { id: alloc.periodId },
          })
          if (
            refreshed &&
            Number(refreshed.principalPaid) >= Number(refreshed.principalDue) &&
            Number(refreshed.interestPaid) >= Number(refreshed.interestDue) &&
            Number(refreshed.penaltyPaid) >=
              Number(refreshed.penaltyAssessed) - Number(refreshed.penaltyWaived)
          ) {
            await tx.loanInstalment.update({
              where: { id: alloc.periodId },
              data: { status: PaymentPeriodStatus.COMPLETED },
            })
          }
        } else if (alloc.targetType === AllocationTargetType.SAVINGS) {
          await tx.savingsPeriod.update({
            where: { id: alloc.periodId },
            data: { amountPaid: { increment: alloc.amount } },
          })
          const refreshed = await tx.savingsPeriod.findUnique({
            where: { id: alloc.periodId },
          })
          if (
            refreshed &&
            Number(refreshed.amountPaid) >= Number(refreshed.amountDue)
          ) {
            await tx.savingsPeriod.update({
              where: { id: alloc.periodId },
              data: { status: PaymentPeriodStatus.COMPLETED },
            })
          }
        } else if (alloc.targetType === AllocationTargetType.EAJO) {
          const updateData: Prisma.EAjoContributionPeriodUpdateInput = {}
          if (alloc.componentType === PaymentComponentType.PENALTY) {
            updateData.penaltyPaid = { increment: alloc.amount }
          } else if (alloc.componentType === PaymentComponentType.CONTRIBUTION) {
            updateData.contributionPaid = { increment: alloc.amount }
          }
          await tx.eAjoContributionPeriod.update({
            where: { id: alloc.periodId },
            data: updateData,
          })
          const refreshed = await tx.eAjoContributionPeriod.findUnique({
            where: { id: alloc.periodId },
          })
          if (
            refreshed &&
            Number(refreshed.contributionPaid) >= Number(refreshed.contributionDue) &&
            Number(refreshed.penaltyPaid) >=
              Number(refreshed.penaltyAssessed) - Number(refreshed.penaltyWaived)
          ) {
            await tx.eAjoContributionPeriod.update({
              where: { id: alloc.periodId },
              data: { status: PaymentPeriodStatus.COMPLETED },
            })
          }
        }
      }
    }

    // 6. Post Double-Entry Journal Entry (§2.12)
    const journalLines: {
      accountType: LedgerAccountType
      debit: number
      credit: number
      memberId?: string
      accountRefType?: string
      accountRefId?: string
    }[] = [
      {
        accountType: LedgerAccountType.COOPERATIVE_CASH,
        debit: confirmedAmount,
        credit: 0,
      },
    ]

    for (const alloc of allocationResult.allocations) {
      let accountType: LedgerAccountType = LedgerAccountType.MEMBER_WALLET_LIABILITY
      if (alloc.targetType === AllocationTargetType.SAVINGS) {
        accountType = LedgerAccountType.SAVINGS_PRINCIPAL_LIABILITY
      } else if (alloc.targetType === AllocationTargetType.LOAN) {
        if (alloc.componentType === PaymentComponentType.PRINCIPAL) {
          accountType = LedgerAccountType.LOAN_RECEIVABLE_PRINCIPAL
        } else if (alloc.componentType === PaymentComponentType.INTEREST) {
          accountType = LedgerAccountType.LOAN_INTEREST_RECEIVABLE
        } else if (alloc.componentType === PaymentComponentType.PENALTY) {
          accountType = LedgerAccountType.LOAN_PENALTY_RECEIVABLE
        }
      } else if (alloc.targetType === AllocationTargetType.EAJO) {
        if (alloc.componentType === PaymentComponentType.PENALTY) {
          accountType = LedgerAccountType.EAJO_PENALTY_RECEIVABLE
        } else {
          accountType = LedgerAccountType.EAJO_CONTRIBUTION_LIABILITY
        }
      } else if (alloc.targetType === AllocationTargetType.FEE) {
        accountType = LedgerAccountType.FEE_INCOME
      }

      journalLines.push({
        accountType,
        debit: 0,
        credit: alloc.amount,
        memberId: submission.memberId,
        accountRefType: alloc.targetType,
        accountRefId: alloc.targetId,
      })
    }

    const journalEntry = await postJournalEntry(tx, {
      sourceType: 'PAYMENT',
      sourceId: payment.id,
      idempotencyKey,
      description: `Payment confirmation for ${submission.submissionNumber}`,
      effectiveDate: valueDate,
      postedById: confirmedById,
      lines: journalLines,
    })

    // Update payment allocations with journalEntryId
    await tx.paymentAllocation.updateMany({
      where: { paymentId: payment.id },
      data: { journalEntryId: journalEntry.id },
    })

    // 7. Update PaymentSubmission status
    const updatedSubmission = await tx.paymentSubmission.update({
      where: { id: submission.id },
      data: {
        status: PaymentSubmissionStatus.CONFIRMED,
        confirmedAt: new Date(),
        confirmedById,
        valueDate,
      },
    })

    await recordAuditEvent(
      {
        actorId: confirmedById,
        affectedUserId: submission.memberId,
        action: AuditAction.PAYMENT_CONFIRMED,
        entityType: 'Payment',
        entityId: payment.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: {
          submissionId: submission.id,
          paymentNumber: payment.paymentNumber,
          totalConfirmedAmount: confirmedAmount,
          valueDate: valueDate.toISOString(),
          allocationCount: createdAllocations.length,
          excessToWallet: allocationResult.excessToWallet,
        },
      },
      tx,
    )

    return {
      payment,
      allocations: createdAllocations,
      submission: updatedSubmission,
      journalEntry,
    }
  })
}

/**
 * Rejects a payment submission with a mandatory reason (§2.10).
 */
export async function rejectPaymentSubmission(params: {
  submissionId: string
  reviewerId: string
  rejectionReason: string
}) {
  const { submissionId, reviewerId, rejectionReason } = params

  if (!rejectionReason || rejectionReason.trim().length === 0) {
    throw new AppError(
      'REJECTION_REASON_REQUIRED',
      'A meaningful rejection reason must be provided.',
      { statusCode: 400 },
    )
  }

  const submission = await prisma.paymentSubmission.findUnique({
    where: { id: submissionId },
  })

  if (!submission) {
    throw new AppError('NOT_FOUND', 'Payment submission not found.', {
      statusCode: 404,
    })
  }

  if (submission.status !== PaymentSubmissionStatus.SUBMITTED) {
    throw new AppError(
      'INVALID_STATUS',
      `Payment submission is in ${submission.status} status and cannot be rejected.`,
      { statusCode: 400 },
    )
  }

  const updated = await prisma.paymentSubmission.update({
    where: { id: submissionId },
    data: {
      status: PaymentSubmissionStatus.REJECTED,
      rejectionReason: rejectionReason.trim(),
      confirmedAt: new Date(),
      confirmedById: reviewerId,
    },
  })

  await recordAuditEvent({
    actorId: reviewerId,
    affectedUserId: submission.memberId,
    action: AuditAction.PAYMENT_REJECTED,
    entityType: 'PaymentSubmission',
    entityId: submission.id,
    outcome: AuditOutcome.SUCCESS,
    metadata: {
      submissionNumber: submission.submissionNumber,
      rejectionReason: rejectionReason.trim(),
    },
  })

  return updated
}

/**
 * Re-upload / resubmission chaining (§2.10, rule 2):
 * Creates a new submission linking to the previous rejected submission, preserving the original.
 */
export async function resubmitPaymentSubmission(
  rejectedSubmissionId: string,
  input: Omit<CreatePaymentSubmissionInput, 'memberId'>,
  db: typeof prisma = prisma,
) {
  const original = await db.paymentSubmission.findUnique({
    where: { id: rejectedSubmissionId },
    select: { id: true, memberId: true, status: true },
  })

  if (!original) {
    throw new AppError('NOT_FOUND', 'Original payment submission not found.', {
      statusCode: 404,
    })
  }

  if (original.status !== PaymentSubmissionStatus.REJECTED) {
    throw new AppError(
      'INVALID_STATUS',
      'Only rejected payment submissions can be resubmitted.',
      { statusCode: 400 },
    )
  }

  const created = await createPaymentSubmission(
    {
      ...input,
      memberId: original.memberId,
    },
    db,
  )

  const updatedSubmission = await db.paymentSubmission.update({
    where: { id: created.submission.id },
    data: { resubmissionOfId: original.id },
    include: { targets: true },
  })

  await recordAuditEvent({
    actorId: original.memberId,
    affectedUserId: original.memberId,
    action: AuditAction.PAYMENT_RESUBMITTED,
    entityType: 'PaymentSubmission',
    entityId: created.submission.id,
    outcome: AuditOutcome.SUCCESS,
    metadata: {
      newSubmissionId: created.submission.id,
      resubmissionOfId: original.id,
    },
  })

  return {
    submission: updatedSubmission,
    warnings: created.warnings,
  }
}

/**
 * Reverses a confirmed payment per §2.10 reversal cascade.
 * Posts reversing journal entries, recomputes periods, marks allocations reversed,
 * and handles audit trails.
 */
export async function reversePayment(
  input: ReversePaymentInput,
  db: typeof prisma = prisma,
) {
  const { paymentId, reversedById, reversalReason, isOwner } = input

  if (!reversalReason || reversalReason.trim().length === 0) {
    throw new AppError('REASON_REQUIRED', 'A reversal reason is required.', {
      statusCode: 400,
    })
  }

  return db.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      include: { allocations: true },
    })

    if (!payment) {
      throw new AppError('NOT_FOUND', 'Payment not found.', { statusCode: 404 })
    }

    if (payment.status === PaymentStatus.REVERSED) {
      return { payment, isReplay: true }
    }

    // A-13: Reversals older than 30 days or above threshold (500,000 NGN) require OWNER
    const paymentAgeDays =
      (Date.now() - new Date(payment.confirmedAt).getTime()) /
      (1000 * 60 * 60 * 24)
    const isAboveThreshold = Number(payment.totalConfirmedAmount) >= 500000
    if ((paymentAgeDays > 30 || isAboveThreshold) && !isOwner) {
      throw new AppError(
        'OWNER_APPROVAL_REQUIRED',
        'Reversals older than 30 days or for amounts of ₦500,000 and above require owner authority.',
        { statusCode: 403 },
      )
    }

    // Lock member
    await lockMembers(tx, [payment.memberId])

    // 1. Revert period increments from allocations (newest first)
    const reversedAllocations = [...payment.allocations].reverse()
    for (const alloc of reversedAllocations) {
      if (alloc.periodId) {
        if (alloc.targetType === AllocationTargetType.LOAN) {
          const updateData: Prisma.LoanInstalmentUpdateInput = {}
          if (alloc.componentType === PaymentComponentType.PENALTY) {
            updateData.penaltyPaid = { decrement: alloc.amount }
          } else if (alloc.componentType === PaymentComponentType.INTEREST) {
            updateData.interestPaid = { decrement: alloc.amount }
          } else if (alloc.componentType === PaymentComponentType.PRINCIPAL) {
            updateData.principalPaid = { decrement: alloc.amount }
          }
          await tx.loanInstalment.update({
            where: { id: alloc.periodId },
            data: updateData,
          })
          // Mark ONGOING / PARTIALLY_PAID if previously marked PAID
          await tx.loanInstalment.update({
            where: { id: alloc.periodId },
            data: { status: PaymentPeriodStatus.ONGOING },
          })
        } else if (alloc.targetType === AllocationTargetType.SAVINGS) {
          await tx.savingsPeriod.update({
            where: { id: alloc.periodId },
            data: {
              amountPaid: { decrement: alloc.amount },
              status: PaymentPeriodStatus.ONGOING,
            },
          })
        } else if (alloc.targetType === AllocationTargetType.EAJO) {
          const updateData: Prisma.EAjoContributionPeriodUpdateInput = {}
          if (alloc.componentType === PaymentComponentType.PENALTY) {
            updateData.penaltyPaid = { decrement: alloc.amount }
          } else if (alloc.componentType === PaymentComponentType.CONTRIBUTION) {
            updateData.contributionPaid = { decrement: alloc.amount }
          }
          await tx.eAjoContributionPeriod.update({
            where: { id: alloc.periodId },
            data: updateData,
          })
          await tx.eAjoContributionPeriod.update({
            where: { id: alloc.periodId },
            data: { status: PaymentPeriodStatus.ONGOING },
          })
        }
      }
    }

    // 2. Mark allocations as REVERSED
    await tx.paymentAllocation.updateMany({
      where: { paymentId: payment.id },
      data: {
        status: AllocationStatus.REVERSED,
        reversedAt: new Date(),
      },
    })

    // 3. Reverse Journal Entry
    const origJournal = await tx.journalEntry.findFirst({
      where: {
        sourceType: 'PAYMENT',
        sourceId: payment.id,
      },
    })
    if (origJournal) {
      await reverseJournalEntry(tx, {
        originalJournalEntryId: origJournal.id,
        idempotencyKey: `reversal:${payment.id}`,
        reason: reversalReason.trim(),
        postedById: reversedById,
      })
    }

    // 4. Update Payment status
    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.REVERSED,
        reversedAt: new Date(),
        reversedById,
        reversalReason: reversalReason.trim(),
      },
    })

    await recordAuditEvent(
      {
        actorId: reversedById,
        affectedUserId: payment.memberId,
        action: AuditAction.PAYMENT_REVERSED,
        entityType: 'Payment',
        entityId: payment.id,
        outcome: AuditOutcome.SUCCESS,
        metadata: {
          paymentId: payment.id,
          reversalReason: reversalReason.trim(),
          amount: Number(payment.totalConfirmedAmount),
        },
      },
      tx,
    )

    return { payment: updatedPayment }
  })
}
