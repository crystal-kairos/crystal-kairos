import { prisma } from '@/lib/prisma'
import { LoanStatus } from '@/generated/prisma/enums'
import { lagosToday, parseDateOnly, toLagosDateString } from '@/lib/domain/dates'
import { roundMoney, toDecimal } from '@/lib/domain/money'
import { postLoanInterestDue } from '@/lib/services/ledger.service'
import { lockMembers } from '@/lib/db/concurrency'
import { AuditAction, recordAuditEvent } from '@/lib/services/audit.service'

export interface InterestRecognitionJobOptions {
  asOf?: Date | string
  batchSize?: number
  actorId?: string | null
}

export interface InterestRecognitionJobSummary {
  asOf: string
  instalmentsChecked: number
  instalmentsRecognised: number
  recognisedInstalments: number
  totalInterestRecognised: number
}

/**
 * Catch-up, idempotent loan interest recognition job (§2.9, §2.12, OQ-14, P3-06).
 * Recognizes `LoanInstalment.interestDue` (`Dr LOAN_INTEREST_RECEIVABLE / Cr LOAN_INTEREST_INCOME`)
 * for all instalments with `dueDate <= asOf` and `interestRecognisedAt === null` on disbursed loans
 * (`DISBURSED`, `ACTIVE`, `OVERDUE`, `COMPLETED`, `DEFAULTED`), including loans that were settled early
 * before all scheduled due dates arrived (OQ-14).
 */
export async function runInterestRecognitionJob(
  options: InterestRecognitionJobOptions = {},
): Promise<InterestRecognitionJobSummary> {
  const asOfStr = options.asOf
    ? toLagosDateString(parseDateOnly(options.asOf))
    : lagosToday()
  const asOfDate = parseDateOnly(asOfStr)
  const batchSize = options.batchSize ?? 50
  const actorId = options.actorId ?? null

  let instalmentsChecked = 0
  let instalmentsRecognised = 0
  let totalInterestRecognised = 0

  let cursor: string | undefined
  while (true) {
    const dueInstalments = await prisma.loanInstalment.findMany({
      where: {
        dueDate: { lte: asOfDate },
        interestRecognisedAt: null,
        loan: {
          status: {
            in: [
              LoanStatus.DISBURSED,
              LoanStatus.ACTIVE,
              LoanStatus.OVERDUE,
              LoanStatus.COMPLETED,
              LoanStatus.DEFAULTED,
            ],
          },
        },
      },
      include: {
        loan: {
          select: {
            id: true,
            userId: true,
          },
        },
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })

    if (dueInstalments.length === 0) break

    for (const inst of dueInstalments) {
      instalmentsChecked++
      const interestAmt = roundMoney(toDecimal(inst.interestDue))

      await prisma.$transaction(async (tx) => {
        await lockMembers(tx, [inst.loan.userId])

        const fresh = await tx.loanInstalment.findUnique({
          where: { id: inst.id },
        })
        if (!fresh || fresh.interestRecognisedAt !== null) {
          return
        }

        if (interestAmt.gt(0)) {
          await postLoanInterestDue(tx, {
            amount: interestAmt,
            memberId: inst.loan.userId,
            loanId: inst.loan.id,
            effectiveDate: fresh.dueDate,
            idempotencyKey: `loan-interest-due:${fresh.id}`,
            postedById: actorId,
            description: `Scheduled loan interest recognition for loan ${inst.loan.id} instalment #${fresh.instalmentNumber}`,
          })
        }

        await tx.loanInstalment.update({
          where: { id: fresh.id },
          data: {
            interestRecognisedAt: new Date(),
          },
        })

        await recordAuditEvent(
          {
            actorId,
            affectedUserId: inst.loan.userId,
            action: AuditAction.FINANCIAL_POSTING,
            entityType: 'LoanInstalment',
            entityId: fresh.id,
            outcome: 'SUCCESS',
            metadata: {
              loanId: inst.loan.id,
              instalmentNumber: fresh.instalmentNumber,
              dueDate: toLagosDateString(fresh.dueDate),
              interestRecognised: Number(interestAmt),
            },
          },
          tx,
        )

        instalmentsRecognised++
        totalInterestRecognised = Number(
          roundMoney(totalInterestRecognised + Number(interestAmt)),
        )
      })
    }

    cursor = dueInstalments[dueInstalments.length - 1].id
    if (dueInstalments.length < batchSize) break
  }

  return {
    asOf: asOfStr,
    instalmentsChecked,
    instalmentsRecognised,
    recognisedInstalments: instalmentsRecognised,
    totalInterestRecognised,
  }
}
