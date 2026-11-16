import { cn } from '@/lib/utils'

type Tone = 'warning' | 'success' | 'error' | 'info' | 'neutral'

const TONES: Record<Tone, string> = {
  warning: 'bg-warning-container/30 dark:bg-warning-container/20 text-on-warning',
  success: 'bg-success-container/30 dark:bg-success-container/20 text-on-success',
  error: 'bg-error-container/30 dark:bg-error-container/20 text-on-error',
  info: 'bg-tertiary-dim/30 dark:bg-tertiary-dim/20 text-on-tertiary',
  neutral: 'bg-surface-container-highest text-muted-foreground',
}

/** One canonical label/colour mapping for savings plan, period and receipt states (§4.2). */
const LABELS: Record<string, { label: string; tone: Tone }> = {
  // Plan
  'plan:PENDING': { label: 'Awaiting first deposit', tone: 'warning' },
  'plan:ACTIVE': { label: 'Active', tone: 'success' },
  'plan:MATURED': { label: 'Matured', tone: 'info' },
  'plan:WITHDRAWAL_PENDING': { label: 'Withdrawal in progress', tone: 'warning' },
  'plan:WITHDRAWN': { label: 'Withdrawn', tone: 'neutral' },
  'plan:CANCELLED': { label: 'Cancelled', tone: 'neutral' },
  // Period
  'period:PENDING': { label: 'Not yet paid', tone: 'neutral' },
  'period:IN_REVIEW': { label: 'Payment under review', tone: 'info' },
  'period:ONGOING': { label: 'Part paid', tone: 'warning' },
  'period:COMPLETED': { label: 'Paid', tone: 'success' },
  'period:REJECTED': { label: 'Receipt rejected', tone: 'error' },
  'period:OVERDUE': { label: 'Overdue', tone: 'error' },
  'period:WAIVED': { label: 'Waived', tone: 'neutral' },
  // Receipt (PaymentSubmission)
  'receipt:SUBMITTED': { label: 'Under review', tone: 'info' },
  'receipt:CONFIRMED': { label: 'Confirmed', tone: 'success' },
  'receipt:REJECTED': { label: 'Rejected', tone: 'error' },
  'receipt:CANCELLED': { label: 'Cancelled', tone: 'neutral' },
  // Payout (Disbursement)
  'payout:REQUESTED': { label: 'Awaiting approval', tone: 'warning' },
  'payout:APPROVED': { label: 'Approved, awaiting payment', tone: 'info' },
  'payout:PAID': { label: 'Paid', tone: 'success' },
  'payout:FAILED': { label: 'Failed', tone: 'error' },
  'payout:CANCELLED': { label: 'Cancelled', tone: 'neutral' },
}

export function savingsStatusLabel(kind: 'plan' | 'period' | 'receipt' | 'payout', status: string) {
  return LABELS[`${kind}:${status}`]?.label ?? status
}

export function SavingsStatusBadge({
  kind,
  status,
  className,
}: {
  kind: 'plan' | 'period' | 'receipt' | 'payout'
  status: string
  className?: string
}) {
  const cfg = LABELS[`${kind}:${status}`] ?? { label: status, tone: 'neutral' as Tone }
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-xs font-semibold h-6 whitespace-nowrap',
        TONES[cfg.tone],
        className,
      )}
    >
      {cfg.label}
    </span>
  )
}
