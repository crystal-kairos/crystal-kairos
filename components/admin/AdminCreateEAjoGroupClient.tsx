'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Loader2, Info, Percent } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PenaltyCapType } from '@/generated/prisma/enums'
import { createEAjoGroupAction, CreateEAjoSlotPolicyInput } from '@/models/admin/actions'
import { calculateEAjoPayout } from '@/lib/domain/eajo-payout'

const DURATIONS = [
  { value: 'FOUR_MONTHS', label: '4 Months (4 slots)', slots: 4 },
  { value: 'SIX_MONTHS', label: '6 Months (6 slots)', slots: 6 },
  { value: 'TWELVE_MONTHS', label: '12 Months (12 slots)', slots: 12 },
]

export const AdminCreateEAjoGroupClient = () => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState({
    title: '',
    description: '',
    contributionAmount: '',
    frequency: 'MONTHLY',
    duration: 'SIX_MONTHS',
    startDate: '',
    latePenaltyDailyPercent: '0.5',
    penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL as PenaltyCapType,
    penaltyCapValue: '10',
    maxMembersPerSlot: '',
  })

  const selectedDuration = DURATIONS.find((d) => d.value === form.duration) ?? DURATIONS[1]
  const totalSlots = selectedDuration.slots

  // Slot policies map: slotNumber (1..totalSlots) -> penaltyPercent string
  const [slotPenalties, setSlotPenalties] = useState<Record<number, string>>(() => {
    const map: Record<number, string> = {}
    for (let s = 1; s <= 12; s++) {
      // Default initial penalty values (e.g. 10% for slot 1, decreasing to 0%)
      map[s] = s === 12 ? '0' : s === 1 ? '15' : s === 2 ? '10' : '5'
    }
    return map
  })

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 0 }).format(val)

  const contributionNum = parseFloat(form.contributionAmount) || 0
  const expectedPayoutTotal = contributionNum * totalSlots

  const handlePenaltyChange = (slot: number, val: string) => {
    setSlotPenalties((prev) => ({
      ...prev,
      [slot]: val,
    }))
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!form.title.trim()) return setError('Group title is required.')
    if (contributionNum <= 0) {
      return setError('Please enter a valid contribution amount greater than 0.')
    }

    const capVal = parseFloat(form.penaltyCapValue)
    if (isNaN(capVal) || capVal <= 0) {
      return setError('Penalty cap value must be strictly greater than 0 (D-05).')
    }

    // Build slot policies for all slots 1..totalSlots
    const slotPolicies: CreateEAjoSlotPolicyInput[] = []
    for (let s = 1; s <= totalSlots; s++) {
      const penaltyStr = slotPenalties[s] ?? '0'
      const penaltyNum = parseFloat(penaltyStr)
      if (isNaN(penaltyNum) || penaltyNum < 0) {
        return setError(`Please enter a valid non-negative early slot penalty for slot ${s}.`)
      }
      slotPolicies.push({
        slotNumber: s,
        earlySlotPenaltyPercent: penaltyNum,
      })
    }

    startTransition(async () => {
      const result = await createEAjoGroupAction({
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        contributionAmount: contributionNum,
        frequency: 'MONTHLY' as any, // Fixed to MONTHLY (A-09)
        duration: form.duration as any,
        startDate: form.startDate || undefined,
        latePenaltyDailyPercent: parseFloat(form.latePenaltyDailyPercent) || 0.5,
        penaltyCapType: form.penaltyCapType,
        penaltyCapValue: capVal,
        maxMembersPerSlot: form.maxMembersPerSlot ? parseInt(form.maxMembersPerSlot, 10) : undefined,
        slotPolicies,
      })

      if (result.success) {
        router.push('/admin/eajo')
      } else {
        setError(result.error ?? 'Something went wrong. Please try again.')
      }
    })
  }

  return (
    <div className="max-w-4xl mx-auto py-8 flex flex-col gap-6">
      {/* Back */}
      <div className="flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors w-fit text-xs font-semibold cursor-pointer">
        <ArrowLeft className="w-4 h-4" />
        <Link href="/admin/eajo">Back to Groups</Link>
      </div>

      <div>
        <h2 className="text-2xl font-bold font-heading text-primary">Create eAjo Group</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Define the group parameters, slot policies, and late penalty terms (§2.3, §2.8, A-09).
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        {/* Basic Details */}
        <div className="bg-surface-container rounded-xl p-6 flex flex-col gap-5">
          <h3 className="text-xs font-bold text-primary uppercase tracking-widest">Group Details</h3>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="title" className="text-xs font-semibold text-primary">
              Group Title <span className="text-error">*</span>
            </Label>
            <Input
              id="title"
              placeholder="e.g. 6-Month Business Expansion Fund"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="h-10 text-sm rounded-lg border-outline-variant/40"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="description" className="text-xs font-semibold text-primary">
              Description <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Textarea
              id="description"
              placeholder="A brief description to help members understand the purpose of this group..."
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="text-sm rounded-lg border-outline-variant/40 resize-none min-h-[80px]"
            />
          </div>
        </div>

        {/* Financial & Schedule Parameters */}
        <div className="bg-surface-container rounded-xl p-6 flex flex-col gap-5">
          <h3 className="text-xs font-bold text-primary uppercase tracking-widest">Contribution & Late Penalties</h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="amount" className="text-xs font-semibold text-primary">
                Monthly Contribution (₦) <span className="text-error">*</span>
              </Label>
              <Input
                id="amount"
                type="number"
                min={1}
                placeholder="e.g. 10000"
                value={form.contributionAmount}
                onChange={(e) => setForm({ ...form, contributionAmount: e.target.value })}
                className="h-10 text-sm rounded-lg border-outline-variant/40 font-mono"
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-semibold text-primary">Contribution Frequency</Label>
              <div className="h-10 px-3 flex items-center bg-muted/40 rounded-lg text-sm text-muted-foreground border border-outline-variant/30 font-medium">
                Monthly (Fixed §A-09)
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-semibold text-primary">Duration & Slots</Label>
              <Select value={form.duration} onValueChange={(v) => setForm({ ...form, duration: v })}>
                <SelectTrigger className="h-10 text-sm rounded-lg border-outline-variant/40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATIONS.map((d) => (
                    <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="startDate" className="text-xs font-semibold text-primary">
                Planned Start Date <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="startDate"
                type="date"
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                className="h-10 text-sm rounded-lg border-outline-variant/40"
              />
            </div>

            {/* Daily late penalty % */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="latePenalty" className="text-xs font-semibold text-primary">
                Daily Late Penalty % (§2.3)
              </Label>
              <div className="relative">
                <Input
                  id="latePenalty"
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.latePenaltyDailyPercent}
                  onChange={(e) => setForm({ ...form, latePenaltyDailyPercent: e.target.value })}
                  className="h-10 text-sm rounded-lg border-outline-variant/40 font-mono pr-8"
                  required
                />
                <div className="absolute inset-y-0 right-0 flex items-center pr-2.5 pointer-events-none text-muted-foreground">
                  <Percent className="w-3.5 h-3.5" />
                </div>
              </div>
            </div>

            {/* Penalty Cap Type & Value */}
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-semibold text-primary">
                Mandatory Late Penalty Cap (D-05)
              </Label>
              <div className="flex gap-2">
                <Select
                  value={form.penaltyCapType}
                  onValueChange={(v) => setForm({ ...form, penaltyCapType: v as PenaltyCapType })}
                >
                  <SelectTrigger className="h-10 text-xs rounded-lg border-outline-variant/40 flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={PenaltyCapType.PERCENT_OF_PRINCIPAL}>% of Outstanding</SelectItem>
                    <SelectItem value={PenaltyCapType.FIXED_AMOUNT}>Fixed ₦</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={form.penaltyCapValue}
                  onChange={(e) => setForm({ ...form, penaltyCapValue: e.target.value })}
                  className="h-10 text-sm rounded-lg border-outline-variant/40 font-mono w-24"
                  placeholder="Cap"
                  required
                />
              </div>
            </div>
          </div>
        </div>

        {/* Slot Policies & Payout Preview Table (§2.8, Appendix C4) */}
        <div className="bg-surface-container rounded-xl p-6 flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-bold text-primary uppercase tracking-widest">
              Slot Policies & Payout Preview (All {totalSlots} Slots Mandatory)
            </h3>
            <p className="text-xs text-muted-foreground">
              Define the early-slot penalty percentage for every slot position (§2.8, D-03).
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border border-outline-variant/20 rounded-lg overflow-hidden">
              <thead className="bg-muted/40 font-semibold text-primary">
                <tr>
                  <th className="p-3">Slot #</th>
                  <th className="p-3">Expected Payout</th>
                  <th className="p-3">Coop Advance</th>
                  <th className="p-3">Early Penalty %</th>
                  <th className="p-3">Penalty Amount</th>
                  <th className="p-3">Net Payout</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/10">
                {Array.from({ length: totalSlots }, (_, i) => i + 1).map((slot) => {
                  const penaltyPct = parseFloat(slotPenalties[slot] || '0') || 0
                  let calc = null
                  if (contributionNum > 0) {
                    try {
                      calc = calculateEAjoPayout({
                        monthlyContribution: contributionNum,
                        totalSlots,
                        slotNumber: slot,
                        earlySlotPenaltyPercent: penaltyPct,
                      })
                    } catch {}
                  }

                  return (
                    <tr key={slot} className="hover:bg-muted/20">
                      <td className="p-3 font-bold font-mono">Month {slot}</td>
                      <td className="p-3 font-mono">{calc ? formatCurrency(calc.expectedPayout.toNumber()) : '-'}</td>
                      <td className="p-3 font-mono text-muted-foreground">
                        {calc ? formatCurrency(calc.advanceAmount.toNumber()) : '-'}
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-1 max-w-[100px]">
                          <Input
                            type="number"
                            min="0"
                            max="100"
                            step="0.1"
                            value={slotPenalties[slot] ?? '0'}
                            onChange={(e) => handlePenaltyChange(slot, e.target.value)}
                            className="h-8 text-xs font-mono text-center"
                            required
                          />
                          <span className="text-muted-foreground font-semibold">%</span>
                        </div>
                      </td>
                      <td className="p-3 font-mono text-error">
                        {calc ? formatCurrency(calc.earlySlotPenalty.toNumber()) : '-'}
                      </td>
                      <td className="p-3 font-mono font-bold text-primary">
                        {calc ? formatCurrency(calc.netPayout.toNumber()) : '-'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {contributionNum > 0 && (
            <div className="bg-primary/5 border border-primary/15 rounded-lg p-4 flex items-start gap-3">
              <Info className="w-4 h-4 text-primary mt-0.5 shrink-0" />
              <div className="text-xs text-primary leading-relaxed">
                <p className="font-bold mb-1">Cooperative Advance Rule (§2.8)</p>
                <p>
                  Expected payout is <strong>{formatCurrency(expectedPayoutTotal)}</strong>. Early slot penalty applies solely to the advance exposure portion: <code>c × (N − s)</code>. The final slot carries zero advance exposure and zero early slot penalty.
                </p>
              </div>
            </div>
          )}
        </div>

        {error && (
          <p className="text-sm text-error bg-error/5 border border-error/20 rounded-lg px-4 py-3">
            {error}
          </p>
        )}

        <div className="flex gap-3 justify-end">
          <Button type="button" variant="outline" asChild className="h-10 px-6 text-sm rounded-lg cursor-pointer">
            <Link href="/admin/eajo">Cancel</Link>
          </Button>
          <Button
            type="submit"
            disabled={isPending}
            className="bg-primary text-on-primary hover:bg-primary/90 h-10 px-8 text-sm font-bold rounded-lg cursor-pointer"
          >
            {isPending ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating...</>
            ) : (
              'Create Group & Slot Policies'
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}
