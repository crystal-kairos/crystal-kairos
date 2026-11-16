'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ExternalLink, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ReceiptDropzone } from '@/components/ui/ReceiptDropzone'
import { SavingsDetailsClient } from '@/components/savings/SavingsDetailsClient'
import { SavingsStatusBadge } from '@/components/savings/SavingsStatusBadge'
import {
  approveSavingsWithdrawalAction,
  confirmSavingsSubmissionAction,
  confirmSavingsWithdrawalPayoutAction,
  rejectSavingsSubmissionAction,
  rejectSavingsWithdrawalAction,
} from '@/models/admin/savingsActions'
import { uploadReceiptAction } from '@/models/eajo/actions'
import type { SavingsPlanDetails } from '@/models/savings/query'

const naira = (v: number) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 2 }).format(v)

type Submission = SavingsPlanDetails['submissions'][number]

/**
 * Staff view of a savings plan: the member's read-only view plus receipt review
 * (value date drives start/maturity/lateness) and the withdrawal payout steps.
 */
export const AdminSavingsDetailsClient = ({ savingsPlan: plan }: { savingsPlan: SavingsPlanDetails }) => {
  const inReview = plan.submissions.filter((s) => s.status === 'SUBMITTED')
  return (
    <div className='flex flex-col gap-6'>
      <div className='max-w-5xl mx-auto w-full flex flex-col gap-4'>
        <p className='text-sm text-muted-foreground'>
          Member: <span className='font-semibold text-primary'>{plan.memberName}</span>
        </p>
        <section className='flex flex-col gap-3'>
          <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>Receipts awaiting review</h3>
          {inReview.length === 0 ? (
            <p className='text-xs text-muted-foreground border border-dashed border-outline-variant/30 rounded-md p-4 text-center'>
              Nothing to review.
            </p>
          ) : (
            inReview.map((s) => <ReviewCard key={s.id} submission={s} plan={plan} />)
          )}
        </section>
        {plan.withdrawal && plan.status === 'WITHDRAWAL_PENDING' ? <WithdrawalPanel plan={plan} /> : null}
      </div>
      <SavingsDetailsClient
        userId={plan.userId}
        savingsPlan={plan}
        canAct={false}
        backHref='/admin/savings'
        backLabel='Back to Savings Management'
      />
    </div>
  )
}

function ReviewCard({ submission: s, plan }: { submission: Submission; plan: SavingsPlanDetails }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [amount, setAmount] = useState(String(s.claimedAmount))
  const [valueDate, setValueDate] = useState(s.paidOn)
  const [reason, setReason] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const dateChanged = valueDate !== s.paidOn

  const confirm = () =>
    startTransition(async () => {
      const res = await confirmSavingsSubmissionAction({
        submissionId: s.id,
        confirmedAmount: amount,
        valueDate,
        valueDateChangeReason: dateChanged ? reason : undefined,
      })
      if (res.success) {
        toast.success('Receipt confirmed')
        router.refresh()
      } else toast.error(res.error ?? 'Could not confirm')
    })

  const reject = () =>
    startTransition(async () => {
      const res = await rejectSavingsSubmissionAction(s.id, rejectReason)
      if (res.success) {
        toast.success('Receipt rejected')
        router.refresh()
      } else toast.error(res.error ?? 'Could not reject')
    })

  const periodNumbers = plan.periods.filter((p) => s.periodIds.includes(p.id)).map((p) => p.periodNumber)

  return (
    <div className='bg-surface-container rounded-md p-4 flex flex-col gap-3 text-sm'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <span>
          <strong>{s.submissionNumber}</strong> · claims {naira(s.claimedAmount)} paid on {s.paidOn}
          {s.bankReference ? ` · ref ${s.bankReference}` : ''}
          {periodNumbers.length ? ` · periods ${periodNumbers.join(', ')}` : ''}
          {s.purpose === 'SAVINGS_FIRST_DEPOSIT' ? ' · first deposit (sets the start date)' : ''}
        </span>
        {s.receiptFileId ? (
          <a href={`/api/files/${s.receiptFileId}`} target='_blank' rel='noreferrer' className='text-xs underline flex items-center gap-1'>
            View receipt <ExternalLink className='w-3 h-3' />
          </a>
        ) : null}
      </div>
      <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
        <div className='flex flex-col gap-1'>
          <Label htmlFor={`amt-${s.id}`} className='text-xs'>Amount received (₦)</Label>
          <Input id={`amt-${s.id}`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode='decimal' />
        </div>
        <div className='flex flex-col gap-1'>
          <Label htmlFor={`vd-${s.id}`} className='text-xs'>Value date (money reached our account)</Label>
          <Input id={`vd-${s.id}`} type='date' value={valueDate} max={plan.today} onChange={(e) => setValueDate(e.target.value)} />
        </div>
      </div>
      {dateChanged ? (
        <div className='flex flex-col gap-1'>
          <Label htmlFor={`vr-${s.id}`} className='text-xs'>Reason for changing the value date</Label>
          <Input id={`vr-${s.id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      ) : null}
      <div className='flex flex-col sm:flex-row gap-2 sm:items-end'>
        <Button onClick={confirm} disabled={isPending || (dateChanged && reason.trim().length < 3)} className='h-9'>
          {isPending ? <Loader2 className='w-4 h-4 animate-spin' /> : null} Confirm
        </Button>
        <div className='flex-1 flex flex-col gap-1'>
          <Label htmlFor={`rr-${s.id}`} className='text-xs'>Rejection reason</Label>
          <Textarea id={`rr-${s.id}`} rows={1} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
        </div>
        <Button variant='outline' onClick={reject} disabled={isPending || rejectReason.trim().length < 3} className='h-9'>
          Reject
        </Button>
      </div>
    </div>
  )
}

function WithdrawalPanel({ plan }: { plan: SavingsPlanDetails }) {
  const router = useRouter()
  const w = plan.withdrawal!
  const [isPending, startTransition] = useTransition()
  const [valueDate, setValueDate] = useState(plan.today)
  const [bankReference, setBankReference] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const run = (fn: () => Promise<{ success: boolean; error?: string }>, ok: string) =>
    startTransition(async () => {
      const res = await fn()
      if (res.success) {
        toast.success(ok)
        router.refresh()
      } else toast.error(res.error ?? 'Action failed')
    })

  const pay = () =>
    run(async () => {
      if (!file) return { success: false, error: 'Upload the transfer evidence.' }
      const fd = new FormData()
      fd.append('file', file)
      const up = await uploadReceiptAction(fd)
      if (!up.success || !up.url) return { success: false, error: up.error ?? 'Upload failed' }
      return confirmSavingsWithdrawalPayoutAction({ savingsId: plan.id, valueDate, bankReference, evidenceUrl: up.url })
    }, 'Payout confirmed')

  return (
    <section className='bg-surface-container rounded-md p-4 flex flex-col gap-3 text-sm'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h3 className='font-bold text-primary'>
          {w.kind === 'EARLY' ? 'Early' : 'Maturity'} withdrawal {w.disbursementNumber} · {naira(w.amount)}
        </h3>
        <SavingsStatusBadge kind='payout' status={w.status} />
      </div>
      <p className='text-xs text-muted-foreground'>
        Pay to {w.bankName} {w.accountNumberMasked} (the member&apos;s current primary account is used at payout).
        {w.kind === 'EARLY' ? ' Accrued interest is reversed when the payout is confirmed.' : ''}
      </p>
      {w.status === 'REQUESTED' ? (
        <Button className='w-fit h-9' disabled={isPending} onClick={() => run(() => approveSavingsWithdrawalAction(plan.id), 'Withdrawal approved')}>
          Approve withdrawal
        </Button>
      ) : null}
      {w.status === 'APPROVED' ? (
        <div className='flex flex-col gap-3'>
          <p className='text-xs text-muted-foreground'>
            A different staff member from the approver confirms the payment when two eligible staff exist.
          </p>
          <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
            <div className='flex flex-col gap-1'>
              <Label htmlFor='po-date' className='text-xs'>Payment date</Label>
              <Input id='po-date' type='date' max={plan.today} value={valueDate} onChange={(e) => setValueDate(e.target.value)} />
            </div>
            <div className='flex flex-col gap-1'>
              <Label htmlFor='po-ref' className='text-xs'>Bank transfer reference</Label>
              <Input id='po-ref' value={bankReference} onChange={(e) => setBankReference(e.target.value)} />
            </div>
          </div>
          <ReceiptDropzone onFileSelected={setFile} value={file} maxSizeMb={5} />
          <Button className='w-fit h-9' disabled={isPending || !file || bankReference.trim().length < 3} onClick={pay}>
            {isPending ? <Loader2 className='w-4 h-4 animate-spin' /> : null} Confirm payout
          </Button>
        </div>
      ) : null}
      <div className='flex flex-col sm:flex-row gap-2 sm:items-end'>
        <div className='flex-1 flex flex-col gap-1'>
          <Label htmlFor='wr-reason' className='text-xs'>Reason to reject or cancel</Label>
          <Input id='wr-reason' value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
        </div>
        <Button
          variant='outline'
          className='h-9'
          disabled={isPending || rejectReason.trim().length < 3}
          onClick={() => run(() => rejectSavingsWithdrawalAction(plan.id, rejectReason), 'Withdrawal rejected')}
        >
          Reject withdrawal
        </Button>
      </div>
    </section>
  )
}

export default AdminSavingsDetailsClient
