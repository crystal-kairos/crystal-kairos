'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ArrowLeft,
  Loader2,
  Save,
  Percent,
  AlertCircle,
  Clock,
  ShieldAlert,
  Info,
} from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { PenaltyCapType } from '@/generated/prisma/enums'
import {
  saveLoanTermRateAction,
  LoanTermRateDto,
} from '@/models/admin/loanSettingsActions'

interface AdminLoanSettingsClientProps {
  initialRates: LoanTermRateDto[]
  openDraft?: {
    id: string
    title: string
    changesCount: number
  } | null
}

export const AdminLoanSettingsClient = ({
  initialRates,
  openDraft,
}: AdminLoanSettingsClientProps) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [selectedDuration, setSelectedDuration] = useState<number>(
    initialRates.length > 0 ? initialRates[0].durationMonths : 1
  )

  // Rate table state indexed by durationMonths 1..12
  const initialMap: Record<number, LoanTermRateDto> = {}
  for (let m = 1; m <= 12; m++) {
    const existing = initialRates.find((r) => r.durationMonths === m)
    initialMap[m] = existing ?? {
      durationMonths: m,
      monthlyInterestPercent: 5.0,
      latePenaltyDailyPercent: 0.5,
      penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
      penaltyCapValue: 10.0,
      version: 1,
      effectiveFrom: new Date().toISOString().split('T')[0],
      effectiveTo: null,
    }
  }

  const [ratesMap, setRatesMap] = useState<Record<number, LoanTermRateDto>>(initialMap)
  const currentRate = ratesMap[selectedDuration]

  const handleFieldChange = (field: keyof LoanTermRateDto, value: any) => {
    setRatesMap((prev) => ({
      ...prev,
      [selectedDuration]: {
        ...prev[selectedDuration],
        [field]: value,
      },
    }))
  }

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()

    if (currentRate.monthlyInterestPercent < 0) {
      toast.error('Monthly interest rate must be 0 or greater.')
      return
    }
    if (currentRate.latePenaltyDailyPercent < 0) {
      toast.error('Daily late penalty must be 0 or greater.')
      return
    }
    if (currentRate.penaltyCapValue <= 0) {
      toast.error('Penalty cap must be strictly greater than 0.')
      return
    }

    startTransition(async () => {
      const res = await saveLoanTermRateAction({
        durationMonths: selectedDuration,
        monthlyInterestPercent: Number(currentRate.monthlyInterestPercent),
        latePenaltyDailyPercent: Number(currentRate.latePenaltyDailyPercent),
        penaltyCapType: currentRate.penaltyCapType,
        penaltyCapValue: Number(currentRate.penaltyCapValue),
        effectiveFrom: currentRate.effectiveFrom,
      })

      if (res.success) {
        toast.success(`Loan terms for ${selectedDuration} month(s) updated successfully!`)
        router.refresh()
      } else {
        toast.error(res.error || 'Failed to update loan terms.')
      }
    })
  }

  return (
    <div className="flex flex-col gap-6 w-full max-w-4xl mx-auto py-6">
      <div className="flex items-center gap-1.5 text-muted-foreground hover:text-primary cursor-pointer transition-colors w-fit text-sm font-semibold">
        <ArrowLeft className="w-4 h-4" />
        <Link href="/admin/loans">Back to Loan Management</Link>
      </div>

      <header className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold font-heading text-primary leading-tight">
          Loan Term Rates & Penalty Policies
        </h2>
        <p className="text-muted-foreground text-sm">
          Configure monthly interest rates, daily late penalties, and mandatory caps for terms 1–12 months (§2.2, §2.9, D-05).
        </p>
      </header>

      {/* Policy Draft Notice Banner */}
      {openDraft && openDraft.changesCount > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
          <div className="text-xs text-amber-900 flex-1">
            <p className="font-bold">Pending Policy Update Notice Draft</p>
            <p className="mt-0.5">
              There are {openDraft.changesCount} unannounced rate changes in the draft announcement. You can review and broadcast them from the announcements dashboard. Existing active loan contracts remain unaffected.
            </p>
          </div>
        </div>
      )}

      {/* Duration Selector Tabs */}
      <div className="flex flex-wrap gap-1.5 p-1 bg-surface-container rounded-xl border border-outline-variant/30">
        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
          const isSelected = selectedDuration === m
          const r = ratesMap[m]
          return (
            <button
              key={m}
              type="button"
              onClick={() => setSelectedDuration(m)}
              className={`flex-1 min-w-[70px] py-2 px-3 text-xs font-semibold rounded-lg transition-all text-center ${
                isSelected
                  ? 'bg-primary text-on-primary shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-surface-container-highest'
              }`}
            >
              <div>{m} {m === 1 ? 'Month' : 'Months'}</div>
              <div className="text-[10px] font-mono opacity-80 mt-0.5">
                {r?.monthlyInterestPercent}%
              </div>
            </button>
          )
        })}
      </div>

      <Card className="p-6 border border-outline-variant/30 shadow-none rounded-xl bg-surface-container-lowest">
        <form onSubmit={handleSave} className="flex flex-col gap-6">
          <div className="flex items-center justify-between pb-4 border-b border-outline-variant/20">
            <div>
              <h3 className="font-bold text-base text-primary">
                Configuration for {selectedDuration}-Month Term
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Version {currentRate.version} • Effective from {currentRate.effectiveFrom}
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary">
              <Clock className="w-3.5 h-3.5" />
              Active Policy
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Monthly Interest Rate */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="monthlyInterest" className="font-semibold text-xs text-primary flex items-center justify-between">
                <span>Monthly Interest Rate (Flat % on Principal)</span>
                <span className="text-[11px] text-muted-foreground font-normal">Per Month (§2.9)</span>
              </Label>
              <div className="relative">
                <Input
                  id="monthlyInterest"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={currentRate.monthlyInterestPercent}
                  onChange={(e) =>
                    handleFieldChange('monthlyInterestPercent', parseFloat(e.target.value) || 0)
                  }
                  className="pl-3 pr-10 font-mono text-sm"
                  required
                />
                <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-muted-foreground">
                  <Percent className="w-4 h-4" />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground leading-normal">
                Total term interest = {currentRate.monthlyInterestPercent}% × {selectedDuration} ={' '}
                <strong className="text-foreground">
                  {(Number(currentRate.monthlyInterestPercent) * selectedDuration).toFixed(2)}%
                </strong>
              </p>
            </div>

            {/* Daily Late Penalty Percent */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="latePenalty" className="font-semibold text-xs text-primary flex items-center justify-between">
                <span>Daily Late Penalty %</span>
                <span className="text-[11px] text-muted-foreground font-normal">Per Day (§2.2)</span>
              </Label>
              <div className="relative">
                <Input
                  id="latePenalty"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={currentRate.latePenaltyDailyPercent}
                  onChange={(e) =>
                    handleFieldChange('latePenaltyDailyPercent', parseFloat(e.target.value) || 0)
                  }
                  className="pl-3 pr-10 font-mono text-sm"
                  required
                />
                <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-muted-foreground">
                  <Percent className="w-4 h-4" />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground leading-normal">
                Applied daily on original principal after 7-day grace period (starts Day +8).
              </p>
            </div>

            {/* Penalty Cap Type */}
            <div className="flex flex-col gap-2">
              <Label className="font-semibold text-xs text-primary">
                Mandatory Penalty Cap Type (D-05)
              </Label>
              <Select
                value={currentRate.penaltyCapType}
                onValueChange={(v) => handleFieldChange('penaltyCapType', v as PenaltyCapType)}
              >
                <SelectTrigger className="font-sans text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PenaltyCapType.PERCENT_OF_PRINCIPAL}>
                    Percentage of Disbursed Principal (%)
                  </SelectItem>
                  <SelectItem value={PenaltyCapType.FIXED_AMOUNT}>
                    Fixed Naira Ceiling (₦)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Penalty Cap Value */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="capValue" className="font-semibold text-xs text-primary flex items-center justify-between">
                <span>
                  {currentRate.penaltyCapType === PenaltyCapType.PERCENT_OF_PRINCIPAL
                    ? 'Cap Percentage (%)'
                    : 'Fixed Ceiling Amount (₦)'}
                </span>
                <span className="text-[11px] text-error font-medium">Must be &gt; 0</span>
              </Label>
              <div className="relative">
                <Input
                  id="capValue"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={currentRate.penaltyCapValue}
                  onChange={(e) =>
                    handleFieldChange('penaltyCapValue', parseFloat(e.target.value) || 0)
                  }
                  className="pl-3 pr-10 font-mono text-sm"
                  required
                />
                <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-muted-foreground">
                  {currentRate.penaltyCapType === PenaltyCapType.PERCENT_OF_PRINCIPAL ? (
                    <Percent className="w-4 h-4" />
                  ) : (
                    <span className="text-xs font-bold">₦</span>
                  )}
                </div>
              </div>
            </div>

            {/* Effective From Date */}
            <div className="flex flex-col gap-2 md:col-span-2">
              <Label htmlFor="effectiveFrom" className="font-semibold text-xs text-primary">
                Effective From Date (Africa/Lagos)
              </Label>
              <Input
                id="effectiveFrom"
                type="date"
                value={currentRate.effectiveFrom}
                onChange={(e) => handleFieldChange('effectiveFrom', e.target.value)}
                className="max-w-xs text-sm"
                required
              />
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Editing a rate saves a new version and automatically schedules a policy-update draft for member announcements (D-09).
              </p>
            </div>
          </div>

          <div className="pt-4 border-t border-outline-variant/20 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldAlert className="w-4 h-4 text-primary" />
              <span>Existing active loans retain their snapshotted terms.</span>
            </div>

            <Button
              type="submit"
              className="bg-primary text-on-primary hover:bg-primary/90 h-10 px-6 font-semibold"
              disabled={isPending}
            >
              {isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save {selectedDuration}-Month Terms
            </Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
