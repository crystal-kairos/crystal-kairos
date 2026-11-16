'use client'

import React, { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertCircle, ArrowLeft, Info, Loader2, PiggyBank } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { createSavingsPlanAction } from '@/models/savings/actions'
import type { SavingsProductView } from '@/models/savings/query'

interface NewSavingsClientProps {
  userId: string
  product: SavingsProductView
  firstDepositWindowDays: number
}

const naira = (v: number) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 2 }).format(v)

const FREQUENCIES = [
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'DAILY', label: 'Daily' },
] as const

/**
 * Subscribe to a plan and term. No approval step: the plan waits for the first deposit, whose
 * value date becomes the start date (D-08). The rate shown is fixed for this plan (D-09).
 */
export const NewSavingsClient = ({ userId, product, firstDepositWindowDays }: NewSavingsClientProps) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const terms = product.termRates
  const [durationMonths, setDurationMonths] = useState<number>(terms[0]?.durationMonths ?? 0)
  const [amount, setAmount] = useState<string>('')
  const [frequency, setFrequency] = useState<'MONTHLY' | 'WEEKLY' | 'DAILY'>('MONTHLY')
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({})

  const rate = terms.find((t) => t.durationMonths === durationMonths)?.ratePercent ?? 0
  const needsAmount = product.type === 'FIXED' || product.type === 'REGULAR'
  const amountNum = Number(amount)

  const example = useMemo(() => {
    if (!needsAmount || !(amountNum > 0)) return null
    if (product.type === 'FIXED') return { principal: amountNum, interest: (amountNum * rate) / 100 }
    if (frequency === 'MONTHLY') {
      // Period i is held (n − i + 1)/n of the term on average; shown as an estimate only.
      const n = durationMonths
      let interest = 0
      for (let i = 1; i <= n; i++) interest += (amountNum * rate) / 100 * ((n - i + 1) / n)
      return { principal: amountNum * n, interest }
    }
    return null
  }, [needsAmount, amountNum, product.type, rate, frequency, durationMonths])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setFieldErrors({})
    startTransition(async () => {
      const res = await createSavingsPlanAction(userId, {
        productId: product.id,
        durationMonths,
        targetAmount: needsAmount ? amount : null,
        frequency: product.type === 'REGULAR' ? frequency : null,
      })
      if (res.success && res.data) {
        router.push(`/dashboard/${userId}/savings/${(res.data as { id: string }).id}`)
        router.refresh()
      } else {
        setError(res.error ?? 'Could not create the plan.')
        setFieldErrors((res as { fieldErrors?: Record<string, string[]> }).fieldErrors ?? {})
      }
    })
  }

  if (terms.length === 0) {
    return (
      <div className='max-w-xl mx-auto py-10 text-center text-sm text-muted-foreground'>
        This plan has no terms available right now.
      </div>
    )
  }

  return (
    <div className='flex flex-col gap-6 w-full max-w-2xl mx-auto py-6 px-4 md:px-0'>
      <Link
        href={`/dashboard/${userId}/savings`}
        className='flex items-center gap-1.5 text-muted-foreground hover:text-primary text-xs font-semibold w-fit'
      >
        <ArrowLeft className='w-4 h-4' /> Back to Savings Hub
      </Link>

      <header className='flex items-start gap-3'>
        <div className='w-10 h-10 rounded-sm bg-primary/10 text-primary flex items-center justify-center shrink-0'>
          <PiggyBank className='w-5 h-5' />
        </div>
        <div>
          <h2 className='text-xl font-bold text-primary flex items-center gap-2 flex-wrap'>
            {product.title}
            {product.badge ? (
              <span className='px-2 py-0.5 rounded-full bg-light-blue text-primary text-[9px] font-bold uppercase tracking-wider'>
                {product.badge}
              </span>
            ) : null}
          </h2>
          <p className='text-sm text-muted-foreground mt-1'>{product.description}</p>
        </div>
      </header>

      <form onSubmit={submit} className='flex flex-col gap-5 bg-surface-container rounded-md p-5'>
        <fieldset className='flex flex-col gap-2'>
          <legend className='text-xs font-semibold text-muted-foreground mb-2'>Term</legend>
          <div className='grid grid-cols-2 sm:grid-cols-4 gap-2'>
            {terms.map((t) => (
              <button
                type='button'
                key={t.durationMonths}
                onClick={() => setDurationMonths(t.durationMonths)}
                aria-pressed={durationMonths === t.durationMonths}
                className={`rounded-sm border p-3 text-left transition-colors ${
                  durationMonths === t.durationMonths
                    ? 'border-primary bg-primary/10'
                    : 'border-outline-variant/30 hover:border-primary/50'
                }`}
              >
                <span className='block text-sm font-bold text-primary'>
                  {t.durationMonths} month{t.durationMonths === 1 ? '' : 's'}
                </span>
                <span className='block text-xs text-success-green font-semibold'>{t.ratePercent}% for the term</span>
              </button>
            ))}
          </div>
          {fieldErrors.durationMonths?.[0] ? (
            <p className='text-xs text-error'>{fieldErrors.durationMonths[0]}</p>
          ) : null}
        </fieldset>

        {product.type === 'REGULAR' ? (
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='frequency' className='text-xs font-semibold text-muted-foreground'>
              How often will you save?
            </Label>
            <select
              id='frequency'
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as typeof frequency)}
              className='h-10 rounded-sm border border-outline-variant/30 bg-background px-3 text-sm'
            >
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {needsAmount ? (
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='amount' className='text-xs font-semibold text-muted-foreground'>
              {product.type === 'FIXED' ? 'Target amount (₦)' : `Amount per ${frequency === 'MONTHLY' ? 'month' : frequency === 'WEEKLY' ? 'week' : 'day'} (₦)`}
            </Label>
            <Input
              id='amount'
              inputMode='decimal'
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder='e.g. 20000'
              aria-invalid={Boolean(fieldErrors.targetAmount)}
            />
            {fieldErrors.targetAmount?.[0] ? (
              <p className='text-xs text-error'>{fieldErrors.targetAmount[0]}</p>
            ) : null}
          </div>
        ) : null}

        {example ? (
          <div className='text-xs text-muted-foreground bg-background rounded-sm p-3'>
            Estimate if every deposit is on time: principal {naira(example.principal)}, interest about{' '}
            <span className='font-semibold text-success-green'>{naira(example.interest)}</span>. Interest is
            simple, earned per deposit from the day the money reaches us, and paid when you withdraw at maturity.
          </div>
        ) : null}

        <div className='flex items-start gap-2 text-xs text-muted-foreground'>
          <Info className='w-4 h-4 shrink-0 mt-0.5' />
          <p>
            Your plan starts on the date your first deposit reaches the cooperative&apos;s account. If no
            first deposit receipt is uploaded within {firstDepositWindowDays} days, the plan is cancelled automatically.
            Withdrawing before maturity returns your principal without interest.
          </p>
        </div>

        {error ? (
          <div role='alert' className='flex items-start gap-2 text-xs text-error'>
            <AlertCircle className='w-4 h-4 shrink-0 mt-0.5' />
            <span>{error}</span>
          </div>
        ) : null}

        <Button type='submit' disabled={isPending || !durationMonths} className='h-10'>
          {isPending ? <Loader2 className='w-4 h-4 animate-spin' /> : null}
          Subscribe at {rate}% for {durationMonths} month{durationMonths === 1 ? '' : 's'}
        </Button>
      </form>
    </div>
  )
}

export default NewSavingsClient
