'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { submitEAjoContributionAction, uploadReceiptAction } from '@/models/eajo/actions'

export interface UploadPeriod {
  id: string
  periodNumber: number
  dueDate: string
  totalOutstanding: number
  penaltyOutstanding: number
  inReview: boolean
}

interface UploadAjoReceiptDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  userId: string
  eAjoMemberId: string
  groupTitle: string
  periods: UploadPeriod[]
  today: string
}

const naira = (v: number) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 2 }).format(v)

/**
 * Member uploads a receipt for one or more of their contribution months (P2-07 submission).
 * Nothing is credited until staff confirm the money arrived; the confirmed amount pays the
 * selected months oldest first, penalty before contribution, and any excess goes to the wallet.
 */
export const UploadAjoReceiptDialog = ({
  open,
  onOpenChange,
  userId,
  eAjoMemberId,
  groupTitle,
  periods,
  today,
}: UploadAjoReceiptDialogProps) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const payable = useMemo(() => periods.filter((p) => p.totalOutstanding > 0 && !p.inReview), [periods])
  // The dialog is mounted fresh for each participation, so state starts from the oldest open month
  const [selected, setSelected] = useState<string[]>(() => (payable[0] ? [payable[0].id] : []))
  const [amount, setAmount] = useState(() => (payable[0] ? String(payable[0].totalOutstanding) : ''))
  const [paidOn, setPaidOn] = useState(today)
  const [reference, setReference] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
    setSelected(next)
    setAmount(String(payable.filter((p) => next.includes(p.id)).reduce((s, p) => s + p.totalOutstanding, 0)))
  }

  const submit = () => {
    const value = Number(amount)
    if (selected.length === 0) return setError('Select at least one month.')
    if (!(value > 0)) return setError('Enter the amount you paid.')
    if (!file) return setError('Attach your payment receipt.')
    setError(null)
    startTransition(async () => {
      const fd = new FormData()
      fd.append('file', file)
      const up = await uploadReceiptAction(fd)
      if (!up.success || !('fileId' in up) || !up.fileId) {
        setError(up.error ?? 'The receipt could not be uploaded.')
        return
      }
      const res = await submitEAjoContributionAction(userId, eAjoMemberId, {
        amount: value,
        paidOn,
        receiptFileId: up.fileId,
        periodIds: selected,
        bankReference: reference || undefined,
      })
      if (!res.success) {
        setError(res.error ?? 'Your receipt could not be submitted.')
        return
      }
      setDone(`Receipt ${res.data?.submissionNumber ?? ''} submitted. It shows as “payment under review” until an administrator confirms it.`)
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !isPending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload contribution receipt</DialogTitle>
          <DialogDescription>{groupTitle}</DialogDescription>
        </DialogHeader>

        {done ? (
          <p className="text-sm text-primary">{done}</p>
        ) : payable.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is outstanding right now, or your receipts are already under review.</p>
        ) : (
          <div className="flex flex-col gap-3 text-xs">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Months this payment covers</Label>
              <div className="max-h-44 overflow-y-auto flex flex-col gap-1 border border-outline-variant/20 rounded p-2">
                {payable.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggle(p.id)} />
                    <span>
                      Month {p.periodNumber} · due {p.dueDate} · {naira(p.totalOutstanding)}
                      {p.penaltyOutstanding > 0 && <span className="text-error"> (incl. penalty {naira(p.penaltyOutstanding)})</span>}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="ajo-amount" className="text-xs">Amount paid (₦)</Label>
                <Input id="ajo-amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="ajo-paidon" className="text-xs">Date you paid</Label>
                <Input id="ajo-paidon" type="date" max={today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ajo-ref" className="text-xs">Bank reference (optional)</Label>
              <Input id="ajo-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ajo-file" className="text-xs">Receipt (image or PDF, max 5 MB)</Label>
              <Input id="ajo-file" type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
            <p className="text-muted-foreground">
              Any amount above the selected months goes to your wallet. Penalties are paid before the contribution.
            </p>
            {error && (
              <div className="bg-error-container/10 border border-error-container/30 text-error p-2 rounded flex gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" /> {error}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={isPending} onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {!done && payable.length > 0 && (
            <Button disabled={isPending} onClick={submit}>
              {isPending && <Loader2 className="w-4 h-4 animate-spin mr-1" />} Submit receipt
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default UploadAjoReceiptDialog
