'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertCircle, ArrowLeft, ArrowRight, Info } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { applyToEAjoGroupAction } from '@/models/eajo/actions'
import type { getEAjoGroupForJoin } from '@/models/eajo/query'

type JoinGroup = NonNullable<Awaited<ReturnType<typeof getEAjoGroupForJoin>>['data']>

const naira = (v: number) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(v)

const monthLabel = (iso: string | null, slot: number) =>
  iso
    ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-NG', { month: 'short', year: 'numeric', timeZone: 'UTC' })
    : `Month ${slot}`

/**
 * Join flow (P3-05): every slot shows its payout month, expected payout, early-slot penalty and
 * net payout. Several members may pick the same slot; each is paid in full, independently.
 */
export const NewAjoClient = ({ userId, group }: { userId: string; group: JoinGroup }) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [slot, setSlot] = useState<number | null>(null)
  const [guarantorEmail, setGuarantorEmail] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = slot !== null ? group.slots[slot - 1] : null

  const handleApply = () => {
    if (slot === null) return setError('Choose a slot.')
    if (!guarantorEmail.trim()) return setError('Enter your guarantor’s email address.')
    if (!acknowledged) return setError('Please confirm you have read the terms.')
    setError(null)
    startTransition(async () => {
      const res = await applyToEAjoGroupAction(userId, group.id, {
        payoutPosition: slot,
        guarantorEmail: guarantorEmail.trim(),
      })
      if (res.success) router.push(`/dashboard/${userId}/eajo`)
      else setError(res.error ?? 'Your application could not be submitted.')
    })
  }

  return (
    <div className="flex flex-col gap-6 w-full max-w-5xl mx-auto py-6">
      <Link href={`/dashboard/${userId}/eajo`} className="flex items-center gap-1.5 text-muted-foreground hover:text-primary text-xs font-semibold w-fit">
        <ArrowLeft className="w-4 h-4" /> Back to e-ajo
      </Link>

      <div className="bg-surface-container-lowest border border-outline-variant/10 rounded-xl p-6 flex flex-col gap-2">
        <span className="px-3 py-1 bg-light-blue text-primary rounded-full text-[10px] font-bold tracking-wider uppercase w-fit">
          Open for applications
        </span>
        <h1 className="text-2xl font-bold text-primary">{group.title}</h1>
        {group.description && <p className="text-sm text-muted-foreground max-w-xl">{group.description}</p>}
        <p className="text-xs text-muted-foreground">
          {naira(group.contributionAmount)} every month for {group.totalSlots} months · expected payout{' '}
          {naira(group.contributionAmount * group.totalSlots)}
          {group.startDate ? ` · planned start ${group.startDate}` : ''}
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className="flex-1 w-full flex flex-col gap-6">
          <section className="bg-surface-container-lowest rounded-xl p-6 border border-outline-variant/10">
            <h2 className="text-base font-bold text-primary mb-1">1. Choose your payout slot</h2>
            <p className="text-xs text-muted-foreground mb-4">
              Your slot is the month you receive your payout. An earlier slot means the cooperative advances you the months you have
              not yet paid, so a penalty on that advance is deducted.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {group.slots.map((s) => {
                const active = slot === s.slotNumber
                return (
                  <button
                    type="button"
                    key={s.slotNumber}
                    disabled={s.isFull}
                    onClick={() => setSlot(s.slotNumber)}
                    className={`text-left border rounded-lg p-3 min-h-[110px] flex flex-col justify-between transition-all
                      ${s.isFull ? 'opacity-60 cursor-not-allowed bg-surface-container-low border-outline-variant/10' : active ? 'ring-2 ring-primary bg-light-blue border-primary' : 'border-outline-variant/20 hover:border-primary bg-surface-container-lowest cursor-pointer'}`}
                  >
                    <div className="flex justify-between items-start">
                      <span className="text-lg font-bold font-mono text-primary">{String(s.slotNumber).padStart(2, '0')}</span>
                      <span className="text-[10px] text-muted-foreground">{s.isFull ? 'Full' : monthLabel(s.payoutMonth, s.slotNumber)}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] text-muted-foreground">Net payout</span>
                      <span className="font-mono font-bold text-primary text-sm">{naira(s.netPayout)}</span>
                    </div>
                  </button>
                )
              })}
            </div>

            {selected && (
              <div className="mt-5 bg-surface-container rounded-lg p-4 text-xs flex flex-col gap-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Expected payout ({group.totalSlots} × {naira(group.contributionAmount)})</span>
                  <span className="font-mono">{naira(selected.expectedPayout)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Amount advanced by the cooperative</span>
                  <span className="font-mono">{naira(selected.advanceAmount)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Early-slot penalty ({selected.earlySlotPenaltyPercent}% of the advance)</span>
                  <span className="font-mono text-error">−{naira(selected.earlySlotPenalty)}</span>
                </div>
                <div className="flex justify-between border-t border-dashed border-outline-variant/30 pt-2 font-bold text-sm">
                  <span className="text-primary">Your net payout</span>
                  <span className="font-mono text-success-green">{naira(selected.netPayout)}</span>
                </div>
                <p className="text-muted-foreground">
                  Payout month: {selected.payoutMonth ? monthLabel(selected.payoutMonth, selected.slotNumber) : `month ${selected.slotNumber} after the group starts`}.
                  You keep contributing every month until month {group.totalSlots}, including after your payout.
                </p>
              </div>
            )}
          </section>

          <section className="bg-surface-container-lowest rounded-xl p-6 border border-outline-variant/10 flex flex-col gap-3">
            <h2 className="text-base font-bold text-primary">2. Name your guarantor</h2>
            <p className="text-xs text-muted-foreground -mt-1">
              Your guarantor must be an active cooperative member with savings. They are asked to consent; the admin can approve your
              application only after they accept.
              {selected ? ` Their savings of ${naira(selected.advanceAmount)} will be reserved for this guarantee.` : ''}
            </p>
            <div className="flex flex-col gap-1.5 max-w-md">
              <Label htmlFor="guarantorEmail" className="text-xs font-semibold text-muted-foreground">Guarantor email</Label>
              <Input id="guarantorEmail" type="email" value={guarantorEmail} onChange={(e) => setGuarantorEmail(e.target.value)} placeholder="member@example.com" />
            </div>
          </section>

          {error && (
            <div className="bg-error-container/10 border border-error-container/30 text-error p-4 rounded-lg flex items-start gap-2 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{error}</span>
            </div>
          )}

          <section className="bg-surface-container-lowest rounded-xl p-6 border border-outline-variant/10 flex flex-col gap-4">
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="w-4 h-4 mt-0.5" />
              <span className="text-xs text-muted-foreground leading-snug">
                I will pay {naira(group.contributionAmount)} every month for {group.totalSlots} months. A contribution not paid within 7 days of its due
                date attracts a daily late penalty of {group.latePenaltyDailyPercent}% of the unpaid amount (capped at{' '}
                {group.penaltyCapType === 'FIXED_AMOUNT' ? naira(group.penaltyCapValue) : `${group.penaltyCapValue}% of my total contributions`}). My
                payout is approved once my contribution for the payout month is paid and nothing earlier is overdue.
              </span>
            </label>
            <Button onClick={handleApply} disabled={isPending || slot === null} className="w-full h-11 gap-1.5">
              {isPending ? 'Submitting…' : 'Submit application'} <ArrowRight className="w-4 h-4" />
            </Button>
          </section>
        </div>

        <aside className="w-full lg:w-[300px] shrink-0 bg-surface-container-lowest border border-outline-variant/10 rounded-xl p-5 flex flex-col gap-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2 text-primary font-bold uppercase text-sm"><Info className="w-4 h-4" /> How payouts work</div>
          <p>Your payout does not depend on what other members pay — the cooperative covers it.</p>
          <p>Several members may choose the same slot{group.maxMembersPerSlot ? ` (up to ${group.maxMembersPerSlot} per slot)` : ''}; each is paid separately.</p>
          <p>Other participants’ details are never shown to you.</p>
        </aside>
      </div>
    </div>
  )
}
