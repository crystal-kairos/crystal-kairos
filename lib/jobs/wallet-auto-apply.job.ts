import { prisma } from '@/lib/prisma'
import {
  EAjoMemberStatus,
  EAjoStatus,
  LoanStatus,
  PaymentPeriodStatus,
} from '@/generated/prisma/enums'
import { lagosToday, parseDateOnly, toLagosDateString } from '@/lib/domain/dates'
import { roundMoney } from '@/lib/domain/money'
import { applyWallet } from '@/lib/services/wallet.service'

export interface WalletAutoApplyJobOptions {
  asOf?: Date | string
  batchSize?: number
  actorId?: string | null
}

export interface WalletAutoApplyJobSummary {
  asOf: string
  membersChecked: number
  membersApplied: number
  appliedMembers: number
  paymentsCreated: number
  totalAmountApplied: number
}

/**
 * Catch-up, idempotent due-date automatic wallet application job (D-12, §2.11, Appendix C6, P3-06).
 * Finds members with due (`dueDate <= asOf`) loan instalments or E-Ajo contribution periods
 * and applies available wallet balance in priority order: LOAN -> EAJO (never SAVINGS).
 */
export async function runWalletAutoApplyJob(
  options: WalletAutoApplyJobOptions = {},
): Promise<WalletAutoApplyJobSummary> {
  const asOfStr = options.asOf
    ? toLagosDateString(parseDateOnly(options.asOf))
    : lagosToday()
  const asOfDate = parseDateOnly(asOfStr)
  const batchSize = options.batchSize ?? 50
  const actorId = options.actorId ?? null

  // Collect candidate member IDs with due unpaid loan instalments or E-Ajo periods
  const dueLoanBorrowers = await prisma.loanInstalment.findMany({
    where: {
      dueDate: { lte: asOfDate },
      status: { not: PaymentPeriodStatus.COMPLETED },
      loan: {
        status: {
          in: [LoanStatus.DISBURSED, LoanStatus.ACTIVE, LoanStatus.OVERDUE],
        },
      },
    },
    select: {
      loan: {
        select: { userId: true },
      },
    },
    distinct: ['loanId'],
  })

  const dueEAjoParticipants = await prisma.eAjoContributionPeriod.findMany({
    where: {
      dueDate: { lte: asOfDate },
      status: { not: PaymentPeriodStatus.COMPLETED },
      eajoMember: {
        status: EAjoMemberStatus.ACTIVE,
        group: {
          status: EAjoStatus.ACTIVE,
        },
      },
    },
    select: {
      eajoMember: {
        select: { userId: true },
      },
    },
    distinct: ['eajoMemberId'],
  })

  const candidateMemberIds = Array.from(
    new Set([
      ...dueLoanBorrowers.map((r) => r.loan.userId),
      ...dueEAjoParticipants.map((r) => r.eajoMember.userId),
    ]),
  ).sort()

  let membersChecked = 0
  let membersApplied = 0
  let paymentsCreated = 0
  let totalAmountApplied = 0

  for (let i = 0; i < candidateMemberIds.length; i += batchSize) {
    const chunk = candidateMemberIds.slice(i, i + batchSize)
    for (const memberId of chunk) {
      membersChecked++
      const res = await applyWallet({
        memberId,
        mode: 'AUTO',
        asOf: asOfStr,
        actorId,
        idempotencyKey: `auto-wallet:${memberId}:${asOfStr}`,
      })

      if (res.payment) {
        membersApplied++
        if (!res.idempotentReplay) {
          paymentsCreated++
        }
        totalAmountApplied = Number(
          roundMoney(totalAmountApplied + Number(res.payment.totalConfirmedAmount)),
        )
      }
    }
  }

  return {
    asOf: asOfStr,
    membersChecked,
    membersApplied,
    appliedMembers: membersApplied,
    paymentsCreated,
    totalAmountApplied,
  }
}
