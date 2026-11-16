'use client'

import React, { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowLeft, Clock, FileCheck2, Loader2, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent } from '../ui/card'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Label } from '../ui/label'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { ReceiptDropzone } from '../ui/ReceiptDropzone'
import {
  acceptLoanOfferAction,
  cancelLoanApplicationAction,
  declineLoanOfferAction,
  payLoanFeeFromWalletAction,
  payLoanFromWalletAction,
  submitLoanFeeReceiptAction,
  submitLoanRepaymentAction,
} from '@/models/loans/actions'
import { uploadReceiptAction } from '@/models/eajo/actions'
import type { getLoanPlanById } from '@/models/loans/query'
import {
  formatDay,
  formatNGN,
  InstalmentStatusBadge,
  LoanCostSummary,
  LoanStatusBadge,
} from './loanDisplay'

type LoanData = NonNullable<Awaited<ReturnType<typeof getLoanPlanById>>['data']>

interface LoanDetailsClientProps {
  userId: string
  loan: LoanData
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date())
const newKey = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

type PayMode = { kind: 'instalment'; instalmentId: string; amount: number } | { kind: 'settle'; amount: number } | { kind: 'fee'; amount: number }

export const LoanDetailsClient = ({ userId, loan }: LoanDetailsClientProps) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const isOwner = loan.userId === userId

  const [declineOpen, setDeclineOpen] = useState(false)
  const [declineReason, setDeclineReason] = useState('')
  const [payMode, setPayMode] = useState<PayMode | null>(null)
  const [payAmount, setPayAmount] = useState('')
  const [paidOn, setPaidOn] = useState(today())
  const [bankReference, setBankReference] = useState('')
  const [receiptFile, setReceiptFile] = useState<File | null>(null)
  const [payError, setPayError] = useState<string | null>(null)
  const [walletKey, setWalletKey] = useState(newKey)

  const instalments = loan.instalments
  const nextDue = useMemo(
    () => instalments.find((i) => i.status !== 'COMPLETED' && i.status !== 'WAIVED'),
    [instalments],
  )
  const outstandingOf = (i: LoanData['instalments'][number]) =>
    Math.max(0, i.principalDue - i.principalPaid) +
    Math.max(0, i.interestDue - i.interestPaid) +
    Math.max(0, i.penaltyAssessed - i.penaltyPaid - i.penaltyWaived)

  const run = (fn: () => Promise<{ success: boolean; error?: string }>, ok: string, after?: () => void) =>
    startTransition(async () => {
      const res = await fn()
      if (res.success) {
        toast.success(ok)
        after?.()
        router.refresh()
      } else {
        toast.error(res.error || 'Something went wrong.')
      }
    })

  const openPay = (mode: PayMode) => {
    setPayMode(mode)
    setPayAmount(mode.amount.toFixed(2))
    setPayError(null)
    setReceiptFile(null)
    setBankReference('')
    setPaidOn(today())
    setWalletKey(newKey())
  }

  const submitReceipt = () => {
    if (!payMode) return
    if (!receiptFile) return setPayError('Upload your payment receipt.')
    setPayError(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.append('file', receiptFile)
      const up = await uploadReceiptAction(fd)
      if (!up.success || !('fileId' in up) || !up.fileId) {
        setPayError(up.error || 'Receipt upload failed.')
        return
      }
      const res =
        payMode.kind === 'fee'
          ? await submitLoanFeeReceiptAction(userId, {
              loanId: loan.id,
              paidOn,
              receiptFileId: up.fileId,
              bankReference,
            })
          : await submitLoanRepaymentAction(userId, {
              loanId: loan.id,
              amount: Number(payAmount),
              paidOn,
              receiptFileId: up.fileId,
              bankReference,
              instalmentId: payMode.kind === 'instalment' ? payMode.instalmentId : undefined,
              settle: payMode.kind === 'settle',
            })
      if (!res.success) {
        setPayError(res.error || 'Failed to submit the receipt.')
        return
      }
      toast.success('Receipt submitted. It will be applied once staff confirm the payment.')
      setPayMode(null)
      router.refresh()
    })
  }

  const payFromWallet = () => {
    if (!payMode) return
    setPayError(null)
    startTransition(async () => {
      const res =
        payMode.kind === 'fee'
          ? await payLoanFeeFromWalletAction(userId, loan.id)
          : await payLoanFromWalletAction(userId, {
              loanId: loan.id,
              amount: Number(payAmount),
              idempotencyKey: walletKey,
            })
      if (!res.success) {
        setPayError(res.error || 'Wallet payment failed.')
        return
      }
      toast.success('Paid from your wallet.')
      setPayMode(null)
      router.refresh()
    })
  }

  const isOffer = loan.status === 'APPROVED' || loan.status === 'AWAITING_RECONSENT'
  const offerOpen = isOffer && loan.offer?.decision === 'PENDING'
  const repayable = ['ACTIVE', 'OVERDUE', 'DEFAULTED'].includes(loan.status)

  return (
    <div className="max-w-5xl mx-auto space-y-6 p-4 md:p-6">
      <Link
        href={`/dashboard/${userId}/loans`}
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary"
      >
        <ArrowLeft className="w-4 h-4" /> Back to loans
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-primary">{formatNGN(loan.approvedAmount ?? loan.requestedAmount)} loan</h1>
          <p className="text-sm text-muted-foreground">
            {loan.purpose} · {loan.duration} month{loan.duration === 1 ? '' : 's'} · applied {formatDay(loan.createdAt)}
          </p>
        </div>
        <LoanStatusBadge status={loan.status} />
      </div>

      {(loan.status === 'OVERDUE' || loan.status === 'DEFAULTED') && (
        <div className="rounded-lg border border-error/30 bg-error/5 p-4 text-sm flex gap-3">
          <AlertTriangle className="w-5 h-5 text-error shrink-0" />
          <div>
            <p className="font-semibold text-error">
              {loan.status === 'DEFAULTED' ? 'This loan is in recovery.' : 'An instalment is past its grace period.'}
            </p>
            <p className="text-muted-foreground">
              Late penalties apply daily up to the loan’s cap. Pay the overdue amount to stop penalties. Recovery from
              savings or your guarantor only happens after a final notice and an admin decision.
            </p>
          </div>
        </div>
      )}

      {['REJECTED', 'DECLINED', 'CANCELLED', 'EXPIRED'].includes(loan.status) && loan.rejectionReason && (
        <Card>
          <CardContent className="pt-6 text-sm">
            <span className="text-muted-foreground">Reason: </span>
            {loan.rejectionReason}
          </CardContent>
        </Card>
      )}

      {/* Pending application */}
      {loan.status === 'PENDING' && (
        <Card>
          <CardContent className="pt-6 space-y-3 text-sm">
            <p>
              Your application is waiting for{' '}
              {loan.guarantee?.state === 'CONSENTED'
                ? 'an administrator’s review.'
                : `${loan.guarantee?.guarantorName ?? 'your guarantor'} to consent.`}
            </p>
            {loan.guarantee?.state === 'DECLINED' && (
              <p className="text-error">Your guarantor declined. Withdraw this application and apply with another guarantor.</p>
            )}
            {isOwner && (
              <Button
                variant="outline"
                disabled={isPending}
                onClick={() =>
                  run(() => cancelLoanApplicationAction(userId, loan.id), 'Application withdrawn.')
                }
              >
                Withdraw application
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Application fee */}
      {loan.fee && loan.fee.outstanding > 0 && (loan.status === 'PENDING') && (
        <Card>
          <CardContent className="pt-6 flex flex-wrap items-center justify-between gap-3 text-sm">
            <div>
              <p className="font-semibold">Application fee: {formatNGN(loan.fee.outstanding)}</p>
              <p className="text-muted-foreground text-xs">The loan cannot be approved until the fee is paid.</p>
            </div>
            {isOwner && (
              <Button onClick={() => openPay({ kind: 'fee', amount: loan.fee!.outstanding })}>Pay fee</Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Offer */}
      {isOffer && loan.offerQuote && (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">
                {loan.status === 'AWAITING_RECONSENT' ? 'Revised loan offer' : 'Your loan offer'}
              </h2>
              {loan.offerExpiresAt && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" /> Accept by {formatDay(loan.offerExpiresAt)}
                </span>
              )}
            </div>
            {loan.status === 'AWAITING_RECONSENT' && (
              <p className="text-sm text-muted-foreground">
                The administrator approved different terms from your application. You and your guarantor must both
                agree to these final figures. Guarantor:{' '}
                <strong>{loan.guarantee?.state === 'CONSENTED' ? 'agreed' : 'awaiting consent'}</strong>.
              </p>
            )}
            <LoanCostSummary quote={loan.offerQuote} />
            {offerOpen && isOwner ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={isPending}
                  onClick={() => run(() => acceptLoanOfferAction(userId, loan.id), 'Offer accepted.')}
                >
                  {isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}Accept offer
                </Button>
                <Button variant="outline" disabled={isPending} onClick={() => setDeclineOpen(true)}>
                  Decline
                </Button>
              </div>
            ) : (
              loan.offer?.decision === 'ACCEPTED' && (
                <p className="text-sm text-on-success flex items-center gap-1">
                  <FileCheck2 className="w-4 h-4" /> You accepted this offer. Waiting for your guarantor.
                </p>
              )
            )}
          </CardContent>
        </Card>
      )}

      {loan.status === 'ACCEPTED' && (
        <Card>
          <CardContent className="pt-6 text-sm">
            Offer accepted. The cooperative will transfer {formatNGN(loan.approvedAmount)} to your bank account; your
            repayment schedule starts from the transfer date.
          </CardContent>
        </Card>
      )}

      {/* Repayment */}
      {repayable && (
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardContent className="pt-6">
              <p className="text-xs text-muted-foreground">Next instalment</p>
              <p className="text-xl font-bold">{nextDue ? formatNGN(outstandingOf(nextDue)) : '—'}</p>
              <p className="text-xs text-muted-foreground">{nextDue ? `Due ${formatDay(nextDue.dueDate)}` : ''}</p>
              {nextDue && isOwner && (
                <Button
                  size="sm"
                  className="mt-3"
                  onClick={() => openPay({ kind: 'instalment', instalmentId: nextDue.id, amount: outstandingOf(nextDue) })}
                >
                  Pay instalment
                </Button>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-xs text-muted-foreground">Settle the whole loan today</p>
              <p className="text-xl font-bold">{formatNGN(loan.settlementQuote?.total)}</p>
              <p className="text-xs text-muted-foreground">
                Principal {formatNGN(loan.settlementQuote?.remainingPrincipal)} + interest{' '}
                {formatNGN(loan.settlementQuote?.remainingInterest)} + penalties{' '}
                {formatNGN(loan.settlementQuote?.unpaidPenalties)}. No interest rebate.
              </p>
              {isOwner && loan.settlementQuote && loan.settlementQuote.total > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => openPay({ kind: 'settle', amount: loan.settlementQuote!.total })}
                >
                  Settle early
                </Button>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-xs text-muted-foreground">Repaid so far</p>
              <p className="text-xl font-bold">{formatNGN(loan.totalRepaid)}</p>
              {loan.availableWallet !== null && (
                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                  <Wallet className="w-3.5 h-3.5" /> Wallet available: {formatNGN(loan.availableWallet)}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {loan.pendingSubmissions.length > 0 && (
        <Card>
          <CardContent className="pt-6 text-sm space-y-1">
            <p className="font-semibold">Payments under review</p>
            {loan.pendingSubmissions.map((s) => (
              <p key={s.id} className="text-muted-foreground">
                {s.submissionNumber}: {formatNGN(s.claimedAmount)} paid {formatDay(s.paidOn)}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      {instalments.length > 0 && (
        <Card>
          <CardContent className="pt-6 overflow-x-auto">
            <h2 className="font-semibold mb-3">Repayment schedule</h2>
            <table className="w-full text-sm min-w-[560px]">
              <thead className="text-xs text-muted-foreground text-left">
                <tr>
                  <th className="py-2">#</th>
                  <th>Due</th>
                  <th className="text-right">Principal</th>
                  <th className="text-right">Interest</th>
                  <th className="text-right">Penalty</th>
                  <th className="text-right">Outstanding</th>
                  <th className="text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {instalments.map((i) => (
                  <tr key={i.id}>
                    <td className="py-2">{i.instalmentNumber}</td>
                    <td>{formatDay(i.dueDate)}</td>
                    <td className="text-right">{formatNGN(i.principalDue)}</td>
                    <td className="text-right">{formatNGN(i.interestDue)}</td>
                    <td className="text-right">{formatNGN(i.penaltyAssessed - i.penaltyWaived)}</td>
                    <td className="text-right font-medium">{formatNGN(outstandingOf(i))}</td>
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

      {loan.payments.length > 0 && (
        <Card>
          <CardContent className="pt-6 text-sm space-y-2">
            <h2 className="font-semibold">What your payments covered</h2>
            {loan.payments.map((p) => (
              <div key={p.paymentId} className="flex flex-wrap justify-between gap-2 border-b border-border pb-2">
                <span>
                  {p.paymentNumber} · {formatDay(p.valueDate)} · {p.source === 'WALLET' ? 'wallet' : 'receipt'}
                </span>
                <span className="text-muted-foreground">
                  penalty {formatNGN(p.penalty)} · interest {formatNGN(p.interest)} · principal {formatNGN(p.principal)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Decline dialog */}
      <Dialog open={declineOpen} onOpenChange={setDeclineOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline the loan offer</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Declining ends this application and releases your guarantor’s commitment. This cannot be undone.
            </p>
            <Label htmlFor="declineReason">Reason</Label>
            <Textarea id="declineReason" value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} />
            <Button
              variant="destructive"
              disabled={isPending || !declineReason.trim()}
              onClick={() =>
                run(() => declineLoanOfferAction(userId, loan.id, declineReason), 'Offer declined.', () =>
                  setDeclineOpen(false),
                )
              }
            >
              Decline offer
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Pay dialog */}
      <Dialog open={!!payMode} onOpenChange={(o) => !o && setPayMode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {payMode?.kind === 'fee'
                ? 'Pay the application fee'
                : payMode?.kind === 'settle'
                  ? 'Settle the loan'
                  : 'Pay an instalment'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="space-y-1">
              <Label htmlFor="payAmount">Amount (₦)</Label>
              <Input
                id="payAmount"
                type="number"
                step="0.01"
                value={payAmount}
                disabled={payMode?.kind !== 'instalment'}
                onChange={(e) => setPayAmount(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Payments cover penalties first, then interest, then principal, oldest instalment first. Anything above
                what is owed goes to your wallet.
              </p>
            </div>

            {loan.availableWallet !== null && loan.availableWallet > 0 && (
              <div className="rounded-lg bg-surface-container p-3 space-y-2">
                <p>Wallet available: {formatNGN(loan.availableWallet)}</p>
                <Button
                  size="sm"
                  disabled={isPending || Number(payAmount) <= 0 || Number(payAmount) > loan.availableWallet}
                  onClick={payFromWallet}
                >
                  <Wallet className="w-4 h-4 mr-1" /> Pay {formatNGN(Number(payAmount))} from wallet
                </Button>
              </div>
            )}

            <div className="space-y-3 border-t border-border pt-3">
              <p className="font-medium">Or upload a bank transfer receipt</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="paidOn">Date paid</Label>
                  <Input id="paidOn" type="date" max={today()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="bankRef">Bank reference</Label>
                  <Input id="bankRef" value={bankReference} onChange={(e) => setBankReference(e.target.value)} />
                </div>
              </div>
              <ReceiptDropzone value={receiptFile} onFileSelected={setReceiptFile} />
              <Button disabled={isPending || !receiptFile} onClick={submitReceipt}>
                {isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}Submit receipt
              </Button>
            </div>
            {payError && <p className="text-xs text-error">{payError}</p>}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default LoanDetailsClient
