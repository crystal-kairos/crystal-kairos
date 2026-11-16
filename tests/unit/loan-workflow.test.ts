import { describe, expect, it } from 'vitest'
import { LoanStatus, PaymentPeriodStatus, PenaltyCapType } from '@/generated/prisma/enums'
import {
  computeSettlementQuote,
  deriveInstalmentStatus,
  deriveLoanStatus,
  describeLoanTerms,
  evaluateApprovalTerms,
  firstPenaltyDate,
  maxNewLoanPrincipal,
  principalOutstanding,
  quoteLoan,
} from '@/lib/domain/loan-workflow'
import { generateLoanSchedule } from '@/lib/domain/loan-schedule'
import { calculateDailyPenaltyAccrual } from '@/lib/domain/penalty-calculation'
import { formatDateOnly } from '@/lib/domain/dates'

// Appendix C1: ₦300,000, 6 months, 5% per month, disbursed 10 Jan 2027
const C1 = {
  principal: 300000,
  termMonths: 6,
  monthlyInterestRatePercent: 5,
  latePenaltyDailyPercent: 0.5,
  penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
  penaltyCapValue: 10,
}

function c1Instalments(paid: number[] = []) {
  return generateLoanSchedule({ ...C1, anchorDate: '2027-01-10' }).instalments.map((i, idx) => {
    const full = paid.includes(idx + 1)
    return {
      id: `i${i.instalmentNumber}`,
      instalmentNumber: i.instalmentNumber,
      dueDate: i.dueDate,
      principalDue: i.principalDue,
      interestDue: i.interestDue,
      principalPaid: full ? i.principalDue : 0,
      interestPaid: full ? i.interestDue : 0,
      penaltyAssessed: 0,
      penaltyPaid: 0,
      penaltyWaived: 0,
    }
  })
}

describe('P3-04 loan pricing and total-cost disclosure (§2.9, Appendix C1)', () => {
  it('prices the C1 loan: interest 15,000/month, instalment 65,000, total 390,000', () => {
    const q = quoteLoan({ ...C1, applicationFee: 0 })
    expect(q.monthlyInterest.toNumber()).toBe(15000)
    expect(q.totalInterest.toNumber()).toBe(90000)
    expect(q.monthlyInstalment.toNumber()).toBe(65000)
    expect(q.finalInstalment.toNumber()).toBe(65000)
    expect(q.totalScheduledRepayment.toNumber()).toBe(390000)
    expect(q.dailyPenaltyPerOverdueInstalment.toNumber()).toBe(1500)
    expect(q.penaltyCapAmount.toNumber()).toBe(30000)
    expect(q.graceDays).toBe(7)
  })

  it('puts the rounding remainder on the last instalment and includes the fee in the total cost', () => {
    const q = quoteLoan({ ...C1, principal: 100000, termMonths: 3, applicationFee: 2000 })
    expect(q.monthlyInstalment.toNumber()).toBe(33333.33 + 5000)
    expect(q.finalInstalment.toNumber()).toBe(33333.34 + 5000)
    expect(q.totalScheduledRepayment.toNumber()).toBe(115000)
    expect(q.totalCostIncludingFee.toNumber()).toBe(117000)
    expect(describeLoanTerms(q)).toContain('total repayable N115000.00')
  })

  it('anchors due dates on the disbursement value date with month-end clamping', () => {
    const s = generateLoanSchedule({ ...C1, anchorDate: '2027-01-31' })
    expect(s.instalments.map((i) => formatDateOnly(i.dueDate))).toEqual([
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
      '2027-05-31',
      '2027-06-30',
      '2027-07-31',
    ])
  })
})

describe('P3-04 early settlement quote (§2.11, A-23, D-11)', () => {
  it('equals the remaining scheduled repayment with no rebate', () => {
    expect(computeSettlementQuote(c1Instalments()).total.toNumber()).toBe(390000)
    const q = computeSettlementQuote(c1Instalments([1, 2]))
    expect(q.remainingPrincipal.toNumber()).toBe(200000)
    expect(q.remainingInterest.toNumber()).toBe(60000)
    expect(q.total.toNumber()).toBe(260000)
  })

  it('adds unpaid assessed penalties net of waivers', () => {
    const insts = c1Instalments([2, 3, 4, 5, 6])
    insts[0].penaltyAssessed = 3000
    insts[0].penaltyWaived = 1000
    const q = computeSettlementQuote(insts)
    expect(q.unpaidPenalties.toNumber()).toBe(2000)
    expect(q.total.toNumber()).toBe(65000 + 2000)
  })
})

describe('P3-04 approval rules (D-07, D-10)', () => {
  const base = {
    requestedAmount: 200000,
    consentedAmount: 200000,
    approvedAmount: 200000,
    requestedTermMonths: 6,
    approvedTermMonths: 6,
  }

  it('unchanged terms need no re-consent', () => {
    expect(evaluateApprovalTerms(base)).toEqual({ ok: true, termsChanged: false })
  })

  it('a lower amount or a different term needs re-consent', () => {
    expect(evaluateApprovalTerms({ ...base, approvedAmount: 150000 })).toEqual({ ok: true, termsChanged: true })
    expect(evaluateApprovalTerms({ ...base, approvedTermMonths: 3 })).toEqual({ ok: true, termsChanged: true })
  })

  it('never exceeds the requested or the consented amount', () => {
    expect(evaluateApprovalTerms({ ...base, approvedAmount: 200000.01 }).ok).toBe(false)
    expect(evaluateApprovalTerms({ ...base, consentedAmount: 180000 }).ok).toBe(false)
    expect(evaluateApprovalTerms({ ...base, approvedAmount: 0 }).ok).toBe(false)
    expect(evaluateApprovalTerms({ ...base, approvedTermMonths: 13 }).ok).toBe(false)
  })
})

describe('P3-04 capacity ceiling (§2.1, Appendix C3)', () => {
  it('borrower ₦100k savings + guarantor ₦80k → ₦280k maximum', () => {
    expect(
      maxNewLoanPrincipal({
        standaloneLimit: 200000,
        existingExposure: 0,
        existingOwnLoanSupport: 0,
        guarantorFreeCapacity: 80000,
      }).toNumber(),
    ).toBe(280000)
  })

  it('after a ₦250k loan (₦50k reserved) only ₦30k more is possible, so ₦40k is refused', () => {
    const max = maxNewLoanPrincipal({
      standaloneLimit: 200000,
      existingExposure: 250000,
      existingOwnLoanSupport: 50000,
      guarantorFreeCapacity: 30000,
    })
    expect(max.toNumber()).toBe(30000)
    expect(max.lt(40000)).toBe(true)
  })

  it('exposure is principal only: interest and penalties paid do not change it', () => {
    const insts = c1Instalments([1])
    expect(principalOutstanding(300000, insts).toNumber()).toBe(250000)
    insts[1].interestPaid = 15000
    insts[1].penaltyPaid = 3000
    expect(principalOutstanding(300000, insts).toNumber()).toBe(250000)
  })
})

describe('P3-04 derived statuses (§2.10, §4.1)', () => {
  const due = '2027-02-10'

  it('loan becomes OVERDUE on day +8, not during grace', () => {
    expect(formatDateOnly(firstPenaltyDate(due))).toBe('2027-02-18')
    const insts = c1Instalments()
    expect(deriveLoanStatus({ currentStatus: LoanStatus.ACTIVE, instalments: insts, today: '2027-02-17' })).toBe(
      LoanStatus.ACTIVE,
    )
    expect(deriveLoanStatus({ currentStatus: LoanStatus.ACTIVE, instalments: insts, today: '2027-02-18' })).toBe(
      LoanStatus.OVERDUE,
    )
  })

  it('a receipt under review shields the instalment', () => {
    const insts = c1Instalments()
    expect(
      deriveLoanStatus({
        currentStatus: LoanStatus.ACTIVE,
        instalments: insts,
        today: '2027-02-20',
        shieldedInstalments: new Set(['i1']),
      }),
    ).toBe(LoanStatus.ACTIVE)
    expect(deriveInstalmentStatus(insts[0], { today: '2027-02-20', inReview: true })).toBe(
      PaymentPeriodStatus.IN_REVIEW,
    )
  })

  it('brought current → ACTIVE; everything settled → COMPLETED', () => {
    expect(
      deriveLoanStatus({ currentStatus: LoanStatus.OVERDUE, instalments: c1Instalments([1]), today: '2027-02-20' }),
    ).toBe(LoanStatus.ACTIVE)
    expect(
      deriveLoanStatus({
        currentStatus: LoanStatus.OVERDUE,
        instalments: c1Instalments([1, 2, 3, 4, 5, 6]),
        today: '2027-02-20',
      }),
    ).toBe(LoanStatus.COMPLETED)
  })

  it('an assessed but unpaid penalty keeps the loan open', () => {
    const insts = c1Instalments([1, 2, 3, 4, 5, 6])
    insts[0].penaltyAssessed = 1500
    expect(
      deriveLoanStatus({ currentStatus: LoanStatus.ACTIVE, instalments: insts, today: '2027-08-01' }),
    ).toBe(LoanStatus.OVERDUE)
    insts[0].penaltyWaived = 1500
    expect(
      deriveLoanStatus({ currentStatus: LoanStatus.ACTIVE, instalments: insts, today: '2027-08-01' }),
    ).toBe(LoanStatus.COMPLETED)
  })

  it('instalment statuses: pending, part paid, overdue, paid', () => {
    const [i1] = c1Instalments()
    expect(deriveInstalmentStatus(i1, { today: '2027-02-01', inReview: false })).toBe(PaymentPeriodStatus.PENDING)
    expect(deriveInstalmentStatus({ ...i1, interestPaid: 15000 }, { today: '2027-02-01', inReview: false })).toBe(
      PaymentPeriodStatus.ONGOING,
    )
    expect(deriveInstalmentStatus(i1, { today: '2027-02-11', inReview: false })).toBe(PaymentPeriodStatus.OVERDUE)
    expect(
      deriveInstalmentStatus({ ...i1, principalPaid: 50000, interestPaid: 15000 }, { today: '2027-02-11', inReview: false }),
    ).toBe(PaymentPeriodStatus.COMPLETED)
  })
})

describe('P3-04 penalties stop at the admin-set cap with the loan snapshot (§2.2, Appendix C2)', () => {
  function accrueDays(capType: PenaltyCapType, capValue: number, days: number) {
    const q = quoteLoan({ ...C1, penaltyCapType: capType, penaltyCapValue: capValue })
    let net = 0
    const amounts: number[] = []
    for (let d = 0; d < days; d++) {
      const r = calculateDailyPenaltyAccrual({
        base: q.principal,
        latePenaltyDailyPercent: q.latePenaltyDailyPercent,
        penaltyCapType: q.penaltyCapType,
        penaltyCapValue: q.penaltyCapValue,
        penaltiesAssessedNet: net,
      })
      amounts.push(r.accrualAmount.toNumber())
      net += r.accrualAmount.toNumber()
    }
    return { amounts, net }
  }

  it('PERCENT_OF_PRINCIPAL 10% → ₦30,000 after 20 days, then nothing', () => {
    const { amounts, net } = accrueDays(PenaltyCapType.PERCENT_OF_PRINCIPAL, 10, 25)
    expect(net).toBe(30000)
    expect(amounts.slice(0, 20).every((a) => a === 1500)).toBe(true)
    expect(amounts.slice(20).every((a) => a === 0)).toBe(true)
  })

  it('FIXED_AMOUNT ₦20,000 → 13 × 1,500, then 500 on day 14, then nothing', () => {
    const { amounts, net } = accrueDays(PenaltyCapType.FIXED_AMOUNT, 20000, 16)
    expect(amounts.slice(0, 13).reduce((a, b) => a + b, 0)).toBe(19500)
    expect(amounts[13]).toBe(500)
    expect(amounts[14]).toBe(0)
    expect(net).toBe(20000)
  })
})
