'use client'

import React, { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, CheckCircle, Info, Loader2, Search, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent } from '../ui/card'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'
import {
  applyForLoanAction,
  getLoanApplicationContextAction,
  getLoanQuoteAction,
} from '@/models/loans/actions'
import { formatNGN, LoanCostSummary } from './loanDisplay'
import type { SerializedLoanQuote } from '@/lib/loans'

interface Term {
  durationMonths: number
  monthlyInterestPercent: number
}

interface Eligibility {
  eligibleSavings: number
  standaloneLimit: number
  existingExposure: number
  maxWithoutExtraSupport: number
  maxWithGuarantor: number | null
  guarantorFreeCapacity: number | null
}

/**
 * Loan application (P3-04): amount, one of the admin-configured terms (1–12
 * months), purpose and a guarantor. The total cost is priced by the server and
 * shown before submission (§2.9). Eligibility is a ceiling; an admin still
 * decides every loan (D-07).
 */
export const NewLoanClient = ({ userId }: { userId: string }) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [isChecking, startChecking] = useTransition()

  const [terms, setTerms] = useState<Term[] | null>(null)
  const [eligibility, setEligibility] = useState<Eligibility | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [amount, setAmount] = useState('')
  const [duration, setDuration] = useState<number | null>(null)
  const [purpose, setPurpose] = useState('')
  const [guarantorEmail, setGuarantorEmail] = useState('')
  const [guarantor, setGuarantor] = useState<{ id: string; name: string } | null>(null)
  const [guarantorError, setGuarantorError] = useState<string | null>(null)

  const [quote, setQuote] = useState<SerializedLoanQuote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [agreed, setAgreed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadContext = (email?: string) =>
    getLoanApplicationContextAction(userId, email).then((res) => {
      if (!res.success || !res.data) {
        if (email) setGuarantorError(res.error ?? 'Guarantor not found.')
        else setLoadError(res.error ?? 'Unable to load loan options.')
        return
      }
      setTerms(res.data.terms)
      setEligibility(res.data.eligibility)
      if (email) {
        if (res.data.guarantor) {
          setGuarantor(res.data.guarantor)
          setGuarantorError(null)
        } else {
          setGuarantor(null)
          setGuarantorError('No active cooperative member found with this email.')
        }
      }
      setDuration((d) => d ?? res.data!.terms[0]?.durationMonths ?? null)
    })

  useEffect(() => {
    loadContext()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  // Server-priced total-cost disclosure
  useEffect(() => {
    const value = Number(amount)
    setAgreed(false)
    if (!duration || !value || value <= 0) {
      setQuote(null)
      return
    }
    const handle = setTimeout(() => {
      getLoanQuoteAction(userId, { requestedAmount: value, duration }).then((res) => {
        if (res.success && res.data) {
          setQuote(res.data)
          setQuoteError(null)
        } else {
          setQuote(null)
          setQuoteError(res.error ?? 'Unable to price this loan.')
        }
      })
    }, 350)
    return () => clearTimeout(handle)
  }, [amount, duration, userId])

  const verifyGuarantor = () => {
    if (!guarantorEmail.trim()) return
    startChecking(async () => {
      await loadContext(guarantorEmail.trim())
    })
  }

  const ceiling = guarantor && eligibility?.maxWithGuarantor !== null ? eligibility?.maxWithGuarantor : null
  const value = Number(amount)
  const overCeiling = ceiling !== null && ceiling !== undefined && value > ceiling

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!guarantor) return setError('Verify your guarantor first.')
    if (!quote || !duration) return setError('Enter an amount and choose a term.')
    if (!agreed) return setError('Please confirm you have read the cost and penalty terms.')
    startTransition(async () => {
      const res = await applyForLoanAction(userId, {
        requestedAmount: value,
        duration,
        purpose,
        guarantorEmail: guarantorEmail.trim(),
      })
      if (!res.success || !res.data) {
        setError(res.error ?? 'Failed to apply for the loan.')
        return
      }
      toast.success('Application submitted. Your guarantor has been asked to consent.')
      router.push(`/dashboard/${userId}/loans/${res.data.id}`)
    })
  }

  if (loadError) {
    return <div className="p-6 text-error text-sm">{loadError}</div>
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 p-4 md:p-6">
      <Link
        href={`/dashboard/${userId}/loans`}
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary"
      >
        <ArrowLeft className="w-4 h-4" /> Back to loans
      </Link>
      <div>
        <h1 className="text-2xl font-bold text-primary">Apply for a loan</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every loan is reviewed by an administrator, who may approve a smaller amount, a different term, or
          decline it. Your guarantor must consent before approval.
        </p>
      </div>

      <form onSubmit={submit} className="grid gap-6 md:grid-cols-5">
        <Card className="md:col-span-3">
          <CardContent className="space-y-5 pt-6">
            {eligibility && (
              <div className="rounded-lg bg-surface-container p-3 text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Eligible savings</span>
                  <span className="font-medium">{formatNGN(eligibility.eligibleSavings)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Your limit (2 × savings)</span>
                  <span className="font-medium">{formatNGN(eligibility.standaloneLimit)}</span>
                </div>
                {eligibility.existingExposure > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Already borrowed (principal)</span>
                    <span className="font-medium">{formatNGN(eligibility.existingExposure)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {guarantor ? `Maximum with ${guarantor.name}` : 'Maximum before guarantor support'}
                  </span>
                  <span className="font-semibold text-primary">
                    {formatNGN(guarantor ? eligibility.maxWithGuarantor : eligibility.maxWithoutExtraSupport)}
                  </span>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="guarantorEmail">Guarantor’s email</Label>
              <div className="flex gap-2">
                <Input
                  id="guarantorEmail"
                  type="email"
                  value={guarantorEmail}
                  onChange={(e) => {
                    setGuarantorEmail(e.target.value)
                    setGuarantor(null)
                  }}
                  placeholder="member@example.com"
                />
                <Button type="button" variant="outline" onClick={verifyGuarantor} disabled={isChecking}>
                  {isChecking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  <span className="ml-1">Verify</span>
                </Button>
              </div>
              {guarantor && (
                <p className="text-xs text-on-success flex items-center gap-1">
                  <CheckCircle className="w-3.5 h-3.5" /> {guarantor.name} will be asked to consent.
                </p>
              )}
              {guarantorError && <p className="text-xs text-error">{guarantorError}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="amount">Amount (₦)</Label>
              <Input
                id="amount"
                type="number"
                min={1}
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {overCeiling && (
                <p className="text-xs text-error">
                  This is above your current maximum of {formatNGN(ceiling)}.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Term</Label>
              {terms === null ? (
                <p className="text-xs text-muted-foreground">Loading terms…</p>
              ) : terms.length === 0 ? (
                <p className="text-xs text-error">No loan terms are offered at the moment.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {terms.map((t) => (
                    <button
                      type="button"
                      key={t.durationMonths}
                      onClick={() => setDuration(t.durationMonths)}
                      className={`rounded-lg border px-3 py-2 text-xs text-left ${
                        duration === t.durationMonths
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border hover:border-primary/50'
                      }`}
                    >
                      <span className="block font-semibold">
                        {t.durationMonths} month{t.durationMonths === 1 ? '' : 's'}
                      </span>
                      <span className="text-muted-foreground">{t.monthlyInterestPercent}% / month</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="purpose">Purpose</Label>
              <Textarea
                id="purpose"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                maxLength={500}
                placeholder="What is the loan for?"
              />
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-2 h-fit">
          <CardContent className="space-y-4 pt-6">
            <h2 className="font-semibold flex items-center gap-2">
              <Info className="w-4 h-4 text-primary" /> Cost of this loan
            </h2>
            {quote ? (
              <LoanCostSummary quote={quote} />
            ) : (
              <p className="text-xs text-muted-foreground">{quoteError ?? 'Enter an amount and choose a term.'}</p>
            )}
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={agreed}
                disabled={!quote}
                onChange={(e) => setAgreed(e.target.checked)}
              />
              I have read the total cost, the penalty terms and cap, and the recovery and guarantee consequences.
            </label>
            {error && <p className="text-xs text-error">{error}</p>}
            <Button
              type="submit"
              className="w-full"
              disabled={isPending || !quote || !guarantor || !agreed || overCeiling || purpose.trim().length < 3}
            >
              {isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
              Submit application
            </Button>
          </CardContent>
        </Card>
      </form>
    </div>
  )
}
