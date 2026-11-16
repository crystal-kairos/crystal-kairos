import type { LoanQuote, SettlementQuote } from '@/lib/domain/loan-workflow'

/**
 * Serialisers for loan data crossing the server/client boundary. Money is
 * calculated with Prisma.Decimal on the server; numbers are for display only.
 * (P3-04 removed the tier pricing and the client-side schedule maths.)
 */

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

// Helper to serialize Decimal fields to numbers to prevent RSC boundary serialization errors
export const serializeLoan = (loan: any) => {
  if (!loan) return null
  return {
    ...loan,
    requestedAmount: Number(loan.requestedAmount),
    approvedAmount: num(loan.approvedAmount),
    interestRate: Number(loan.interestRate),
    monthlyInterestRatePercent: num(loan.monthlyInterestRatePercent),
    latePenaltyDailyPercent: num(loan.latePenaltyDailyPercent),
    penaltyCapValue: num(loan.penaltyCapValue),
    applicationFee: Number(loan.applicationFee),
    outstandingBalance: Number(loan.outstandingBalance),
    totalRepaid: Number(loan.totalRepaid),
    defaultPenalty: Number(loan.defaultPenalty),
  }
}

export const serializeTransaction = (tx: any) => {
  if (!tx) return null
  return {
    ...tx,
    amount: Number(tx.amount),
  }
}

type DecimalLike = { toString(): string } | number | string

export const serializeInstalment = (inst: {
  id: string
  instalmentNumber: number
  dueDate: Date
  status: string
  principalDue: DecimalLike
  interestDue: DecimalLike
  principalPaid: DecimalLike
  interestPaid: DecimalLike
  penaltyAssessed: DecimalLike
  penaltyPaid: DecimalLike
  penaltyWaived: DecimalLike
}) => ({
  id: inst.id,
  instalmentNumber: inst.instalmentNumber,
  dueDate: inst.dueDate,
  status: inst.status,
  principalDue: Number(inst.principalDue),
  interestDue: Number(inst.interestDue),
  principalPaid: Number(inst.principalPaid),
  interestPaid: Number(inst.interestPaid),
  penaltyAssessed: Number(inst.penaltyAssessed),
  penaltyPaid: Number(inst.penaltyPaid),
  penaltyWaived: Number(inst.penaltyWaived),
})

export type SerializedLoanQuote = ReturnType<typeof serializeLoanQuote>

export const serializeLoanQuote = (q: LoanQuote) => ({
  principal: q.principal.toNumber(),
  termMonths: q.termMonths,
  monthlyInterestRatePercent: q.monthlyInterestRatePercent.toNumber(),
  monthlyInterest: q.monthlyInterest.toNumber(),
  totalInterest: q.totalInterest.toNumber(),
  totalScheduledRepayment: q.totalScheduledRepayment.toNumber(),
  monthlyInstalment: q.monthlyInstalment.toNumber(),
  finalInstalment: q.finalInstalment.toNumber(),
  applicationFee: q.applicationFee.toNumber(),
  totalCostIncludingFee: q.totalCostIncludingFee.toNumber(),
  latePenaltyDailyPercent: q.latePenaltyDailyPercent.toNumber(),
  dailyPenaltyPerOverdueInstalment: q.dailyPenaltyPerOverdueInstalment.toNumber(),
  penaltyCapType: q.penaltyCapType as string,
  penaltyCapValue: q.penaltyCapValue.toNumber(),
  penaltyCapAmount: q.penaltyCapAmount.toNumber(),
  graceDays: q.graceDays,
})

export const serializeSettlementQuote = (q: SettlementQuote) => ({
  remainingPrincipal: q.remainingPrincipal.toNumber(),
  remainingInterest: q.remainingInterest.toNumber(),
  unpaidPenalties: q.unpaidPenalties.toNumber(),
  total: q.total.toNumber(),
})

export type SerializedSettlementQuote = ReturnType<typeof serializeSettlementQuote>
