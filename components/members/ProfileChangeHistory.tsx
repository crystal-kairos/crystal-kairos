'use client'

import React, { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ProfileChangeStatus, ProfileChangeType } from '@/generated/prisma/enums'
import { cancelProfileChangeRequestAction } from '@/models/members/profile-change-actions'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { History } from 'lucide-react'

export interface ProfileChangeHistoryItem {
  id: string
  changeType: ProfileChangeType
  status: ProfileChangeStatus
  proposedValue: unknown
  submittedAt: Date | string
  reviewedAt: Date | string | null
  rejectionReason: string | null
}

const TYPE_LABELS: Record<ProfileChangeType, string> = {
  [ProfileChangeType.NEXT_OF_KIN]: 'Next of kin',
  [ProfileChangeType.PRIMARY_BANK]: 'Primary bank account',
  [ProfileChangeType.BANK_DETAILS]: 'Bank account details',
}

const STATUS_STYLES: Record<ProfileChangeStatus, { label: string; className: string }> = {
  [ProfileChangeStatus.PENDING]: {
    label: 'Under review',
    className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30',
  },
  [ProfileChangeStatus.APPROVED]: {
    label: 'Approved',
    className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30',
  },
  [ProfileChangeStatus.REJECTED]: {
    label: 'Rejected',
    className: 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border border-rose-500/30',
  },
  [ProfileChangeStatus.CANCELLED]: {
    label: 'Cancelled',
    className: 'bg-transparent text-muted-foreground border border-outline-variant',
  },
}

function describeProposal(item: ProfileChangeHistoryItem): string {
  const v = (item.proposedValue ?? {}) as Record<string, unknown>
  if (item.changeType === ProfileChangeType.NEXT_OF_KIN) {
    return [v.name, v.relationship].filter(Boolean).join(' · ')
  }
  return [v.bankName, v.accountNumberMasked].filter(Boolean).join(' · ')
}

const formatDate = (d: Date | string) =>
  new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * The member's own profile change requests (PR P3-02B): status, rejection reason,
 * and a cancel action for requests still under review.
 */
export const ProfileChangeHistory = ({ items }: { items: ProfileChangeHistoryItem[] }) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const handleCancel = async (id: string) => {
    const res = await cancelProfileChangeRequestAction(id)
    if (res.success) {
      toast.success('Change request cancelled.')
      startTransition(() => router.refresh())
    } else {
      toast.error(res.error || 'Failed to cancel the request.')
    }
  }

  return (
    <Card className='border-0 bg-surface-container rounded-md shadow-none'>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm font-bold text-primary uppercase tracking-wide flex items-center gap-2'>
          <History className='w-4 h-4' /> Change Requests
        </CardTitle>
        <CardDescription className='text-xs'>
          Changes to bank details and next of kin take effect after an administrator approves them.
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-3'>
        {items.length === 0 ? (
          <p className='text-xs text-muted-foreground'>You have not requested any changes yet.</p>
        ) : (
          items.map((item) => {
            const status = STATUS_STYLES[item.status]
            return (
              <div
                key={item.id}
                className='flex flex-col gap-1.5 border-b border-outline-variant/30 pb-3 last:border-0 last:pb-0'
              >
                <div className='flex items-center justify-between gap-2 flex-wrap'>
                  <span className='text-xs font-semibold'>{TYPE_LABELS[item.changeType]}</span>
                  <Badge className={`text-[10px] font-medium ${status.className}`}>{status.label}</Badge>
                </div>
                <span className='text-xs text-muted-foreground truncate'>{describeProposal(item)}</span>
                <span className='text-[11px] text-muted-foreground'>
                  Submitted {formatDate(item.submittedAt)}
                  {item.reviewedAt ? ` · Reviewed ${formatDate(item.reviewedAt)}` : ''}
                </span>
                {item.status === ProfileChangeStatus.REJECTED && item.rejectionReason && (
                  <span className='text-[11px] text-rose-600 dark:text-rose-400'>
                    Reason: {item.rejectionReason}
                  </span>
                )}
                {item.status === ProfileChangeStatus.PENDING && (
                  <div>
                    <Button
                      variant='ghost'
                      size='sm'
                      disabled={isPending}
                      onClick={() => handleCancel(item.id)}
                      className='h-7 px-2 text-[11px] text-muted-foreground hover:text-error cursor-pointer'
                    >
                      Cancel request
                    </Button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
