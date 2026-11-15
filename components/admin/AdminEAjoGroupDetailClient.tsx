'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertCircle, ArrowLeft, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  activateEAjoGroupAction,
  approveEAjoMemberAction,
  approveEAjoPayoutAction,
  cancelEAjoParticipantAction,
  confirmEAjoContributionAction,
  holdEAjoPayoutAction,
  recordEAjoPayoutPaidAction,
  refreshEAjoGroupEligibilityAction,
  rejectEAjoContributionAction,
  rejectEAjoMemberAction,
  releaseEAjoPayoutHoldAction,
} from '@/models/admin/eajoActions'
import { uploadReceiptAction } from '@/models/eajo/actions'
import type { getAdminEAjoGroupDashboard } from '@/models/eajo/query'

type Dashboard = NonNullable<Awaited<ReturnType<typeof getAdminEAjoGroupDashboard>>['data']>
type Participant = Dashboard['participants'][number]

const naira = (v: number) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 2 }).format(v)

const STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-amber-50 text-amber-700 border-amber-200',
  APPROVED: 'bg-blue-50 text-blue-700 border-blue-200',
  ACTIVE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  COMPLETED: 'bg-slate-100 text-slate-600 border-slate-200',
  REJECTED: 'bg-red-50 text-red-700 border-red-200',
  CANCELLED: 'bg-red-50 text-red-600 border-red-200',
  NOT_ELIGIBLE: 'bg-slate-100 text-slate-600 border-slate-200',
  ELIGIBLE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  HELD: 'bg-amber-50 text-amber-700 border-amber-200',
  PAID: 'bg-blue-50 text-blue-700 border-blue-200',
  FAILED: 'bg-red-50 text-red-700 border-red-200',
  CONSENTED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  DECLINED: 'bg-red-50 text-red-700 border-red-200',
  RELEASED: 'bg-slate-100 text-slate-600 border-slate-200',
  WITHDRAWN_BEFORE_ACTIVATION: 'bg-red-50 text-red-700 border-red-200',
}

const label = (s: string) =>
  s === 'NOT_ELIGIBLE'
    ? 'Not eligible'
    : s === 'WITHDRAWN_BEFORE_ACTIVATION'
      ? 'Withdrawn'
      : s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ')

const Pill = ({ status }: { status: string }) => (
  <span
    className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${STATUS_STYLES[status] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}
  >
    {label(status)}
  </span>
)

type DialogKind =
  | { kind: 'reject-app'; participant: Participant }
  | { kind: 'cancel'; participant: Participant }
  | { kind: 'hold'; participant: Participant }
  | { kind: 'paid'; participant: Participant }
  | { kind: 'reject-receipt'; submissionId: string; number: string }
  | { kind: 'confirm-receipt'; submissionId: string; number: string; paidOn: string | null; amount: number }
  | { kind: 'activate' }

export const AdminEAjoGroupDetailClient = ({ data }: { data: Dashboard }) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const [reason, setReason] = useState('')
  const [dateValue, setDateValue] = useState('')
  const [reference, setReference] = useState('')
  const [evidence, setEvidence] = useState<File | null>(null)
  const [cashBalance, setCashBalance] = useState('')

  const { group, participants, funding, pendingContributions, slots } = data
  const can = (p: string) => data.viewerRole === 'OWNER' || (data.permissions as readonly string[]).includes(p)
  const canManage = can('EAJO_MANAGE')
  const canPayouts = can('EAJO_PAYOUTS_MANAGE')
  const canReview = can('EAJO_PAYMENTS_REVIEW')

  const open = (d: DialogKind) => {
    setError(null)
    setReason('')
    setReference('')
    setEvidence(null)
    setDateValue(
      d.kind === 'confirm-receipt' ? (d.paidOn ?? '') : d.kind === 'activate' ? (group.startDate ?? data.today) : data.today,
    )
    setDialog(d)
  }

  const run = (fn: () => Promise<{ success: boolean; error?: string }>, success?: string) => {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.success) {
        setError(res.error ?? 'Something went wrong.')
        return
      }
      setDialog(null)
      if (success) setNotice(success)
      router.refresh()
    })
  }

  const submitDialog = () => {
    if (!dialog) return
    switch (dialog.kind) {
      case 'reject-app':
        return run(() => rejectEAjoMemberAction(dialog.participant.id, reason), 'Application rejected.')
      case 'cancel':
        return run(async () => {
          const res = await cancelEAjoParticipantAction(dialog.participant.id, reason)
          return res.success
            ? { success: true, error: undefined }
            : { success: false, error: res.error }
        }, 'Participant cancelled. Confirmed contributions were credited to the member’s wallet.')
      case 'hold':
        return run(() => holdEAjoPayoutAction(dialog.participant.payout!.id, reason), 'Payout put on hold.')
      case 'reject-receipt':
        return run(
          () => rejectEAjoContributionAction({ groupId: group.id, submissionId: dialog.submissionId, reason }),
          'Receipt rejected.',
        )
      case 'confirm-receipt':
        return run(
          () =>
            confirmEAjoContributionAction({
              groupId: group.id,
              submissionId: dialog.submissionId,
              valueDate: dateValue || undefined,
              valueDateChangeReason: reason || undefined,
            }),
          'Contribution confirmed.',
        )
      case 'activate':
        return run(() => activateEAjoGroupAction(group.id, dateValue || null), 'Group activated.')
      case 'paid':
        return run(async () => {
          if (!evidence) return { success: false, error: 'Attach the transfer evidence.' }
          const fd = new FormData()
          fd.append('file', evidence)
          const up = await uploadReceiptAction(fd)
          if (!up.success || !('fileId' in up) || !up.fileId) {
            return { success: false, error: up.error ?? 'Evidence upload failed.' }
          }
          return recordEAjoPayoutPaidAction({
            payoutId: dialog.participant.payout!.id,
            valueDate: dateValue,
            bankReference: reference,
            evidenceFileId: up.fileId,
          })
        }, 'Payout recorded as paid.')
    }
  }

  const cash = Number(cashBalance)
  const hasCash = cashBalance.trim() !== '' && !isNaN(cash)
  const activeParticipants = participants.filter((p) => p.status === 'ACTIVE' || p.status === 'COMPLETED')

  return (
    <div className='flex flex-col gap-6 w-full max-w-6xl mx-auto py-6'>
      <Link href='/admin/eajo' className='flex items-center gap-1.5 text-muted-foreground hover:text-primary text-xs font-semibold w-fit'>
        <ArrowLeft className='w-4 h-4' /> Back to e-ajo groups
      </Link>

      {/* Header */}
      <div className='bg-surface-container-lowest border border-outline-variant/10 rounded-xl p-6 flex flex-col md:flex-row md:items-end justify-between gap-4'>
        <div className='flex flex-col gap-1.5'>
          <div className='flex items-center gap-2'>
            <Pill status={group.status} />
            {group.startDate && (
              <span className='text-xs text-muted-foreground'>
                {group.startDate} → {group.endDate ?? '—'}
              </span>
            )}
          </div>
          <h1 className='text-2xl font-bold text-primary'>{group.title}</h1>
          {group.description && <p className='text-sm text-muted-foreground max-w-xl'>{group.description}</p>}
          <p className='text-xs text-muted-foreground'>
            {naira(group.contributionAmount)} monthly · {group.totalSlots} slots · max per slot:{' '}
            {group.maxMembersPerSlot ?? 'unlimited'} · late penalty {group.latePenaltyDailyPercent}%/day, cap{' '}
            {group.penaltyCapType === 'FIXED_AMOUNT' ? naira(group.penaltyCapValue) : `${group.penaltyCapValue}% of c × N`}
          </p>
        </div>
        <div className='flex gap-2'>
          {group.status === 'ACTIVE' && canPayouts && (
            <Button
              variant='outline'
              disabled={isPending}
              onClick={() => run(() => refreshEAjoGroupEligibilityAction(group.id), 'Payout eligibility refreshed.')}
              className='gap-1.5'
            >
              <RefreshCw className='w-4 h-4' /> Re-check eligibility
            </Button>
          )}
          {group.status === 'PENDING' && canManage && (
            <Button disabled={isPending} onClick={() => open({ kind: 'activate' })}>
              Activate group
            </Button>
          )}
        </div>
      </div>

      {(error || notice) && !dialog && (
        <div
          className={`p-3 rounded-lg text-xs flex items-start gap-2 border ${error ? 'bg-error-container/10 border-error-container/30 text-error' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}
        >
          {error && <AlertCircle className='w-4 h-4 shrink-0' />}
          <span>{error ?? notice}</span>
        </div>
      )}

      {/* Slot terms */}
      <section className='bg-surface-container-lowest border border-outline-variant/10 rounded-xl p-6 flex flex-col gap-3'>
        <h2 className='text-sm font-bold text-primary uppercase tracking-wide'>Slots</h2>
        <div className='overflow-x-auto'>
          <table className='w-full text-xs'>
            <thead className='text-muted-foreground text-left'>
              <tr>
                <th className='py-2 pr-3'>Slot</th>
                <th className='py-2 pr-3'>Penalty %</th>
                <th className='py-2 pr-3'>Advance</th>
                <th className='py-2 pr-3'>Early-slot penalty</th>
                <th className='py-2 pr-3'>Net payout</th>
                <th className='py-2 pr-3'>Participants</th>
              </tr>
            </thead>
            <tbody>
              {slots.map((s) => {
                const count = participants.filter(
                  (p) => p.slotNumber === s.slotNumber && !['REJECTED', 'CANCELLED'].includes(p.status),
                ).length
                return (
                  <tr key={s.slotNumber} className='border-t border-outline-variant/15'>
                    <td className='py-2 pr-3 font-mono font-bold'>{s.slotNumber}</td>
                    <td className='py-2 pr-3 font-mono'>{s.earlySlotPenaltyPercent}%</td>
                    <td className='py-2 pr-3 font-mono'>{naira(s.advanceAmount)}</td>
                    <td className='py-2 pr-3 font-mono'>{naira(s.earlySlotPenalty)}</td>
                    <td className='py-2 pr-3 font-mono font-semibold'>{naira(s.netPayout)}</td>
                    <td className='py-2 pr-3'>
                      {count}
                      {group.maxMembersPerSlot ? ` / ${group.maxMembersPerSlot}` : ''}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Participants & payouts */}
      <section className='bg-surface-container-lowest border border-outline-variant/10 rounded-xl p-6 flex flex-col gap-3'>
        <h2 className='text-sm font-bold text-primary uppercase tracking-wide'>Participants and payouts</h2>
        {participants.length === 0 ? (
          <p className='text-xs text-muted-foreground'>No applications yet.</p>
        ) : (
          <div className='overflow-x-auto'>
            <table className='w-full text-xs'>
              <thead className='text-muted-foreground text-left'>
                <tr>
                  <th className='py-2 pr-3'>Slot</th>
                  <th className='py-2 pr-3'>Member</th>
                  <th className='py-2 pr-3'>Status</th>
                  <th className='py-2 pr-3'>Guarantor</th>
                  <th className='py-2 pr-3'>Confirmed</th>
                  <th className='py-2 pr-3'>Outstanding</th>
                  <th className='py-2 pr-3'>Payout</th>
                  <th className='py-2 pr-3 text-right'>Actions</th>
                </tr>
              </thead>
              <tbody>
                {participants.map((p) => (
                  <tr key={p.id} className='border-t border-outline-variant/15 align-top'>
                    <td className='py-2 pr-3 font-mono font-bold'>{p.slotNumber}</td>
                    <td className='py-2 pr-3'>
                      <div className='font-semibold text-primary'>{p.name}</div>
                      <div className='text-muted-foreground'>{p.membershipNumber ?? '—'}</div>
                    </td>
                    <td className='py-2 pr-3'>
                      <Pill status={p.status} />
                      {(p.rejectionReason || p.cancellationReason) && (
                        <div className='text-muted-foreground mt-1 max-w-[160px]'>
                          {p.rejectionReason ?? p.cancellationReason}
                        </div>
                      )}
                    </td>
                    <td className='py-2 pr-3'>
                      {p.guarantee ? (
                        <>
                          <div>{p.guarantee.guarantorName}</div>
                          <Pill status={p.guarantee.state} />
                          <div className='text-muted-foreground mt-1'>Reserved {naira(p.guarantee.reservedAmount)}</div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className='py-2 pr-3 font-mono'>{naira(p.confirmed)}</td>
                    <td className='py-2 pr-3 font-mono'>
                      {naira(p.outstandingDue)}
                      {p.overdueMonths.length > 0 && (
                        <div className='text-error font-sans'>Overdue: month {p.overdueMonths.join(', ')}</div>
                      )}
                      {p.penaltyOutstanding > 0 && (
                        <div className='text-error font-sans'>Penalties {naira(p.penaltyOutstanding)}</div>
                      )}
                    </td>
                    <td className='py-2 pr-3'>
                      {p.payout ? (
                        <>
                          <Pill status={p.payout.status} />
                          <div className='font-mono mt-1'>{naira(p.payout.netPayout)}</div>
                          <div className='text-muted-foreground'>Due {p.payout.payoutDueDate}</div>
                          {p.payout.status === 'NOT_ELIGIBLE' && p.payout.eligibilityReason && (
                            <div className='text-muted-foreground max-w-[180px]'>{p.payout.eligibilityReason}</div>
                          )}
                          {p.payout.status === 'HELD' && p.payout.holdReason && (
                            <div className='text-muted-foreground max-w-[180px]'>Hold: {p.payout.holdReason}</div>
                          )}
                          {p.payout.status === 'PAID' && (
                            <div className='text-muted-foreground'>
                              Paid {p.payout.paidOn} · {p.payout.reference}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className='text-muted-foreground'>{naira(slots[p.slotNumber - 1]?.netPayout ?? 0)} (preview)</span>
                      )}
                    </td>
                    <td className='py-2 pr-3'>
                      <div className='flex flex-wrap justify-end gap-1.5'>
                        {canManage && p.status === 'PENDING' && group.status === 'PENDING' && (
                          <>
                            <Button
                              size='sm'
                              disabled={isPending || p.guarantee?.state !== 'CONSENTED'}
                              title={p.guarantee?.state !== 'CONSENTED' ? 'Waiting for guarantor consent' : undefined}
                              onClick={() => run(() => approveEAjoMemberAction(p.id), 'Application approved.')}
                            >
                              Approve
                            </Button>
                            <Button size='sm' variant='outline' disabled={isPending} onClick={() => open({ kind: 'reject-app', participant: p })}>
                              Reject
                            </Button>
                          </>
                        )}
                        {canPayouts && p.payout?.status === 'ELIGIBLE' && (
                          <Button
                            size='sm'
                            disabled={isPending}
                            onClick={() => run(() => approveEAjoPayoutAction(p.payout!.id), 'Payout approved. A second staff member records the transfer.')}
                          >
                            Approve payout
                          </Button>
                        )}
                        {canPayouts && p.payout?.status === 'APPROVED' && (
                          <Button size='sm' disabled={isPending} onClick={() => open({ kind: 'paid', participant: p })}>
                            Record payment
                          </Button>
                        )}
                        {canPayouts && (p.payout?.status === 'ELIGIBLE' || p.payout?.status === 'NOT_ELIGIBLE') && p.status === 'ACTIVE' && (
                          <Button size='sm' variant='outline' disabled={isPending} onClick={() => open({ kind: 'hold', participant: p })}>
                            Hold
                          </Button>
                        )}
                        {canPayouts && p.payout?.status === 'HELD' && (
                          <Button
                            size='sm'
                            variant='outline'
                            disabled={isPending}
                            onClick={() => run(() => releaseEAjoPayoutHoldAction(p.payout!.id), 'Hold released.')}
                          >
                            Release hold
                          </Button>
                        )}
                        {canManage &&
                          (p.status === 'APPROVED' ||
                            (p.status === 'ACTIVE' && ['NOT_ELIGIBLE', 'ELIGIBLE', 'HELD'].includes(p.payout?.status ?? ''))) && (
                            <Button size='sm' variant='ghost' className='text-error' disabled={isPending} onClick={() => open({ kind: 'cancel', participant: p })}>
                              Cancel
                            </Button>
                          )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Pending contribution receipts */}
      {group.status !== 'PENDING' && (
        <section className='bg-surface-container-lowest border border-outline-variant/10 rounded-xl p-6 flex flex-col gap-3'>
          <h2 className='text-sm font-bold text-primary uppercase tracking-wide'>Contribution receipts awaiting review</h2>
          <p className='text-xs text-muted-foreground'>
            A receipt is the member’s claim. Check it against the bank statement before confirming; the value date is the day the
            money reached the cooperative.
          </p>
          {pendingContributions.length === 0 ? (
            <p className='text-xs text-muted-foreground'>Nothing to review.</p>
          ) : (
            <table className='w-full text-xs'>
              <thead className='text-muted-foreground text-left'>
                <tr>
                  <th className='py-2 pr-3'>Receipt</th>
                  <th className='py-2 pr-3'>Member</th>
                  <th className='py-2 pr-3'>Months</th>
                  <th className='py-2 pr-3'>Amount</th>
                  <th className='py-2 pr-3'>Paid on</th>
                  <th className='py-2 pr-3'>Bank ref.</th>
                  <th className='py-2 pr-3 text-right'>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pendingContributions.map((s) => (
                  <tr key={s.id} className='border-t border-outline-variant/15'>
                    <td className='py-2 pr-3 font-mono'>
                      {s.receiptFileId ? (
                        <a className='underline text-primary' href={`/api/files/${s.receiptFileId}`} target='_blank' rel='noreferrer'>
                          {s.submissionNumber}
                        </a>
                      ) : (
                        s.submissionNumber
                      )}
                    </td>
                    <td className='py-2 pr-3'>{s.memberName}</td>
                    <td className='py-2 pr-3'>{s.months.join(', ')}</td>
                    <td className='py-2 pr-3 font-mono'>{naira(s.claimedAmount)}</td>
                    <td className='py-2 pr-3'>{s.paidOn}</td>
                    <td className='py-2 pr-3'>{s.bankReference ?? '—'}</td>
                    <td className='py-2 pr-3'>
                      {canReview && (
                        <div className='flex justify-end gap-1.5'>
                          <Button
                            size='sm'
                            disabled={isPending}
                            onClick={() =>
                              open({ kind: 'confirm-receipt', submissionId: s.id, number: s.submissionNumber, paidOn: s.paidOn, amount: s.claimedAmount })
                            }
                          >
                            Confirm
                          </Button>
                          <Button
                            size='sm'
                            variant='outline'
                            disabled={isPending}
                            onClick={() => open({ kind: 'reject-receipt', submissionId: s.id, number: s.submissionNumber })}
                          >
                            Reject
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* Funding requirement */}
      {group.startDate && activeParticipants.length > 0 && (
        <section className='bg-surface-container-lowest border border-outline-variant/10 rounded-xl p-6 flex flex-col gap-3'>
          <div className='flex flex-col md:flex-row md:items-end justify-between gap-3'>
            <div>
              <h2 className='text-sm font-bold text-primary uppercase tracking-wide'>Monthly funding requirement</h2>
              <p className='text-xs text-muted-foreground max-w-xl'>
                Payouts due in the month minus contributions confirmed for that month. Enter the cash available to see which months
                need more funds.
              </p>
            </div>
            <div className='flex flex-col gap-1'>
              <Label htmlFor='cash' className='text-xs'>Cash balance available (₦)</Label>
              <Input id='cash' type='number' min='0' value={cashBalance} onChange={(e) => setCashBalance(e.target.value)} className='h-9 w-48 font-mono' />
            </div>
          </div>
          <table className='w-full text-xs'>
            <thead className='text-muted-foreground text-left'>
              <tr>
                <th className='py-2 pr-3'>Month</th>
                <th className='py-2 pr-3'>Due</th>
                <th className='py-2 pr-3'>Payouts</th>
                <th className='py-2 pr-3'>Payouts due</th>
                <th className='py-2 pr-3'>Expected contributions</th>
                <th className='py-2 pr-3'>Confirmed</th>
                <th className='py-2 pr-3'>Requirement</th>
              </tr>
            </thead>
            <tbody>
              {funding.map((f) => {
                const short = hasCash && f.fundingRequirement > cash
                return (
                  <tr key={f.month} className={`border-t border-outline-variant/15 ${short ? 'bg-error-container/10' : ''}`}>
                    <td className='py-2 pr-3 font-mono'>{f.month}</td>
                    <td className='py-2 pr-3'>{f.dueDate}</td>
                    <td className='py-2 pr-3'>{f.payoutCount}</td>
                    <td className='py-2 pr-3 font-mono'>{naira(f.payoutsDue)}</td>
                    <td className='py-2 pr-3 font-mono'>{naira(f.expectedContributions)}</td>
                    <td className='py-2 pr-3 font-mono'>{naira(f.confirmedContributions)}</td>
                    <td className={`py-2 pr-3 font-mono font-semibold ${short ? 'text-error' : ''}`}>
                      {naira(f.fundingRequirement)}
                      {short && <span className='ml-1 font-sans'>exceeds cash</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && !isPending && setDialog(null)}>
        <DialogContent>
          {dialog && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {dialog.kind === 'reject-app' && 'Reject application'}
                  {dialog.kind === 'cancel' && 'Cancel participant'}
                  {dialog.kind === 'hold' && 'Hold payout'}
                  {dialog.kind === 'paid' && 'Record payout transfer'}
                  {dialog.kind === 'reject-receipt' && `Reject receipt ${dialog.number}`}
                  {dialog.kind === 'confirm-receipt' && `Confirm receipt ${dialog.number}`}
                  {dialog.kind === 'activate' && 'Activate group'}
                </DialogTitle>
                <DialogDescription>
                  {dialog.kind === 'reject-app' && `${dialog.participant.name} (slot ${dialog.participant.slotNumber}). The guarantee is released.`}
                  {dialog.kind === 'cancel' &&
                    `${dialog.participant.name} leaves the group before payout. Confirmed contributions (${naira(dialog.participant.confirmed)}) go to their wallet, no early-slot penalty is charged and the guarantee is released. This cannot be undone.`}
                  {dialog.kind === 'hold' && `${dialog.participant.name}’s payout will not be approved until the hold is released.`}
                  {dialog.kind === 'paid' &&
                    `Pay ${naira(dialog.participant.payout?.netPayout ?? 0)} to ${dialog.participant.name} (early-slot penalty ${naira(dialog.participant.payout?.earlySlotPenalty ?? 0)} deducted). Record this only after the transfer was made. A different staff member from the approver must record it.`}
                  {dialog.kind === 'reject-receipt' && 'The member sees the reason and can upload a new receipt.'}
                  {dialog.kind === 'confirm-receipt' &&
                    `Confirm ${naira(dialog.amount)}. It pays the selected months, penalty first; any excess goes to the member’s wallet.`}
                  {dialog.kind === 'activate' &&
                    `Approved participants (${participants.filter((p) => p.status === 'APPROVED').length}) become active, contribution months and payouts are created, and the roster and amounts are locked. Pending applications are rejected.`}
                </DialogDescription>
              </DialogHeader>

              <div className='flex flex-col gap-3'>
                {(dialog.kind === 'activate' || dialog.kind === 'paid' || dialog.kind === 'confirm-receipt') && (
                  <div className='flex flex-col gap-1'>
                    <Label htmlFor='dlg-date' className='text-xs'>
                      {dialog.kind === 'activate' ? 'Start date (month 1 due date)' : 'Value date'}
                    </Label>
                    <Input id='dlg-date' type='date' value={dateValue} onChange={(e) => setDateValue(e.target.value)} />
                  </div>
                )}
                {dialog.kind === 'paid' && (
                  <>
                    <div className='flex flex-col gap-1'>
                      <Label htmlFor='dlg-ref' className='text-xs'>Bank transfer reference</Label>
                      <Input id='dlg-ref' value={reference} onChange={(e) => setReference(e.target.value)} />
                    </div>
                    <div className='flex flex-col gap-1'>
                      <Label htmlFor='dlg-ev' className='text-xs'>Transfer evidence (image or PDF)</Label>
                      <Input id='dlg-ev' type='file' accept='image/*,application/pdf' onChange={(e) => setEvidence(e.target.files?.[0] ?? null)} />
                    </div>
                  </>
                )}
                {['reject-app', 'cancel', 'hold', 'reject-receipt'].includes(dialog.kind) && (
                  <div className='flex flex-col gap-1'>
                    <Label htmlFor='dlg-reason' className='text-xs'>Reason</Label>
                    <Textarea id='dlg-reason' value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
                  </div>
                )}
                {dialog.kind === 'confirm-receipt' && dateValue !== (dialog.paidOn ?? '') && (
                  <div className='flex flex-col gap-1'>
                    <Label htmlFor='dlg-vreason' className='text-xs'>Reason for changing the value date</Label>
                    <Textarea id='dlg-vreason' value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
                  </div>
                )}
                {error && (
                  <div className='bg-error-container/10 border border-error-container/30 text-error p-2 rounded text-xs flex gap-2'>
                    <AlertCircle className='w-4 h-4 shrink-0' /> {error}
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button variant='outline' disabled={isPending} onClick={() => setDialog(null)}>
                  Close
                </Button>
                <Button
                  disabled={
                    isPending ||
                    (['reject-app', 'cancel', 'hold', 'reject-receipt'].includes(dialog.kind) && !reason.trim()) ||
                    (dialog.kind === 'paid' && (!reference.trim() || !evidence || !dateValue))
                  }
                  onClick={submitDialog}
                >
                  {isPending && <Loader2 className='w-4 h-4 animate-spin mr-1' />}
                  Confirm
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
