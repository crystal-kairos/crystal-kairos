'use client'

import React, { useState } from 'react'
import {
  Users,
  ArrowRight,
  Clock,
  ArrowLeft,
  Upload,
  CheckCircle2,
  XCircle,
  TrendingUp,
  Calendar,
} from 'lucide-react'
import Link from 'next/link'
import { Card, CardContent } from '../ui/card'
import { Button } from '../ui/button'
import { UploadAjoReceiptDialog } from './UploadAjoReceiptDialog'

type EAjoMemberStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELLED'
type EAjoGroupStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'APPROVED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REJECTED'

interface MemberGroup {
  id: string
  title: string
  description: string | null
  contributionAmount: number
  frequency: string
  duration: string
  totalSlots: number
  filledSlots: number
  status: EAjoGroupStatus
  startDate: Date | null
}

interface Membership {
  id: string
  groupId: string
  payoutPosition: number
  feePercentage: number
  netPayoutAmount: number
  totalExpectedPayout: number
  currentBalance: number
  totalContributed: number
  status: EAjoMemberStatus
  createdAt: Date
  group: MemberGroup
}

interface OpenGroup {
  id: string
  title: string
  description: string | null
  contributionAmount: number
  frequency: string
  duration: string
  totalSlots: number
  filledSlots: number
  status: EAjoGroupStatus
  startDate: Date | null
  members: { payoutPosition: number; status: string }[]
}

interface EAjoDashboardClientProps {
  userId: string
  memberships: Membership[]
  openGroups: OpenGroup[]
}

const MEMBER_STATUS_STYLES: Record<EAjoMemberStatus, string> = {
  PENDING: 'bg-amber-50 text-amber-700 border-amber-200',
  APPROVED: 'bg-blue-50 text-blue-700 border-blue-200',
  ACTIVE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  COMPLETED: 'bg-slate-100 text-slate-600 border-slate-200',
  REJECTED: 'bg-red-50 text-red-700 border-red-200',
  CANCELLED: 'bg-red-50 text-red-600 border-red-200',
}

const formatCurrency = (val: number) =>
  new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 0,
  }).format(val)

const formatFrequency = (freq: string) =>
  freq.charAt(0) + freq.slice(1).toLowerCase()

const formatDuration = (d: string) =>
  d === 'FOUR_MONTHS'
    ? '4 Months'
    : d === 'SIX_MONTHS'
      ? '6 Months'
      : '12 Months'

export const EAjoDashboardClient = ({
  userId,
  memberships,
  openGroups,
}: EAjoDashboardClientProps) => {
  const [activeMemberId, setActiveMemberId] = useState<string | null>(null)
  const [activeAmount, setActiveAmount] = useState(0)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)

  // Groups the user hasn't joined yet
  const joinedGroupIds = new Set(memberships.map((m) => m.groupId))
  const availableGroups = openGroups.filter((g) => !joinedGroupIds.has(g.id))

  return (
    <div className='flex flex-col gap-6 w-full max-w-5xl mx-auto py-6'>
      {/* Back button */}
      <div className='flex items-center gap-1.5 text-muted-foreground hover:text-primary cursor-pointer transition-colors w-fit text-xs font-semibold'>
        <ArrowLeft className='w-4 h-4' />
        <Link href={`/dashboard/${userId}`}>Back to Dashboard</Link>
      </div>

      <header className='flex flex-col md:flex-row md:items-end justify-between gap-4'>
        <div>
          <h2 className='text-2xl font-bold font-heading text-primary leading-tight'>
            Digital Ajo Cycles
          </h2>
          <p className='text-muted-foreground text-sm mt-1'>
            Participate in risk-adjusted rotating group savings pools.
          </p>
        </div>
      </header>

      {/* 1. My memberships */}
      <section className='flex flex-col gap-3'>
        <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
          My Ajo Groups
        </h3>

        {memberships.length === 0 ? (
          <div className='border border-dashed border-outline-variant/30 rounded-lg py-12 text-center text-xs text-muted-foreground font-medium bg-surface-container-lowest'>
            You haven't joined any Ajo group yet. Browse the available offerings
            below to apply!
          </div>
        ) : (
          <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
            {memberships.map((membership) => {
              const progress = Math.min(
                100,
                membership.group.totalSlots > 0
                  ? (membership.totalContributed /
                      (membership.group.contributionAmount *
                        membership.group.totalSlots)) *
                      100
                  : 0,
              )
              const canUpload =
                membership.status === 'ACTIVE' ||
                membership.status === 'APPROVED'

              return (
                <Card
                  key={membership.id}
                  className='border-0 bg-surface-container rounded-md shadow-none hover:ring-1 hover:ring-primary/20 transition-all duration-200'
                >
                  <CardContent className='p-5 flex flex-col justify-between min-h-50'>
                    <div className='flex justify-between items-start mb-3'>
                      <div>
                        <h4 className='font-bold text-primary text-sm'>
                          {membership.group.title}
                        </h4>
                        <p className='text-[10px] text-muted-foreground mt-0.5'>
                          Slot {membership.payoutPosition} ·{' '}
                          {formatDuration(membership.group.duration)}
                        </p>
                      </div>
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border ${MEMBER_STATUS_STYLES[membership.status]}`}
                      >
                        {membership.status}
                      </span>
                    </div>

                    <div className='grid grid-cols-3 gap-2 py-2 border-y border-outline-variant/20 mb-3 text-xs'>
                      <div>
                        <span className='text-[9px] text-muted-foreground uppercase tracking-wider block'>
                          Contribution
                        </span>
                        <span className='font-bold text-primary font-mono'>
                          {formatCurrency(membership.group.contributionAmount)}/
                          {formatFrequency(membership.group.frequency)}
                        </span>
                      </div>
                      <div>
                        <span className='text-[9px] text-muted-foreground uppercase tracking-wider block'>
                          Position
                        </span>
                        <span className='font-bold text-primary font-mono'>
                          Slot {membership.payoutPosition}
                        </span>
                      </div>
                      <div>
                        <span className='text-[9px] text-muted-foreground uppercase tracking-wider block'>
                          Net Payout
                        </span>
                        <span className='font-bold text-success-green font-mono'>
                          {formatCurrency(membership.netPayoutAmount)}
                        </span>
                      </div>
                    </div>

                    <div className='flex flex-col gap-2'>
                      <div>
                        <div className='flex justify-between text-[10px] text-muted-foreground mb-1 font-mono'>
                          <span>
                            Contributed:{' '}
                            {formatCurrency(membership.totalContributed)}
                          </span>
                          <span>{progress.toFixed(0)}%</span>
                        </div>
                        <div className='w-full bg-outline-variant/35 rounded-full h-1.5'>
                          <div
                            className='bg-success h-1.5 rounded-full transition-all duration-300'
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      </div>

                      {canUpload && (
                        <Button
                          size='sm'
                          onClick={() => {
                            setActiveMemberId(membership.id)
                            setActiveAmount(membership.group.contributionAmount)
                            setUploadDialogOpen(true)
                          }}
                          className='cursor-pointer rounded-sm bg-secondary text-white hover:bg-secondary/90 flex items-center gap-1.5 text-[11px] h-8 px-4 border-0 mt-2 self-start font-semibold'
                        >
                          <Upload className='w-3.5 h-3.5' />
                          <span>Upload Contribution Receipt</span>
                        </Button>
                      )}

                      {membership.status === 'PENDING' && (
                        <p className='text-[10px] text-amber-600 bg-amber-50 rounded px-2 py-1 mt-1'>
                          Application pending admin approval.
                        </p>
                      )}
                      {membership.status === 'REJECTED' && (
                        <p className='text-[10px] text-error bg-error/5 rounded px-2 py-1 mt-1'>
                          Application was rejected. You may apply to another
                          group.
                        </p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      {/* 2. Available group offerings */}
      <section className='flex flex-col gap-4 mt-4'>
        <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
          Available Group Offerings
        </h3>

        {availableGroups.length === 0 ? (
          <div className='border border-dashed border-outline-variant/30 rounded-lg py-12 text-center text-xs text-muted-foreground font-medium bg-surface-container-lowest'>
            {openGroups.length === 0
              ? 'No eAjo groups are currently available. Please check back later.'
              : 'You have already applied to all available groups.'}
          </div>
        ) : (
          <div className='grid grid-cols-1 md:grid-cols-3 gap-6'>
            {availableGroups.map((group) => {
              const filledSlotPositions = new Set(
                group.members
                  .filter(
                    (m) => m.status !== 'REJECTED' && m.status !== 'CANCELLED',
                  )
                  .map((m) => m.payoutPosition),
              )
              const openSlots = group.totalSlots - filledSlotPositions.size

              return (
                <Card
                  key={group.id}
                  className='bg-surface-container-lowest rounded-md shadow-none flex flex-col justify-between p-6 border border-outline-variant/15 hover:shadow-md transition-all duration-300'
                >
                  <div className='flex flex-col gap-2'>
                    <div className='w-9 h-9 rounded-sm bg-primary/10 text-primary flex items-center justify-center mb-1'>
                      <Users className='w-5 h-5' />
                    </div>
                    <h4 className='font-bold text-primary text-base leading-snug'>
                      {group.title}
                    </h4>
                    {group.description && (
                      <p className='text-muted-foreground text-xs leading-relaxed mt-1 line-clamp-2'>
                        {group.description}
                      </p>
                    )}

                    <div className='flex flex-col gap-1.5 mt-4 pt-3 border-t border-outline-variant/20'>
                      <div className='flex justify-between text-xs'>
                        <span className='text-muted-foreground'>
                          Contribution size:
                        </span>
                        <span className='font-bold text-primary font-mono'>
                          {formatCurrency(group.contributionAmount)}
                        </span>
                      </div>
                      <div className='flex justify-between text-xs'>
                        <span className='text-muted-foreground'>
                          Frequency:
                        </span>
                        <span className='font-semibold text-primary'>
                          {formatFrequency(group.frequency)}
                        </span>
                      </div>
                      <div className='flex justify-between text-xs'>
                        <span className='text-muted-foreground'>
                          Duration / Slots:
                        </span>
                        <span className='font-semibold text-primary'>
                          {formatDuration(group.duration)} ({group.totalSlots}{' '}
                          slots)
                        </span>
                      </div>
                      <div className='flex justify-between text-xs'>
                        <span className='text-muted-foreground'>
                          Open slots:
                        </span>
                        <span
                          className={`font-bold ${openSlots === 0 ? 'text-error' : 'text-success-green'}`}
                        >
                          {openSlots === 0 ? 'Full' : `${openSlots} available`}
                        </span>
                      </div>
                      <div className='flex justify-between text-xs'>
                        <span className='text-muted-foreground font-bold'>
                          Total Pool Size:
                        </span>
                        <span className='font-extrabold text-success-green font-mono'>
                          {formatCurrency(
                            group.contributionAmount * group.totalSlots,
                          )}
                        </span>
                      </div>
                      {group.startDate && (
                        <div className='flex justify-between text-xs'>
                          <span className='text-muted-foreground'>
                            Start Date:
                          </span>
                          <span className='font-semibold text-primary flex items-center gap-1'>
                            <Calendar className='w-3 h-3' />
                            {new Date(group.startDate).toLocaleDateString(
                              'en-NG',
                              {
                                day: 'numeric',
                                month: 'short',
                                year: 'numeric',
                              },
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  <Button
                    asChild
                    disabled={openSlots === 0}
                    className='cursor-pointer rounded-sm bg-primary hover:bg-primary/95 text-on-primary font-semibold flex items-center justify-center gap-1.5 w-full mt-6 h-10 disabled:opacity-50 disabled:cursor-not-allowed'
                  >
                    <Link
                      href={
                        openSlots > 0
                          ? `/dashboard/${userId}/eajo/new?groupId=${group.id}`
                          : '#'
                      }
                    >
                      <span>
                        {openSlots === 0 ? 'Group Full' : 'Apply for a Slot'}
                      </span>
                      {openSlots > 0 && <ArrowRight className='w-4 h-4' />}
                    </Link>
                  </Button>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      {/* Upload Receipt Modal */}
      {activeMemberId && (
        <UploadAjoReceiptDialog
          userId={userId}
          eAjoMemberId={activeMemberId}
          contributionAmount={activeAmount}
          open={uploadDialogOpen}
          onOpenChange={setUploadDialogOpen}
        />
      )}
    </div>
  )
}
