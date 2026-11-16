'use client'

import React, { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Landmark,
  Loader2,
  Upload,
} from 'lucide-react'
import { Card } from '../ui/card'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { ReceiptDropzone } from '../ui/ReceiptDropzone'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { SavingsStatusBadge } from './SavingsStatusBadge'
import {
  cancelSavingsWithdrawalAction,
  requestSavingsWithdrawalAction,
  submitSavingsDepositAction,
} from '@/models/savings/actions'
import { uploadReceiptAction } from '@/models/eajo/actions'
import type { SavingsPlanDetails } from '@/models/savings/query'

const naira = (v: number) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 2 }).format(v)

const fmtDate = (iso: string | null) =>
  iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

interface Props {
  userId: string
  savingsPlan: SavingsPlanDetails
  /** True when a member views their own plan (staff see a read-only view). */
  canAct: boolean
  backHref?: string
  backLabel?: string
}

export const SavingsDetailsClient = ({ userId, savingsPlan: plan, canAct, backHref, backLabel }: Props) => {
  const router = useRouter()
  const [depositOpen, setDepositOpen] = useState(false)
  const [resubmissionOfId, setResubmissionOfId] = useState<string | undefined>()
  const [withdrawOpen, setWithdrawOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [actionError, setActionError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const openPeriods = plan.periods.filter((p) => p.outstanding > 0)
  const isEarly = plan.maturityDate ? plan.today < plan.maturityDate : true
  const canDeposit =
    canAct &&
    (plan.status === 'PENDING' || plan.status === 'ACTIVE') &&
    !(plan.status === 'PENDING' && plan.submissions.some((s) => s.status === 'SUBMITTED')) &&
    !(plan.savingsType === 'FIXED' && plan.status === 'ACTIVE' && plan.targetAmount !== null && plan.currentBalance >= plan.targetAmount) &&
    !(plan.savingsType === 'REGULAR' && plan.status === 'ACTIVE' && openPeriods.length === 0)
  const canWithdraw = canAct && (plan.status === 'ACTIVE' || plan.status === 'MATURED') && plan.currentBalance > 0

  const openDeposit = (resubmitId?: string) => {
    setResubmissionOfId(resubmitId)
    setDepositOpen(true)
  }

  const copyReference = async () => {
    if (!plan.paymentReference) return
    try {
      await navigator.clipboard.writeText(plan.paymentReference)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be blocked; the reference stays visible.
    }
  }

  const requestWithdrawal = () => {
    setActionError(null)
    startTransition(async () => {
      const res = await requestSavingsWithdrawalAction(userId, plan.id)
      if (res.success) {
        setWithdrawOpen(false)
        router.refresh()
      } else {
        setActionError(res.error ?? 'Could not request the withdrawal.')
      }
    })
  }

  const cancelWithdrawal = () => {
    setActionError(null)
    startTransition(async () => {
      const res = await cancelSavingsWithdrawalAction(userId, plan.id)
      if (res.success) router.refresh()
      else setActionError(res.error ?? 'Could not cancel the withdrawal.')
    })
  }

  return (
    <div className='flex flex-col gap-6 w-full max-w-5xl mx-auto py-6 px-4 md:px-0'>
      <Link
        href={backHref ?? `/dashboard/${userId}/savings`}
        className='flex items-center gap-1.5 text-muted-foreground hover:text-primary text-xs font-semibold w-fit'
      >
        <ArrowLeft className='w-4 h-4' /> {backLabel ?? 'Back to Savings Hub'}
      </Link>

      <header className='flex flex-col md:flex-row md:items-start justify-between gap-4'>
        <div>
          <h2 className='text-2xl font-bold text-primary flex items-center gap-2 flex-wrap'>
            {plan.title}
            {plan.badge ? (
              <span className='px-2 py-0.5 rounded-full bg-light-blue text-primary text-[9px] font-bold uppercase tracking-wider'>
                {plan.badge}
              </span>
            ) : null}
          </h2>
          <p className='text-sm text-muted-foreground mt-1'>
            {plan.ratePercentSnapshot}% simple interest for {plan.durationMonths} month
            {plan.durationMonths === 1 ? '' : 's'} ·{' '}
            <span className='capitalize'>{plan.savingsType.toLowerCase()}</span>
            {plan.savingsType === 'REGULAR' ? ` · ${plan.frequency.toLowerCase()}` : ''}
            {plan.targetAmount ? ` · ${plan.savingsType === 'REGULAR' ? 'per period' : 'target'} ${naira(plan.targetAmount)}` : ''}
          </p>
        </div>
        <div className='flex items-center gap-2 flex-wrap'>
          <SavingsStatusBadge kind='plan' status={plan.status} />
          {canDeposit ? (
            <Button onClick={() => openDeposit()} className='h-9'>
              <Upload className='w-4 h-4' />
              {plan.status === 'PENDING' ? 'Upload first deposit' : 'Upload deposit receipt'}
            </Button>
          ) : null}
          {canWithdraw ? (
            <Button variant='outline' onClick={() => setWithdrawOpen(true)} className='h-9'>
              Withdraw
            </Button>
          ) : null}
        </div>
      </header>

      {actionError ? (
        <div role='alert' className='flex items-start gap-2 text-xs text-error'>
          <AlertCircle className='w-4 h-4 shrink-0 mt-0.5' />
          {actionError}
        </div>
      ) : null}

      {plan.status === 'PENDING' ? (
        <div className='bg-warning-container/20 rounded-md p-4 text-sm'>
          {plan.submissions.some((s) => s.status === 'SUBMITTED') ? (
            <p>Your first deposit is being reviewed. The plan starts on the date the money reached our account.</p>
          ) : (
            <p>
              Make your first deposit and upload the receipt by <strong>{fmtDate(plan.firstDepositDeadline)}</strong>,
              or the plan will be cancelled. The plan starts on the date the money reaches our account.
            </p>
          )}
        </div>
      ) : null}
      {plan.status === 'CANCELLED' ? (
        <div className='bg-surface-container rounded-md p-4 text-sm text-muted-foreground'>
          This plan was cancelled{plan.cancellationReason ? `: ${plan.cancellationReason}` : ''}. You can subscribe again
          from the Savings Hub; a new plan uses the current rate.
        </div>
      ) : null}

      <section className='grid grid-cols-2 lg:grid-cols-4 gap-3'>
        {[
          { label: 'Confirmed principal', value: naira(plan.currentBalance) },
          { label: 'Interest accrued so far', value: naira(plan.accruedInterest) },
          { label: 'Interest at maturity (current deposits)', value: naira(plan.projectedInterest) },
          { label: 'Start → maturity', value: `${fmtDate(plan.startDate)} → ${fmtDate(plan.maturityDate)}` },
        ].map((s) => (
          <Card key={s.label} className='border-0 bg-surface-container rounded-md shadow-none p-4'>
            <span className='text-[10px] uppercase tracking-wider text-muted-foreground font-semibold'>{s.label}</span>
            <span className='block text-base font-bold text-primary mt-1 font-mono'>{s.value}</span>
          </Card>
        ))}
      </section>

      {plan.withdrawal ? (
        <section className='bg-surface-container rounded-md p-4 flex flex-col gap-2 text-sm'>
          <div className='flex items-center justify-between gap-2 flex-wrap'>
            <h3 className='font-bold text-primary'>
              {plan.withdrawal.kind === 'EARLY' ? 'Early withdrawal' : 'Maturity withdrawal'}
            </h3>
            <SavingsStatusBadge kind='payout' status={plan.withdrawal.status} />
          </div>
          <p className='text-muted-foreground'>
            {naira(plan.withdrawal.amount)} (principal {naira(plan.withdrawal.principal)}, interest{' '}
            {naira(plan.withdrawal.interest)}) to {plan.withdrawal.bankName} {plan.withdrawal.accountNumberMasked}.
            {plan.withdrawal.kind === 'EARLY' ? ' Accrued interest is forfeited on early withdrawal.' : ''}
          </p>
          {canAct && plan.status === 'WITHDRAWAL_PENDING' && plan.withdrawal.status === 'REQUESTED' ? (
            <Button variant='outline' className='w-fit h-8' disabled={isPending} onClick={cancelWithdrawal}>
              {isPending ? <Loader2 className='w-4 h-4 animate-spin' /> : null}
              Cancel withdrawal request
            </Button>
          ) : null}
        </section>
      ) : null}

      {(plan.status === 'PENDING' || plan.status === 'ACTIVE') && plan.receivingAccount ? (
        <section className='bg-surface-container-lowest border border-outline-variant/20 rounded-md p-4 flex flex-col gap-2 text-sm'>
          <h3 className='font-bold text-primary flex items-center gap-2'>
            <Landmark className='w-4 h-4' /> How to pay
          </h3>
          <p className='text-muted-foreground'>
            Transfer to <strong>{plan.receivingAccount.bankName}</strong>, account{' '}
            <strong className='font-mono'>{plan.receivingAccount.accountNumber}</strong> ({plan.receivingAccount.accountName}).
          </p>
          {plan.paymentReference ? (
            <p className='flex items-center gap-2 flex-wrap'>
              <span className='text-muted-foreground'>Use this narration:</span>
              <code className='font-mono font-bold bg-surface-container px-2 py-0.5 rounded-sm'>{plan.paymentReference}</code>
              <Button variant='ghost' size='sm' className='h-7' onClick={copyReference} aria-label='Copy narration'>
                {copied ? <CheckCircle2 className='w-4 h-4' /> : <Copy className='w-4 h-4' />}
              </Button>
            </p>
          ) : null}
        </section>
      ) : null}

      {plan.savingsType === 'REGULAR' && plan.periods.length > 0 ? (
        <section className='flex flex-col gap-2'>
          <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>Schedule</h3>
          <div className='overflow-x-auto rounded-md border border-outline-variant/20'>
            <table className='w-full text-xs'>
              <thead className='bg-surface-container text-muted-foreground'>
                <tr>
                  <th className='text-left p-2'>#</th>
                  <th className='text-left p-2'>Due</th>
                  <th className='text-right p-2'>Amount</th>
                  <th className='text-right p-2'>Paid</th>
                  <th className='text-right p-2'>Still owed</th>
                  <th className='text-left p-2'>Status</th>
                  <th className='p-2' />
                </tr>
              </thead>
              <tbody>
                {plan.periods.map((p) => (
                  <tr key={p.id} className='border-t border-outline-variant/10'>
                    <td className='p-2'>{p.periodNumber}</td>
                    <td className='p-2 whitespace-nowrap'>{fmtDate(p.dueDate)}</td>
                    <td className='p-2 text-right font-mono'>{naira(p.amountDue)}</td>
                    <td className='p-2 text-right font-mono'>{naira(p.amountPaid)}</td>
                    <td className='p-2 text-right font-mono'>{p.outstanding > 0 ? naira(p.outstanding) : '—'}</td>
                    <td className='p-2'>
                      <div className='flex flex-col gap-1 items-start'>
                        <SavingsStatusBadge kind='period' status={p.status} />
                        {p.interestForfeited ? (
                          <span className='text-[10px] text-error'>Interest forfeited (paid after the 7-day grace)</span>
                        ) : null}
                      </div>
                    </td>
                    <td className='p-2 text-right'>
                      {canAct && p.status === 'REJECTED' && plan.status === 'ACTIVE' ? (
                        <Button
                          size='sm'
                          variant='outline'
                          className='h-7'
                          onClick={() =>
                            openDeposit(plan.submissions.find((s) => s.status === 'REJECTED' && s.periodIds.includes(p.id))?.id)
                          }
                        >
                          Re-upload
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className='flex flex-col gap-2'>
        <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>Receipts</h3>
        {plan.submissions.length === 0 ? (
          <p className='text-xs text-muted-foreground border border-dashed border-outline-variant/30 rounded-md p-6 text-center'>
            No receipts uploaded yet.
          </p>
        ) : (
          <ul className='flex flex-col gap-2'>
            {plan.submissions.map((s) => (
              <li key={s.id} className='bg-surface-container rounded-md p-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2'>
                <div>
                  <span className='font-semibold text-primary'>{s.submissionNumber}</span> · {naira(s.claimedAmount)} paid on{' '}
                  {fmtDate(s.paidOn)}
                  {s.status === 'CONFIRMED' && s.valueDate ? ` · received ${fmtDate(s.valueDate)}` : ''}
                  {s.status === 'REJECTED' && s.rejectionReason ? (
                    <span className='block text-error mt-1'>Reason: {s.rejectionReason}</span>
                  ) : null}
                </div>
                <div className='flex items-center gap-2'>
                  <SavingsStatusBadge kind='receipt' status={s.status} />
                  {canAct && s.status === 'REJECTED' && canDeposit && s.periodIds.length === 0 ? (
                    <Button size='sm' variant='outline' className='h-7' onClick={() => openDeposit(s.id)}>
                      Re-upload
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {plan.lots.length > 0 ? (
        <section className='flex flex-col gap-2'>
          <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>Confirmed deposits</h3>
          <ul className='flex flex-col gap-1 text-xs'>
            {plan.lots.map((l) => (
              <li key={l.id} className='flex justify-between gap-2 border-b border-outline-variant/10 py-1.5'>
                <span>
                  {fmtDate(l.valueDate)} · {naira(l.principal)}
                </span>
                <span className={l.interestBearing ? 'text-success-green' : 'text-muted-foreground'}>
                  {l.voided
                    ? 'Reversed'
                    : l.interestBearing
                      ? `Earning interest · accrued ${naira(l.accrued)}`
                      : l.forfeitReason === 'EARLY_WITHDRAWAL'
                        ? 'Interest forfeited (early withdrawal)'
                        : 'No interest (late period)'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canAct ? (
        <DepositDialog
          open={depositOpen}
          onOpenChange={setDepositOpen}
          userId={userId}
          plan={plan}
          resubmissionOfId={resubmissionOfId}
        />
      ) : null}

      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent className='max-w-md bg-surface rounded-md p-6 border-0 shadow-lg'>
          <DialogHeader>
            <DialogTitle className='text-primary font-bold text-base flex items-center gap-2'>
              <AlertTriangle className='w-5 h-5' /> Withdraw this plan?
            </DialogTitle>
            <DialogDescription className='text-sm text-muted-foreground'>
              {isEarly
                ? `This plan matures on ${fmtDate(plan.maturityDate)}. Withdrawing now returns your principal of ${naira(plan.currentBalance)} and forfeits all interest (${naira(plan.accruedInterest)} accrued so far).`
                : `Your plan has matured. You will receive your principal of ${naira(plan.currentBalance)} plus the interest earned.`}{' '}
              The money is frozen until staff confirm the payment to your primary bank account. Withdrawal is not possible
              while you have a loan or while your savings secure someone else&apos;s guarantee.
            </DialogDescription>
          </DialogHeader>
          {actionError ? <p className='text-xs text-error'>{actionError}</p> : null}
          <div className='flex justify-end gap-2 mt-4'>
            <Button variant='outline' onClick={() => setWithdrawOpen(false)} disabled={isPending}>
              Keep saving
            </Button>
            <Button onClick={requestWithdrawal} disabled={isPending}>
              {isPending ? <Loader2 className='w-4 h-4 animate-spin' /> : null}
              {isEarly ? 'Withdraw early' : 'Request payout'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function DepositDialog({
  open,
  onOpenChange,
  userId,
  plan,
  resubmissionOfId,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  userId: string
  plan: SavingsPlanDetails
  resubmissionOfId?: string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const openPeriods = useMemo(() => plan.periods.filter((p) => p.outstanding > 0), [plan.periods])
  const isRegularActive = plan.savingsType === 'REGULAR' && plan.status === 'ACTIVE'
  const [selected, setSelected] = useState<string[]>(openPeriods[0] ? [openPeriods[0].id] : [])
  const suggested = isRegularActive
    ? openPeriods.filter((p) => selected.includes(p.id)).reduce((s, p) => s + p.outstanding, 0)
    : plan.status === 'PENDING' && plan.targetAmount
      ? plan.targetAmount
      : plan.savingsType === 'FIXED' && plan.targetAmount
        ? Math.max(0, plan.targetAmount - plan.currentBalance)
        : 0
  const [amount, setAmount] = useState('')
  const [paidOn, setPaidOn] = useState(plan.today)
  const [bankReference, setBankReference] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!file) {
      setError('Upload your payment receipt.')
      return
    }
    if (isRegularActive && selected.length === 0) {
      setError('Choose at least one period to pay.')
      return
    }
    startTransition(async () => {
      const fd = new FormData()
      fd.append('file', file)
      const up = await uploadReceiptAction(fd)
      if (!up.success || !up.url) {
        setError(up.error ?? 'The receipt could not be uploaded.')
        return
      }
      const res = await submitSavingsDepositAction(userId, {
        savingsId: plan.id,
        amount: amount || String(suggested),
        paidOn,
        periodIds: isRegularActive ? selected : undefined,
        receiptUrl: up.url,
        bankReference: bankReference.trim() || undefined,
        resubmissionOfId,
      })
      if (res.success) {
        setDone(true)
        setFile(null)
        router.refresh()
        setTimeout(() => {
          setDone(false)
          onOpenChange(false)
        }, 1500)
      } else {
        setError(res.error ?? 'The receipt could not be submitted.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-md bg-surface rounded-md p-6 border-0 shadow-lg max-h-[90vh] overflow-y-auto'>
        <DialogHeader>
          <DialogTitle className='text-primary font-bold text-base flex items-center gap-2'>
            <Upload className='w-5 h-5' />
            {plan.status === 'PENDING' ? 'Upload your first deposit' : 'Upload a deposit receipt'}
          </DialogTitle>
          <DialogDescription className='text-xs text-muted-foreground'>
            Staff check the receipt against the bank statement. Nothing is added to your plan until it is confirmed.
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <p className='flex items-center gap-2 text-sm text-success-green py-6'>
            <CheckCircle2 className='w-5 h-5' /> Receipt submitted for review.
          </p>
        ) : (
          <form onSubmit={submit} className='flex flex-col gap-4 mt-2'>
            {isRegularActive ? (
              <fieldset className='flex flex-col gap-1'>
                <legend className='text-xs font-semibold text-muted-foreground mb-1'>Periods this payment covers</legend>
                <div className='max-h-40 overflow-y-auto flex flex-col gap-1'>
                  {openPeriods.map((p) => (
                    <label key={p.id} className='flex items-center gap-2 text-xs'>
                      <input type='checkbox' checked={selected.includes(p.id)} onChange={() => toggle(p.id)} />
                      Period {p.periodNumber} · due {fmtDate(p.dueDate)} · owed {naira(p.outstanding)}
                    </label>
                  ))}
                </div>
                <span className='text-[10px] text-muted-foreground'>
                  Payments go to the oldest selected period first. Anything above what you selected goes to your wallet.
                </span>
              </fieldset>
            ) : null}
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor='dep-amount' className='text-xs font-semibold text-muted-foreground'>
                Amount paid (₦)
              </Label>
              <Input
                id='dep-amount'
                inputMode='decimal'
                value={amount}
                placeholder={suggested > 0 ? String(suggested) : 'e.g. 10000'}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor='dep-date' className='text-xs font-semibold text-muted-foreground'>
                Date you paid
              </Label>
              <Input id='dep-date' type='date' max={plan.today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </div>
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor='dep-ref' className='text-xs font-semibold text-muted-foreground'>
                Bank reference (optional)
              </Label>
              <Input id='dep-ref' value={bankReference} onChange={(e) => setBankReference(e.target.value)} />
            </div>
            <div className='flex flex-col gap-1.5'>
              <Label className='text-xs font-semibold text-muted-foreground'>Receipt (JPG, PNG or PDF, up to 5 MB)</Label>
              <ReceiptDropzone onFileSelected={setFile} value={file} maxSizeMb={5} />
            </div>
            {error ? (
              <p role='alert' className='text-xs text-error flex items-start gap-1.5'>
                <AlertCircle className='w-4 h-4 shrink-0' />
                {error}
              </p>
            ) : null}
            <Button type='submit' disabled={isPending} className='h-10'>
              {isPending ? <Loader2 className='w-4 h-4 animate-spin' /> : null}
              Submit receipt
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default SavingsDetailsClient
