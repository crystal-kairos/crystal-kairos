'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { createSavingsProductAction, updateSavingsProductAction } from '@/models/admin/savingsActions'

const ICONS = ['PiggyBank', 'Lock', 'RefreshCw', 'ShieldCheck', 'Wallet', 'Coins', 'TrendingUp']
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)
type PlanType = 'FIXED' | 'REGULAR' | 'STAGGERED'

export interface SavingsProductFormValue {
  id?: string
  type: PlanType
  title: string
  description: string
  badge: string | null
  icon: string
  /** Currently active term rates. */
  termRates: { durationMonths: number; ratePercent: number }[]
}

/**
 * Create or edit a savings plan: title, type, optional badge, and a total-term simple interest
 * rate for each offered term (1–12 months). A rate change applies only to new subscriptions and
 * is added to the policy-update draft (D-09, P4-07).
 */
export function SavingsProductForm({ initial }: { initial?: SavingsProductFormValue }) {
  const router = useRouter()
  const isEdit = Boolean(initial?.id)
  const [isPending, startTransition] = useTransition()
  const [type, setType] = useState<PlanType>(initial?.type ?? 'REGULAR')
  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [badge, setBadge] = useState(initial?.badge ?? '')
  const [icon, setIcon] = useState(initial?.icon ?? 'PiggyBank')
  const [rates, setRates] = useState<Record<number, { enabled: boolean; rate: string }>>(() => {
    const map: Record<number, { enabled: boolean; rate: string }> = {}
    for (const m of MONTHS) {
      const found = initial?.termRates.find((t) => t.durationMonths === m)
      map[m] = { enabled: Boolean(found), rate: found ? String(found.ratePercent) : '' }
    }
    return map
  })
  const [errors, setErrors] = useState<Record<string, string[]>>({})

  const setRate = (m: number, patch: Partial<{ enabled: boolean; rate: string }>) =>
    setRates((cur) => ({ ...cur, [m]: { ...cur[m], ...patch } }))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})
    const termRates = MONTHS.flatMap((m) => {
      const r = rates[m]
      const wasOffered = initial?.termRates.some((t) => t.durationMonths === m)
      if (r.enabled) return [{ durationMonths: m, ratePercent: Number(r.rate || 0), isActive: true }]
      // Turning a term off creates an inactive version; untouched unoffered terms are omitted.
      if (wasOffered) return [{ durationMonths: m, ratePercent: Number(r.rate || 0), isActive: false }]
      return []
    })
    if (!termRates.some((t) => t.isActive)) {
      setErrors({ termRates: ['Offer at least one term.'] })
      return
    }
    startTransition(async () => {
      const res = isEdit
        ? await updateSavingsProductAction(initial!.id!, { title, description, badge: badge || null, icon, termRates })
        : await createSavingsProductAction({ type, title, description, badge: badge || null, icon, termRates })
      if (res.success) {
        toast.success(isEdit ? 'Savings plan updated' : 'Savings plan created')
        router.push('/admin/savings')
        router.refresh()
      } else {
        toast.error(res.error ?? 'Could not save the plan')
        setErrors((res as { fieldErrors?: Record<string, string[]> }).fieldErrors ?? {})
      }
    })
  }

  const err = (k: string) => (errors[k]?.[0] ? <p className='text-xs text-error'>{errors[k][0]}</p> : null)

  return (
    <div className='flex flex-col gap-6 w-full max-w-2xl mx-auto'>
      <Link href='/admin/savings' className='flex items-center gap-1.5 text-muted-foreground hover:text-primary text-sm font-semibold w-fit'>
        <ArrowLeft className='w-4 h-4' /> Back to Savings Management
      </Link>
      <header>
        <h2 className='text-2xl font-bold text-primary'>{isEdit ? 'Edit savings plan' : 'Create savings plan'}</h2>
        <p className='text-muted-foreground text-sm mt-1'>
          Members subscribe without approval. Each subscription keeps the rate it was created with.
        </p>
      </header>
      <Card className='border border-outline-variant/30 shadow-none rounded-xl p-6'>
        <form onSubmit={submit} className='flex flex-col gap-5'>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='sp-type'>Type</Label>
            <select
              id='sp-type'
              value={type}
              disabled={isEdit}
              onChange={(e) => setType(e.target.value as PlanType)}
              className='h-10 rounded-sm border border-outline-variant/30 bg-background px-3 text-sm'
            >
              <option value='REGULAR'>Regular (scheduled deposits)</option>
              <option value='FIXED'>Fixed (one target amount)</option>
              <option value='STAGGERED'>Staggered (any amount, any time)</option>
            </select>
            {isEdit ? <p className='text-xs text-muted-foreground'>The type cannot change after creation.</p> : null}
          </div>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='sp-title'>Title</Label>
            <Input id='sp-title' value={title} onChange={(e) => setTitle(e.target.value)} />
            {err('title')}
          </div>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='sp-desc'>Description</Label>
            <Textarea id='sp-desc' value={description} onChange={(e) => setDescription(e.target.value)} />
            {err('description')}
          </div>
          <div className='grid grid-cols-1 sm:grid-cols-2 gap-4'>
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor='sp-badge'>Badge (optional)</Label>
              <Input id='sp-badge' value={badge} onChange={(e) => setBadge(e.target.value)} placeholder='e.g. High yield' />
            </div>
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor='sp-icon'>Icon</Label>
              <select
                id='sp-icon'
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                className='h-10 rounded-sm border border-outline-variant/30 bg-background px-3 text-sm'
              >
                {ICONS.map((i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <fieldset className='flex flex-col gap-2'>
            <legend className='text-sm font-semibold mb-1'>Terms and rates</legend>
            <p className='text-xs text-muted-foreground'>
              Tick each term the plan offers and enter the simple interest percentage for the whole term.
            </p>
            <div className='grid grid-cols-2 sm:grid-cols-3 gap-2'>
              {MONTHS.map((m) => (
                <div key={m} className='flex items-center gap-2 rounded-sm border border-outline-variant/20 p-2'>
                  <input
                    type='checkbox'
                    id={`term-${m}`}
                    checked={rates[m].enabled}
                    onChange={(e) => setRate(m, { enabled: e.target.checked })}
                  />
                  <label htmlFor={`term-${m}`} className='text-xs w-14 shrink-0'>
                    {m} mo
                  </label>
                  <Input
                    aria-label={`Rate for ${m} months`}
                    inputMode='decimal'
                    className='h-8 text-xs'
                    placeholder='%'
                    disabled={!rates[m].enabled}
                    value={rates[m].rate}
                    onChange={(e) => setRate(m, { rate: e.target.value })}
                  />
                </div>
              ))}
            </div>
            {err('termRates')}
          </fieldset>
          <Button type='submit' disabled={isPending} className='h-10'>
            {isPending ? <Loader2 className='w-4 h-4 animate-spin' /> : <Save className='w-4 h-4' />}
            {isEdit ? 'Save changes' : 'Create plan'}
          </Button>
        </form>
      </Card>
    </div>
  )
}
