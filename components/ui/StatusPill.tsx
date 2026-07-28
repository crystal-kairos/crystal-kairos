import { cn } from '@/lib/utils'

export type StatusPillStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'DISBURSED'
  | 'FAILED'
  | 'ACTIVE'
  | 'INACTIVE'

interface StatusPillProps {
  status: StatusPillStatus | string
  className?: string
}

const statusMap: Record<
  StatusPillStatus | string,
  { label: string; bgClass: string; textClass: string }
> = {
  PENDING: {
    label: 'Pending',
    bgClass: 'bg-warning-container/30 dark:bg-warning-container/20',
    textClass: 'text-on-warning',
  },
  APPROVED: {
    label: 'Approved',
    bgClass: 'bg-success-container/30 dark:bg-success-container/20',
    textClass: 'text-on-success',
  },
  CONFIRMED: {
    label: 'Confirmed',
    bgClass: 'bg-success-container/30 dark:bg-success-container/20',
    textClass: 'text-on-success',
  },
  ACTIVE: {
    label: 'Active',
    bgClass: 'bg-success-container/30 dark:bg-success-container/20',
    textClass: 'text-on-success',
  },
  REJECTED: {
    label: 'Rejected',
    bgClass: 'bg-error-container/30 dark:bg-error-container/20',
    textClass: 'text-on-error',
  },
  FAILED: {
    label: 'Failed',
    bgClass: 'bg-error-container/30 dark:bg-error-container/20',
    textClass: 'text-on-error',
  },
  DISBURSED: {
    label: 'Disbursed',
    bgClass: 'bg-tertiary-dim/30 dark:bg-tertiary-dim/20',
    textClass: 'text-on-tertiary',
  },
  INACTIVE: {
    label: 'Inactive',
    bgClass: 'bg-neutral-container/30 dark:bg-neutral-container/20',
    textClass: 'text-on-surface-variant',
  },
}

export const StatusPill = ({ status, className }: StatusPillProps) => {
  const normalizedStatus = status.toUpperCase()
  const config = statusMap[normalizedStatus] || {
    label: status,
    bgClass: 'bg-surface-container-highest',
    textClass: 'text-muted-foreground',
  }

  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-xs font-semibold h-6 font-sans border-0 select-none tracking-wide transition-colors duration-150',
        config.bgClass,
        config.textClass,
        className,
      )}
    >
      {config.label}
    </span>
  )
}
export default StatusPill
