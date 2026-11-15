'use client'

import React, { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent } from '../ui/card'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'
import { ReceiptDropzone } from '../ui/ReceiptDropzone'
import { approveLoanAction, disburseLoanAction, rejectLoanAction } from '@/models/admin/loanActions'
import { confirmPaymentSubmissionAction, rejectPaymentSubmissionAction } from '@/models/payments/actions'
import { uploadReceiptAction } from '@/models/eajo/actions'
import type { getLoanByIdQuery } from '@/models/admin/query'
import {
  formatDay,
  formatNGN,
  InstalmentStatusBadge,
  LoanCostSummary,
  LoanStatusBadge,
  loanStatusLabel,
} from '../loans/loanDisplay'

type AdminLoan = NonNullable<Awaited<ReturnType<typeof getLoanByIdQuery>>['data']>

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date())

function Row({ k, v, strong }: { k: string; v: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{k}</span>
      <span className={strong ? 'font-semibold text-right' : 'text-right'}>{v}</span>
    </div>
  )
}

/**
 * Admin loan review (P3-04): consent states, capacity numbers, savings lock,
 * history, outstanding obligations and fee status on one screen; approve
 * (same or lower amount / other term → re-consent), reject with reason,
 * record the disbursement (dual control), and confirm loan receipts.
 */
export const AdminLoanDetailsClient = ({ loan }: { loan: AdminLoan }) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const review = loan.review

  const [approveOpen, setApproveOpen] = useState(false)
  const [approveAmount, setApproveAmount] = useState(String(loan.requestedAmount))
  const [approveTerm, setApproveTerm] = useState(String(loan.duration))
  const [approveNote, setApproveNote] = useState('')
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [disburseOpen, setDisburseOpen] = useState(false)
  const [valueDate, setValueDate] = useState(today())
  const [bankReference, setBankReference] = useState('')
  const [bankAccountId, setBankAccountId] = useState(
    loan.member?.bankAccounts.find((b) => b.isPrimary)?.id ?? loan.member?.bankAccounts[0]?.id ?? '',
  )
  const [evidence, setEvidence] = useState<File | null>(null)
  const [receiptReject, setReceiptReject] = useState<{ id: string; reason: string } | null>(null)

  const run = (
    fn: () => Promise<{ success: boolean; error?: string }>,
    ok: string,
    after?: () => void,
  ) =>
    startTransition(async () => {
      const res = await fn()
      if (res.success) {
        toast.success(ok)
        after?.()
        router.refresh()
      } else {
        toast.error(res.error || 'Action failed.')
      }
    })

  const termsChanged =
    Number(approveAmount) !== loan.requestedAmount || Number(approveTerm) !== (loan.requestedDurationMonths ?? loan.duration)

  const submitDisbursement = () => {
    if (!evidence) return toast.error('Upload the transfer evidence.')
    startTransition(async () => {
      const fd = new FormData()
      fd.append('file', evidence)
      const up = await uploadReceiptAction(fd)
      if (!up.success || !('fileId' in up) || !up.fileId) {
        toast.error(up.error || 'Evidence upload failed.')
        return
      }
      const res = await disburseLoanAction(loan.id, {
        amount: loan.approvedAmount ?? 0,
        valueDate,
        bankReference,
        evidenceFileId: up.fileId,
        bankAccountId: bankAccountId || undefined,
      })
      if (res.success) {
        toast.success('Disbursement recorded. The repayment schedule is active.')
        setDisburseOpen(false)
        router.refresh()
      } else {
        toast.error(res.error || 'Failed to record the disbursement.')
      }
    })
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6 p-4 md:p-6">
      <Link href="/admin/loans" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary">
        <ArrowLeft className="w-4 h-4" /> All loans
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-primary">
            {loan.user.name} · {formatNGN(loan.approvedAmount ?? loan.requestedAmount)}
          </h1>
          <p className="text-sm text-muted-foreground">
            Requested {formatNGN(loan.requestedAmount)} over {loan.requestedDurationMonths ?? loan.duration} months ·{' '}
            {loan.purpose} · applied {formatDay(loan.createdAt)}
          </p>
        </div>
        <LoanStatusBadge status={loan.status} />
      </div>

      <div className="flex flex-wrap gap-2">
        {loan.status === 'PENDING' && (
          <>
            <Button onClick={() => setApproveOpen(true)} disabled={isPending}>
              Review & approve
            </Button>
            <Button variant="outline" onClick={() => setRejectOpen(true)} disabled={isPending}>
              Reject
            </Button>
          </>
        )}
        {loan.status === 'ACCEPTED' && (
          <Button onClick={() => setDisburseOpen(true)} disabled={isPending}>
            Record disbursement
          </Button>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <h2 className="font-semibold mb-2">Consent</h2>
            <Row k="Guarantor" v={loan.guarantee?.guarantorName ?? '—'} />
            <Row k="Guarantor consent" v={loan.guarantee?.state ?? 'none'} strong />
            <Row k="Consented amount" v={formatNGN(review?.guaranteeConsentedAmount)} />
            <Row k="Borrower offer" v={loan.offer?.decision ?? 'not offered yet'} strong />
            {loan.offer?.evidenceDocumentId && <Row k="Offer evidence" v={loan.offer.evidenceDocumentId} />}
            <Row k="Terms version" v={loan.termsVersion} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <h2 className="font-semibold mb-2">Capacity (§2.1)</h2>
            <Row k="Eligible savings" v={formatNGN(review?.eligibleSavings)} />
            <Row k="Standalone limit (2×)" v={formatNGN(review?.standaloneLimit)} />
            <Row k="Current loan exposure" v={formatNGN(review?.existingExposure)} />
            {review?.supportNeeded !== null && review?.supportNeeded !== undefined && (
              <Row k="Guarantee support needed" v={formatNGN(review.supportNeeded)} strong />
            )}
            <Row k="Reserved from guarantor" v={formatNGN(review?.guaranteeReserved)} />
            <Row k="Guarantor free capacity" v={formatNGN(review?.guarantorFreeCapacity)} />
            <Row k="Own savings locked" v={review?.savingsLocked ? 'Yes' : 'No'} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <h2 className="font-semibold mb-2">Obligations & fee</h2>
            <Row
              k="Application fee"
              v={loan.fee ? `${formatNGN(loan.fee.amount)} · ${loan.fee.status}` : 'None'}
              strong
            />
            {loan.fee && loan.fee.outstanding > 0 && (
              <p className="text-xs text-error">Approval is blocked until the fee is paid.</p>
            )}
            <Row k="Overdue instalments (all loans)" v={review?.overdueInstalments ?? 0} />
            <Row k="Outstanding on this loan" v={formatNGN(loan.outstandingBalance)} />
            {loan.approvalNote && <Row k="Approval note" v={loan.approvalNote} />}
            {loan.rejectionReason && <Row k="Reason" v={loan.rejectionReason} />}
          </CardContent>
        </Card>
      </div>

      {loan.offerQuote && (
        <Card>
          <CardContent className="pt-6">
            <h2 className="font-semibold mb-2">
              {loan.status === 'PENDING' ? 'Requested terms' : 'Offered terms'}
            </h2>
            <LoanCostSummary quote={loan.offerQuote} />
          </CardContent>
        </Card>
      )}

      {loan.receiptsToReview.length > 0 && (
        <Card>
          <CardContent className="pt-6 space-y-3">
            <h2 className="font-semibold">Receipts awaiting confirmation</h2>
            <p className="text-xs text-muted-foreground">
              Confirm only after matching the receipt against the cooperative’s bank statement. The value date is the
              day the money reached the account and drives lateness.
            </p>
            {loan.receiptsToReview.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2 text-sm">
                <span>
                  {r.submissionNumber} · {r.purpose} · {formatNGN(r.claimedAmount)} · paid {formatDay(r.paidOn)}
                  {r.bankReference ? ` · ref ${r.bankReference}` : ''}
                  {r.receiptUrl && (
                    <a href={r.receiptUrl} target="_blank" rel="noreferrer" className="ml-2 text-primary underline">
                      receipt
                    </a>
                  )}
                </span>
                <span className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={isPending}
                    onClick={() =>
                      run(() => confirmPaymentSubmissionAction({ submissionId: r.id }), 'Payment confirmed and applied.')
                    }
                  >
                    Confirm
                  </Button>
                  <Button size="sm" variant="outline" disabled={isPending} onClick={() => setReceiptReject({ id: r.id, reason: '' })}>
                    Reject
                  </Button>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {loan.instalments.length > 0 && (
        <Card>
          <CardContent className="pt-6 overflow-x-auto">
            <h2 className="font-semibold mb-3">
              Instalments (disbursed {formatDay(loan.disbursementValueDate)})
            </h2>
            <table className="w-full text-sm min-w-[640px]">
              <thead className="text-xs text-muted-foreground text-left">
                <tr>
                  <th className="py-2">#</th>
                  <th>Due</th>
                  <th className="text-right">Principal paid / due</th>
                  <th className="text-right">Interest paid / due</th>
                  <th className="text-right">Penalty paid / assessed</th>
                  <th className="text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {loan.instalments.map((i) => (
                  <tr key={i.id}>
                    <td className="py-2">{i.instalmentNumber}</td>
                    <td>{formatDay(i.dueDate)}</td>
                    <td className="text-right">
                      {formatNGN(i.principalPaid)} / {formatNGN(i.principalDue)}
                    </td>
                    <td className="text-right">
                      {formatNGN(i.interestPaid)} / {formatNGN(i.interestDue)}
                    </td>
                    <td className="text-right">
                      {formatNGN(i.penaltyPaid)} / {formatNGN(i.penaltyAssessed - i.penaltyWaived)}
                    </td>
                    <td className="text-right">
                      <InstalmentStatusBadge status={i.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {review && review.otherLoans.length > 0 && (
        <Card>
          <CardContent className="pt-6 text-sm">
            <h2 className="font-semibold mb-2">Member’s other loans</h2>
            {review.otherLoans.map((l) => (
              <Link key={l.id} href={`/admin/loans/${l.id}`} className="flex justify-between py-1 hover:text-primary">
                <span>
                  {formatDay(l.createdAt)} · {formatNGN(l.approvedAmount ?? l.requestedAmount)} · {l.duration} months
                </span>
                <span>
                  {loanStatusLabel(l.status)} · outstanding {formatNGN(l.outstandingBalance)}
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Approve */}
      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve loan</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Eligibility is a ceiling, not an entitlement. You may approve a lower amount or a different term; the
              member must then accept the final offer and the guarantor must consent again.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="approveAmount">Amount (≤ {formatNGN(loan.requestedAmount)})</Label>
                <Input
                  id="approveAmount"
                  type="number"
                  step="0.01"
                  max={loan.requestedAmount}
                  value={approveAmount}
                  onChange={(e) => setApproveAmount(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="approveTerm">Term (months)</Label>
                <Input
                  id="approveTerm"
                  type="number"
                  min={1}
                  max={12}
                  value={approveTerm}
                  onChange={(e) => setApproveTerm(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="approveNote">Note (optional)</Label>
              <Textarea id="approveNote" value={approveNote} onChange={(e) => setApproveNote(e.target.value)} />
            </div>
            {termsChanged && (
              <p className="text-xs text-warning">These terms differ from the application: re-consent will be required.</p>
            )}
            <Button
              disabled={isPending}
              onClick={() =>
                run(
                  () =>
                    approveLoanAction(loan.id, Number(approveAmount), {
                      approvedTermMonths: Number(approveTerm),
                      note: approveNote,
                    }),
                  termsChanged ? 'Revised offer sent for re-consent.' : 'Loan approved; offer sent to the member.',
                  () => setApproveOpen(false),
                )
              }
            >
              {isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}Approve {formatNGN(Number(approveAmount))}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reject */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject application</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor="rejectReason">Reason (shown to the member)</Label>
            <Textarea id="rejectReason" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
            <Button
              variant="destructive"
              disabled={isPending || !rejectReason.trim()}
              onClick={() =>
                run(() => rejectLoanAction(loan.id, rejectReason), 'Application rejected.', () => setRejectOpen(false))
              }
            >
              Reject
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Disburse */}
      <Dialog open={disburseOpen} onOpenChange={setDisburseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record disbursement</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Record the transfer of <strong>{formatNGN(loan.approvedAmount)}</strong> to {loan.user.name} only after it
              has been made. This activates the loan and its repayment schedule from the value date and cannot be
              undone here. The approver cannot also disburse when another authorised staff member exists.
            </p>
            <div className="space-y-1">
              <Label htmlFor="bankAccount">Destination account</Label>
              <select
                id="bankAccount"
                className="w-full rounded-md border border-border bg-background p-2"
                value={bankAccountId}
                onChange={(e) => setBankAccountId(e.target.value)}
              >
                {loan.member?.bankAccounts.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.bankName} · {b.accountNumberMasked} · {b.accountName}
                    {b.isVerified ? '' : ' (unverified)'}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="valueDate">Value date</Label>
                <Input id="valueDate" type="date" max={today()} value={valueDate} onChange={(e) => setValueDate(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bankReference">Bank reference</Label>
                <Input id="bankReference" value={bankReference} onChange={(e) => setBankReference(e.target.value)} />
              </div>
            </div>
            <ReceiptDropzone value={evidence} onFileSelected={setEvidence} />
            <Button disabled={isPending || !bankReference.trim() || !evidence} onClick={submitDisbursement}>
              {isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}Confirm disbursement
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reject receipt */}
      <Dialog open={!!receiptReject} onOpenChange={(o) => !o && setReceiptReject(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject receipt</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              value={receiptReject?.reason ?? ''}
              onChange={(e) => setReceiptReject((r) => (r ? { ...r, reason: e.target.value } : r))}
              placeholder="Why is this receipt rejected?"
            />
            <Button
              variant="destructive"
              disabled={isPending || !receiptReject?.reason.trim()}
              onClick={() =>
                receiptReject &&
                run(
                  () =>
                    rejectPaymentSubmissionAction({
                      submissionId: receiptReject.id,
                      rejectionReason: receiptReject.reason,
                    }),
                  'Receipt rejected.',
                  () => setReceiptReject(null),
                )
              }
            >
              Reject receipt
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default AdminLoanDetailsClient
