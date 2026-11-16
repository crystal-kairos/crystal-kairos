'use client'

import React, { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { FileText, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { formatCurrency } from '@/lib/formatter'
import {
  decideGuarantorRequestAction,
  withdrawGuarantorConsentAction,
} from '@/models/loans/actions'
import type { getMyLoanGuaranteeRequests } from '@/models/loans/query'

type GuaranteeRow = Awaited<ReturnType<typeof getMyLoanGuaranteeRequests>>['data'][number]

const PRE_DISBURSEMENT = ['PENDING', 'APPROVED', 'AWAITING_RECONSENT', 'ACCEPTED']

const STATE_LABELS: Record<string, string> = {
  PENDING: 'New request',
  AWAITING_RECONSENT: 'New terms — waiting for your decision',
  CONSENTED: 'You accepted',
  DECLINED: 'You declined',
  WITHDRAWN_BEFORE_ACTIVATION: 'You withdrew',
  REPLACED: 'Replaced by another guarantor',
  RELEASED: 'Released',
}

const naira = (n: number) => formatCurrency(n)

function capText(row: GuaranteeRow) {
  const q = row.quote
  if (!q) return ''
  return q.penaltyCapType === 'PERCENT_OF_PRINCIPAL'
    ? `${q.penaltyCapValue}% of the amount borrowed (${naira(q.penaltyCapAmount)})`
    : naira(q.penaltyCapAmount)
}

function Terms({ row }: { row: GuaranteeRow }) {
  const q = row.quote
  if (!q) return null
  return (
    <dl className='grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-xs'>
      <div><dt className='text-muted-foreground'>Amount</dt><dd className='font-semibold'>{naira(q.principal)}</dd></div>
      <div><dt className='text-muted-foreground'>Term</dt><dd className='font-semibold'>{q.termMonths} month{q.termMonths === 1 ? '' : 's'}</dd></div>
      <div><dt className='text-muted-foreground'>Interest</dt><dd className='font-semibold'>{q.monthlyInterestRatePercent}% per month (flat)</dd></div>
      <div><dt className='text-muted-foreground'>Monthly instalment</dt><dd className='font-semibold'>{naira(q.monthlyInstalment)}</dd></div>
      <div><dt className='text-muted-foreground'>Total to repay</dt><dd className='font-semibold'>{naira(q.totalScheduledRepayment)}</dd></div>
      <div><dt className='text-muted-foreground'>Late penalty</dt><dd className='font-semibold'>{q.latePenaltyDailyPercent}% a day after {q.graceDays} days’ grace, capped at {capText(row)}</dd></div>
    </dl>
  )
}

/**
 * Loan guarantee requests for the signed-in member (§2.7): accept or decline a request
 * (or revised terms), and withdraw consent before the loan is paid out.
 */
export const LoanGuaranteesClient = ({
  rows,
  canAct,
  eajoPendingCount,
  eajoHref,
}: {
  rows: GuaranteeRow[]
  canAct: boolean
  eajoPendingCount: number
  eajoHref: string
}) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [agreed, setAgreed] = useState<Record<string, boolean>>({})
  const [reasonFor, setReasonFor] = useState<{ id: string; kind: 'DECLINE' | 'WITHDRAW' } | null>(null)
  const [reason, setReason] = useState('')

  const open = rows.filter((r) => r.state === 'PENDING' || r.state === 'AWAITING_RECONSENT')
  const active = rows.filter((r) => r.state === 'CONSENTED')
  const past = rows.filter((r) => !open.includes(r) && !active.includes(r))

  const run = (fn: () => Promise<{ success: boolean; error?: string }>, done: string) => {
    startTransition(async () => {
      const res = await fn()
      if (res.success) {
        toast.success(done)
        setReasonFor(null)
        setReason('')
        router.refresh()
      } else {
        toast.error(res.error || 'Your decision could not be saved.')
      }
    })
  }

  const accept = (row: GuaranteeRow) =>
    run(() => decideGuarantorRequestAction({ reservationId: row.id, decision: 'ACCEPT' }), 'You are now the guarantor for this loan.')

  const submitReason = (row: GuaranteeRow) => {
    if (!reasonFor) return
    if (reasonFor.kind === 'DECLINE') {
      run(
        () => decideGuarantorRequestAction({ reservationId: row.id, decision: 'DECLINE', reason: reason.trim() || undefined }),
        'You declined this request.',
      )
    } else {
      if (reason.trim().length < 3) {
        toast.error('Please give a short reason.')
        return
      }
      run(() => withdrawGuarantorConsentAction({ reservationId: row.id, reason: reason.trim() }), 'Your consent was withdrawn.')
    }
  }

  // A render function (not a nested component) so the textarea keeps focus while typing.
  const renderReasonBox = (row: GuaranteeRow) =>
    reasonFor?.id === row.id ? (
      <div className='flex flex-col gap-2'>
        <label htmlFor={`reason-${row.id}`} className='text-xs font-semibold'>
          {reasonFor.kind === 'DECLINE' ? 'Reason (optional, shown to the member)' : 'Reason for withdrawing'}
        </label>
        <Textarea id={`reason-${row.id}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className='text-xs' />
        <div className='flex gap-2'>
          <Button size='sm' variant='destructive' disabled={isPending} onClick={() => submitReason(row)}>
            {reasonFor.kind === 'DECLINE' ? 'Decline request' : 'Withdraw consent'}
          </Button>
          <Button size='sm' variant='ghost' disabled={isPending} onClick={() => { setReasonFor(null); setReason('') }}>
            Keep it
          </Button>
        </div>
      </div>
    ) : null

  return (
    <div className='w-[90%] mx-auto py-8 max-w-4xl flex flex-col gap-6'>
      <div className='flex items-center gap-3'>
        <div className='w-12 h-12 rounded-md bg-secondary/10 flex items-center justify-center text-secondary shrink-0'>
          <ShieldCheck className='w-6 h-6' />
        </div>
        <div>
          <h1 className='text-2xl font-bold font-heading tracking-tight'>Guarantees</h1>
          <p className='text-sm text-muted-foreground'>Loans other members asked you to guarantee.</p>
        </div>
      </div>

      {eajoPendingCount > 0 && (
        <p className='text-xs bg-amber-50/60 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg p-3'>
          You also have {eajoPendingCount} e-ajo guarantee request{eajoPendingCount === 1 ? '' : 's'}.{' '}
          <Link href={eajoHref} className='font-semibold underline'>Answer them on your e-ajo page</Link>.
        </p>
      )}

      <section className='flex flex-col gap-3'>
        <h2 className='text-sm font-bold text-primary uppercase tracking-wide'>Waiting for your decision</h2>
        {open.length === 0 && <p className='text-xs text-muted-foreground'>No loan guarantee requests are waiting for you.</p>}
        {open.map((row) => (
          <article key={row.id} className='bg-surface-container border border-amber-300/60 rounded-lg p-5 flex flex-col gap-4'>
            <div className='flex flex-col gap-1'>
              <span className='text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400'>{STATE_LABELS[row.state]}</span>
              <h3 className='font-semibold text-sm'>
                {row.applicantName} asks you to guarantee their loan{row.purpose ? ` for “${row.purpose}”` : ''}.
              </h3>
              {row.isRevisedTerms && (
                <p className='text-xs text-muted-foreground'>The administrator approved different terms from the ones you saw before. Please check them again.</p>
              )}
            </div>
            <Terms row={row} />
            <p className='text-xs text-muted-foreground'>
              {row.guaranteeAmount > 0
                ? `If you accept, ${naira(row.guaranteeAmount)} of your savings is set aside for this loan and cannot be withdrawn until the loan is repaid.`
                : 'This loan needs none of your savings set aside right now, but every loan needs a named guarantor who agrees.'}{' '}
              If the member stops paying, the amount owed can be recovered from their wallet and savings first, and only then from your
              set-aside savings — and only after a final notice and an administrator’s approval.
            </p>
            {canAct && (
              <>
                <label className='flex items-start gap-2 text-xs'>
                  <input
                    type='checkbox'
                    className='mt-0.5'
                    checked={Boolean(agreed[row.id])}
                    onChange={(e) => setAgreed((a) => ({ ...a, [row.id]: e.target.checked }))}
                  />
                  <span>I have read the loan terms and the recovery consequences, and I agree to guarantee this loan.</span>
                </label>
                <div className='flex gap-2 flex-wrap'>
                  <Button size='sm' disabled={isPending || !agreed[row.id]} onClick={() => accept(row)}>Accept</Button>
                  <Button size='sm' variant='outline' disabled={isPending} onClick={() => { setReasonFor({ id: row.id, kind: 'DECLINE' }); setReason('') }}>Decline</Button>
                </div>
                {renderReasonBox(row)}
              </>
            )}
          </article>
        ))}
      </section>

      <section className='flex flex-col gap-3'>
        <h2 className='text-sm font-bold text-primary uppercase tracking-wide'>Loans you guarantee</h2>
        {active.length === 0 && <p className='text-xs text-muted-foreground'>You are not guaranteeing any loans.</p>}
        {active.map((row) => (
          <article key={row.id} className='bg-surface-container rounded-lg p-5 flex flex-col gap-3'>
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <h3 className='font-semibold text-sm'>{row.applicantName}’s loan</h3>
              <span className='text-[11px] font-semibold text-emerald-700 dark:text-emerald-400'>{STATE_LABELS[row.state]}</span>
            </div>
            <Terms row={row} />
            <p className='text-xs text-muted-foreground'>Savings set aside: {naira(row.guaranteeAmount)}</p>
            <div className='flex gap-2 flex-wrap'>
              {row.hasEvidence && (
                <Button asChild size='sm' variant='outline'>
                  <a href={`/api/guarantees/${row.id}/evidence`} target='_blank' rel='noreferrer'>
                    <FileText className='w-3.5 h-3.5 mr-1' /> Consent record (PDF)
                  </a>
                </Button>
              )}
              {canAct && row.loanStatus && PRE_DISBURSEMENT.includes(row.loanStatus) && (
                <Button size='sm' variant='ghost' disabled={isPending} onClick={() => { setReasonFor({ id: row.id, kind: 'WITHDRAW' }); setReason('') }}>
                  Withdraw consent
                </Button>
              )}
            </div>
            {canAct && row.loanStatus && PRE_DISBURSEMENT.includes(row.loanStatus) && (
              <p className='text-[11px] text-muted-foreground'>You can withdraw only until the loan is paid out. Withdrawing stops the loan from going ahead.</p>
            )}
            {renderReasonBox(row)}
          </article>
        ))}
      </section>

      {past.length > 0 && (
        <section className='flex flex-col gap-3'>
          <h2 className='text-sm font-bold text-primary uppercase tracking-wide'>Earlier requests</h2>
          {past.map((row) => (
            <div key={row.id} className='bg-surface-container rounded-lg p-4 flex flex-wrap items-center justify-between gap-2 text-xs'>
              <span>
                {row.applicantName}
                {row.quote ? ` · ${naira(row.quote.principal)} for ${row.quote.termMonths} months` : ''}
                {row.decisionReason ? ` · “${row.decisionReason}”` : ''}
              </span>
              <span className='flex items-center gap-3'>
                <span className='text-muted-foreground'>{STATE_LABELS[row.state] ?? row.state}</span>
                {row.hasEvidence && (
                  <a href={`/api/guarantees/${row.id}/evidence`} target='_blank' rel='noreferrer' className='underline'>PDF</a>
                )}
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
