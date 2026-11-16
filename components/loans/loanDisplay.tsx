import { cn } from '@/lib/utils'

/**
 * One canonical label/colour mapping for loan and instalment states (§4.2).
 */
const LOAN_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'Awaiting review', tone: 'warning' },
  APPROVED: { label: 'Offer ready', tone: 'info' },
  AWAITING_RECONSENT: { label: 'Revised offer', tone: 'info' },
  ACCEPTED: { label: 'Awaiting disbursement', tone: 'info' },
  ACTIVE: { label: 'Active', tone: 'success' },
  OVERDUE: { label: 'Overdue', tone: 'error' },
  DEFAULTED: { label: 'In recovery', tone: 'error' },
  COMPLETED: { label: 'Repaid', tone: 'success' },
  REJECTED: { label: 'Rejected', tone: 'neutral' },
  DECLINED: { label: 'Offer declined', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  EXPIRED: { label: 'Offer expired', tone: 'neutral' },
  DISBURSED: { label: 'Disbursed', tone: 'success' },
}

const PERIOD_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'Not yet due', tone: 'neutral' },
  ONGOING: { label: 'Part paid', tone: 'warning' },
  IN_REVIEW: { label: 'Payment under review', tone: 'info' },
  COMPLETED: { label: 'Paid', tone: 'success' },
  OVERDUE: { label: 'Overdue', tone: 'error' },
  WAIVED: { label: 'Waived', tone: 'neutral' },
  REJECTED: { label: 'Receipt rejected', tone: 'error' },
}

type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral'

const TONE_CLASS: Record<Tone, string> = {
  success: 'bg-success-container/30 text-on-success',
  warning: 'bg-warning-container/30 text-on-warning',
  error: 'bg-error/10 text-error',
  info: 'bg-primary/10 text-primary',
  neutral: 'bg-surface-container-highest text-muted-foreground',
}

function Badge({ label, tone, className }: { label: string; tone: Tone; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
        TONE_CLASS[tone],
        className,
      )}
    >
      {label}
    </span>
  )
}

export function LoanStatusBadge({ status, className }: { status: string; className?: string }) {
  const c = LOAN_STATUS[status] ?? { label: status, tone: 'neutral' as Tone }
  return <Badge {...c} className={className} />
}

export function InstalmentStatusBadge({ status, className }: { status: string; className?: string }) {
  const c = PERIOD_STATUS[status] ?? { label: status, tone: 'neutral' as Tone }
  return <Badge {...c} className={className} />
}

export const loanStatusLabel = (status: string) => LOAN_STATUS[status]?.label ?? status

export const formatNGN = (val: number | null | undefined) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 2 }).format(
    Number(val ?? 0),
  )

export const formatDay = (d: Date | string | null | undefined) =>
  d
    ? new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(d),
      )
    : '—'

/** Total-cost disclosure shown before applying and on the offer (§2.9). */
export function LoanCostSummary({
  quote,
}: {
  quote: {
    principal: number
    termMonths: number
    monthlyInterestRatePercent: number
    monthlyInstalment: number
    finalInstalment: number
    totalInterest: number
    applicationFee: number
    totalScheduledRepayment: number
    latePenaltyDailyPercent: number
    dailyPenaltyPerOverdueInstalment: number
    penaltyCapType: string
    penaltyCapAmount: number
    graceDays: number
  }
}) {
  const rows: [string, string][] = [
    ['Amount borrowed', formatNGN(quote.principal)],
    ['Term', `${quote.termMonths} month${quote.termMonths === 1 ? '' : 's'}`],
    ['Interest rate', `${quote.monthlyInterestRatePercent}% per month, flat on the amount borrowed`],
    [
      'Monthly instalment',
      quote.finalInstalment !== quote.monthlyInstalment
        ? `${formatNGN(quote.monthlyInstalment)} (last: ${formatNGN(quote.finalInstalment)})`
        : formatNGN(quote.monthlyInstalment),
    ],
    ['Total interest', formatNGN(quote.totalInterest)],
    ['Application fee', formatNGN(quote.applicationFee)],
  ]
  return (
    <div className="space-y-3 text-sm">
      <dl className="divide-y divide-border">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 py-1.5">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-medium text-right">{v}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-4 py-2">
          <dt className="font-semibold">Total repayable</dt>
          <dd className="font-bold text-primary text-right">{formatNGN(quote.totalScheduledRepayment)}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground leading-relaxed">
        If an instalment is unpaid, you have {quote.graceDays} days of grace after its due date. From day{' '}
        {quote.graceDays + 1}, a late penalty of {quote.latePenaltyDailyPercent}% of the amount borrowed (
        {formatNGN(quote.dailyPenaltyPerOverdueInstalment)}) is charged per overdue instalment per day, up to{' '}
        {formatNGN(quote.penaltyCapAmount)} in total for the loan. Overdue amounts may be recovered from your
        savings and then from your guarantor, only after a final notice and an admin decision. Your savings
        cannot be withdrawn while the loan is outstanding.
      </p>
    </div>
  )
}
