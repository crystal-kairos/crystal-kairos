'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertCircle, ArrowRight, Upload } from 'lucide-react'
import { Button } from '../ui/button'
import { UploadAjoReceiptDialog } from './UploadAjoReceiptDialog'
import { decideGuarantorRequestAction } from '@/models/loans/actions'
import type { getMyEAjoGuaranteeRequests, getOpenEAjoGroups, getUserEAjoMemberships } from '@/models/eajo/query'

type Membership = NonNullable<Awaited<ReturnType<typeof getUserEAjoMemberships>>['data']>[number]
type OpenGroup = NonNullable<Awaited<ReturnType<typeof getOpenEAjoGroups>>['data']>[number]
type GuaranteeRequest = Awaited<ReturnType<typeof getMyEAjoGuaranteeRequests>>['data'][number]

const naira = (v: number) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(v)

const STYLES: Record<string, string> = {
  PENDING: 'bg-amber-50 text-amber-700 border-amber-200',
  APPROVED: 'bg-blue-50 text-blue-700 border-blue-200',
  ACTIVE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  COMPLETED: 'bg-slate-100 text-slate-600 border-slate-200',
  ONGOING: 'bg-blue-50 text-blue-700 border-blue-200',
  IN_REVIEW: 'bg-amber-50 text-amber-700 border-amber-200',
  OVERDUE: 'bg-red-50 text-red-700 border-red-200',
  REJECTED: 'bg-red-50 text-red-700 border-red-200',
  CANCELLED: 'bg-red-50 text-red-600 border-red-200',
  NOT_ELIGIBLE: 'bg-slate-100 text-slate-600 border-slate-200',
  ELIGIBLE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  HELD: 'bg-amber-50 text-amber-700 border-amber-200',
  PAID: 'bg-blue-50 text-blue-700 border-blue-200',
  CONSENTED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  DECLINED: 'bg-red-50 text-red-700 border-red-200',
  RELEASED: 'bg-slate-100 text-slate-600 border-slate-200',
}

const LABELS: Record<string, string> = {
  IN_REVIEW: 'Payment under review',
  ONGOING: 'Part paid',
  COMPLETED: 'Paid',
  NOT_ELIGIBLE: 'Not yet eligible',
  ELIGIBLE: 'Eligible — awaiting approval',
  APPROVED: 'Approved — being paid',
  HELD: 'On hold',
  CONSENTED: 'Consented',
  WITHDRAWN_BEFORE_ACTIVATION: 'Withdrawn',
}

const Pill = ({ status, participation }: { status: string; participation?: boolean }) => (
  <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${STYLES[status] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
    {participation && status === 'COMPLETED' ? 'Completed' : participation && status === 'APPROVED' ? 'Approved' : (LABELS[status] ?? status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' '))}
  </span>
)

interface Props {
  userId: string
  today: string
  memberships: Membership[]
  openGroups: OpenGroup[]
  guaranteeRequests: GuaranteeRequest[]
  canActAsGuarantor: boolean
}

export const EAjoDashboardClient = ({ userId, today, memberships, openGroups, guaranteeRequests, canActAsGuarantor }: Props) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [uploadFor, setUploadFor] = useState<Membership | null>(null)
  const [error, setError] = useState<string | null>(null)

  const joined = new Set(memberships.map((m) => m.group.id))
  const available = openGroups.filter((g) => !joined.has(g.id))
  const pendingRequests = guaranteeRequests.filter((r) => r.state === 'PENDING')

  const decide = (reservationId: string, decision: 'ACCEPT' | 'DECLINE') => {
    setError(null)
    startTransition(async () => {
      const res = await decideGuarantorRequestAction({ reservationId, decision })
      if (!res.success) setError(res.error ?? 'Your decision could not be saved.')
      else router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-6 w-full max-w-6xl mx-auto py-6">
      <div>
        <h1 className="text-2xl font-bold text-primary">E-ajo</h1>
        <p className="text-sm text-muted-foreground">Monthly contributions with a guaranteed payout in the month you choose.</p>
      </div>

      {error && (
        <div className="bg-error-container/10 border border-error-container/30 text-error p-3 rounded-lg flex gap-2 text-xs">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {pendingRequests.length > 0 && (
        <section className="bg-amber-50/60 border border-amber-200 rounded-xl p-5 flex flex-col gap-3">
          <h2 className="text-sm font-bold text-primary">Guarantee requests for you</h2>
          {pendingRequests.map((r) => (
            <div key={r.id} className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-surface-container-lowest rounded-lg p-3 border border-outline-variant/10 text-xs">
              <div>
                <p className="font-semibold text-primary">
                  {r.applicantName} asks you to guarantee their e-ajo in “{r.groupTitle}” (slot {r.slotNumber} of {r.totalSlots}).
                </p>
                <p className="text-muted-foreground">
                  {r.amount > 0
                    ? `If you accept, ${naira(r.amount)} of your savings is reserved until their contributions are complete. It reduces as they pay after their payout.`
                    : 'This slot needs no advance, so none of your savings is reserved, but your consent is still required.'}
                </p>
              </div>
              {canActAsGuarantor && (
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" disabled={isPending} onClick={() => decide(r.id, 'ACCEPT')}>Accept</Button>
                  <Button size="sm" variant="outline" disabled={isPending} onClick={() => decide(r.id, 'DECLINE')}>Decline</Button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-bold text-primary uppercase tracking-wide">My groups</h2>
        {memberships.length === 0 && <p className="text-xs text-muted-foreground">You have not joined an e-ajo group yet.</p>}
        {memberships.map((m) => {
          const showSchedule = m.periods.length > 0
          return (
            <div key={m.id} className="bg-surface-container-lowest border border-outline-variant/10 rounded-xl p-5 flex flex-col gap-4">
              <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <Pill status={m.status} participation />
                    <span className="text-xs text-muted-foreground">Slot {m.slotNumber} of {m.group.totalSlots}</span>
                  </div>
                  <h3 className="text-lg font-bold text-primary">{m.group.title}</h3>
                  <p className="text-xs text-muted-foreground">
                    {naira(m.group.contributionAmount)} monthly
                    {m.group.startDate ? ` · started ${m.group.startDate}` : ' · starts when the group is activated'}
                  </p>
                  {m.guarantee && (
                    <p className="text-xs text-muted-foreground">
                      Guarantor: {m.guarantee.guarantorName} · <Pill status={m.guarantee.state} />
                    </p>
                  )}
                  {(m.rejectionReason || m.cancellationReason) && (
                    <p className="text-xs text-error">{m.rejectionReason ?? m.cancellationReason}</p>
                  )}
                </div>

                <div className="bg-surface-bright border border-outline-variant/10 rounded-lg p-3 text-xs min-w-[240px] flex flex-col gap-1">
                  <span className="text-muted-foreground uppercase text-[10px] font-semibold">Your payout</span>
                  <span className="text-xl font-bold font-mono text-success-green">{naira(m.payout?.netPayout ?? m.preview.netPayout)}</span>
                  <span className="text-muted-foreground">
                    {naira(m.payout?.expectedPayout ?? m.preview.expectedPayout)} − early-slot penalty{' '}
                    {naira(m.payout?.earlySlotPenalty ?? m.preview.earlySlotPenalty)}
                  </span>
                  {m.payout && (
                    <>
                      <span>Payout month: {m.payout.payoutDueDate}</span>
                      <Pill status={m.payout.status} />
                      {m.payout.status === 'NOT_ELIGIBLE' && m.payout.eligibilityReason && (
                        <span className="text-muted-foreground">{m.payout.eligibilityReason}</span>
                      )}
                      {m.payout.status === 'PAID' && (
                        <span>
                          Paid on {m.payout.paidOn}
                          {m.payout.evidenceFileId && (
                            <>
                              {' · '}
                              <a className="underline" href={`/api/files/${m.payout.evidenceFileId}`} target="_blank" rel="noreferrer">evidence</a>
                            </>
                          )}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>

              {showSchedule && (
                <>
                  <div className="flex flex-wrap gap-4 text-xs">
                    <span>Confirmed: <strong className="font-mono">{naira(m.totals.confirmed)}</strong></span>
                    <span>Outstanding now: <strong className="font-mono">{naira(m.totals.outstanding)}</strong></span>
                    {m.totals.overdueCount > 0 && <span className="text-error">{m.totals.overdueCount} overdue month(s)</span>}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="text-muted-foreground text-left">
                        <tr>
                          <th className="py-1.5 pr-3">Month</th>
                          <th className="py-1.5 pr-3">Due</th>
                          <th className="py-1.5 pr-3">Contribution</th>
                          <th className="py-1.5 pr-3">Paid</th>
                          <th className="py-1.5 pr-3">Late penalty</th>
                          <th className="py-1.5 pr-3">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {m.periods.map((p) => (
                          <tr key={p.id} className={`border-t border-outline-variant/15 ${p.periodNumber === m.slotNumber ? 'bg-light-blue/40' : ''}`}>
                            <td className="py-1.5 pr-3 font-mono">
                              {p.periodNumber}
                              {p.periodNumber === m.slotNumber && <span className="ml-1 text-[10px] text-primary font-sans">payout</span>}
                            </td>
                            <td className="py-1.5 pr-3">{p.dueDate}</td>
                            <td className="py-1.5 pr-3 font-mono">{naira(p.contributionDue)}</td>
                            <td className="py-1.5 pr-3 font-mono">{naira(p.contributionPaid)}</td>
                            <td className="py-1.5 pr-3 font-mono">{p.penaltyOutstanding > 0 ? naira(p.penaltyOutstanding) : '—'}</td>
                            <td className="py-1.5 pr-3"><Pill status={p.status} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {m.status === 'ACTIVE' && (
                    <Button size="sm" className="w-fit gap-1.5" onClick={() => setUploadFor(m)}>
                      <Upload className="w-4 h-4" /> Upload contribution receipt
                    </Button>
                  )}
                </>
              )}
              {!showSchedule && m.status === 'PENDING' && (
                <p className="text-xs text-muted-foreground">
                  {m.guarantee?.state === 'CONSENTED'
                    ? 'Your guarantor has consented. Waiting for an administrator to approve your application.'
                    : 'Waiting for your guarantor to consent.'}
                </p>
              )}
              {!showSchedule && m.status === 'APPROVED' && (
                <p className="text-xs text-muted-foreground">Approved. Your contribution schedule appears when the group is activated.</p>
              )}
            </div>
          )
        })}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-bold text-primary uppercase tracking-wide">Open groups</h2>
        {available.length === 0 ? (
          <p className="text-xs text-muted-foreground">No groups are open for applications right now.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {available.map((g) => (
              <div key={g.id} className="bg-surface-container-lowest border border-outline-variant/10 rounded-xl p-5 flex flex-col gap-2">
                <h3 className="font-bold text-primary">{g.title}</h3>
                {g.description && <p className="text-xs text-muted-foreground line-clamp-2">{g.description}</p>}
                <p className="text-xs">
                  {naira(g.contributionAmount)} monthly · {g.totalSlots} months · payout up to {naira(g.expectedPayout)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {g.availableSlots} of {g.totalSlots} slots open{g.startDate ? ` · starts ${g.startDate}` : ''}
                </p>
                <Link href={`/dashboard/${userId}/eajo/new?groupId=${g.id}`} className="mt-auto">
                  <Button size="sm" className="w-full gap-1.5">Choose a slot <ArrowRight className="w-4 h-4" /></Button>
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>

      {uploadFor && (
        <UploadAjoReceiptDialog
          open={uploadFor !== null}
          onOpenChange={(o) => !o && setUploadFor(null)}
          userId={userId}
          eAjoMemberId={uploadFor.id}
          groupTitle={uploadFor.group.title}
          today={today}
          periods={uploadFor.periods.map((p) => ({
            id: p.id,
            periodNumber: p.periodNumber,
            dueDate: p.dueDate,
            totalOutstanding: p.totalOutstanding,
            penaltyOutstanding: p.penaltyOutstanding,
            inReview: p.inReview,
          }))}
        />
      )}
    </div>
  )
}
