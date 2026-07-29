'use client'

import React, { useState } from 'react'
import {
  Wallet,
  PlusCircle,
  Upload,
  UserPlus,
  Banknote,
  PiggyBank,
  Receipt,
  Calendar,
  CheckCircle2,
  MoreVertical,
  ArrowRight,
  Landmark,
  Users,
  Eye,
  ArrowUpRight,
  ArrowDownLeft,
} from 'lucide-react'
import { Button } from '../ui/button'
import { StatusPill } from '../ui/StatusPill'
import { ReceiptLightbox } from '../ui/ReceiptLightbox'
import { TransactionType } from '@/generated/prisma/enums'
import Link from 'next/link'

interface AjoRecord {
  id: string
  contributionAmount: number
  totalParticipants: number
  duration: string
  frequency: string
  payoutPosition: number
  netPayoutAmount: number
  status: string
}

interface Transaction {
  id: string
  amount: any
  type: TransactionType
  category: string
  status: string
  receiptUrl: string | null
  createdAt: any
}

interface MemberDashboardBentoProps {
  userId: string
  memberName: string
  walletBalance: number
  ajoRecords: AjoRecord[]
  transactions: Transaction[]
  hasBankAccounts: boolean
  hasNextOfKin: boolean
}

export const MemberDashboardBento = ({
  userId,
  memberName,
  walletBalance,
  ajoRecords,
  transactions,
  hasBankAccounts,
  hasNextOfKin,
}: MemberDashboardBentoProps) => {
  const [selectedReceipt, setSelectedReceipt] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 2,
    }).format(val)
  }

  const formatCategory = (category: string) => {
    return category.replace(/_/g, ' ').toLowerCase()
  }

  const handleViewReceipt = (url: string) => {
    setSelectedReceipt(url)
    setLightboxOpen(true)
  }

  return (
    <div className='flex flex-col gap-6'>
      {/* 1. HeaderGreeting */}
      <header className='flex flex-col md:flex-row md:items-end justify-between gap-4'>
        <div>
          <h2 className='text-2xl font-bold font-heading text-primary leading-tight'>
            Welcome back, {memberName}
          </h2>
          <p className='text-muted-foreground text-sm mt-1'>
            Here's a summary of your cooperative activities.
          </p>
        </div>
        <div className='hidden md:flex items-center gap-2 bg-surface-container-lowest px-4 py-1.5 rounded-full border border-outline-variant/35 shadow-sm text-xs font-semibold text-muted-foreground'>
          <Calendar className='w-4 h-4 text-outline' />
          <span>
            Today,{' '}
            {new Date().toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </span>
        </div>
      </header>

      {/* 2. i18n/Nudges System */}
      <section className='flex flex-col gap-3'>
        {!hasBankAccounts && (
          <div className='bg-primary/5 border border-primary/20 rounded-lg p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4'>
            <div className='flex items-start gap-3'>
              <Landmark className='w-5 h-5 text-primary shrink-0 mt-0.5' />
              <div>
                <h4 className='font-bold text-primary text-sm'>
                  Complete your profile
                </h4>
                <p className='text-muted-foreground text-xs mt-0.5'>
                  Add a bank account to receive payouts securely.
                </p>
              </div>
            </div>
            <Button
              asChild
              size='sm'
              className='cursor-pointer rounded-sm bg-primary text-on-primary hover:bg-primary/90 h-9 px-4 shrink-0'
            >
              <Link href={`/dashboard/${userId}/banks`}>Add Now</Link>
            </Button>
          </div>
        )}

        {!hasNextOfKin && (
          <div className='bg-warning-amber/10 border border-warning-amber/20 rounded-lg p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4'>
            <div className='flex items-start gap-3'>
              <Users className='w-5 h-5 text-warning-amber shrink-0 mt-0.5' />
              <div>
                <h4 className='font-bold text-warning-amber text-sm'>
                  Action Required
                </h4>
                <p className='text-muted-foreground text-xs mt-0.5'>
                  Add your next of kin to ensure your assets are protected.
                </p>
              </div>
            </div>
            <Button
              asChild
              size='sm'
              className='cursor-pointer rounded-sm bg-warning hover:bg-warning/90 text-white border-0 h-9 px-4 shrink-0'
            >
              <Link href={`/dashboard/${userId}/profile`}>Update Profile</Link>
            </Button>
          </div>
        )}
      </section>

      {/* 3. Bento Grid */}
      <div className='grid grid-cols-1 md:grid-cols-12 gap-6'>
        {/* A. Confirmed Balance Card (col-span-8) */}
        <div className='col-span-1 md:col-span-8 bg-surface-container-lowest rounded-lg p-6 border border-outline-variant/15 shadow-[0_4px_12px_rgba(0,0,0,0.03)] relative overflow-hidden group flex flex-col justify-between min-h-50'>
          <div className='absolute inset-0 bg-linear-to-br from-primary/5 to-transparent pointer-events-none' />
          <div className='relative z-10'>
            <div className='flex items-center gap-2 text-muted-foreground'>
              <Wallet className='w-4 h-4 text-outline' />
              <span className='text-[10px] font-bold uppercase tracking-wider'>
                Confirmed Balance
              </span>
            </div>
            <h3 className='text-4xl font-extrabold font-mono tracking-tight text-primary mt-3'>
              {formatCurrency(walletBalance)}
            </h3>
          </div>

          <div className='relative z-10 flex flex-wrap gap-3 mt-6'>
            <Button
              asChild
              className='cursor-pointer rounded-sm bg-primary text-on-primary hover:bg-primary/95 flex items-center gap-1.5 h-10 px-5'
            >
              <Link href={`/dashboard/${userId}/savings/new`}>
                <PlusCircle className='w-4 h-4' />
                <span>Save</span>
              </Link>
            </Button>
            <Button
              asChild
              variant='outline'
              className='cursor-pointer rounded-sm border-outline-variant/50 hover:bg-surface-container-low flex items-center gap-1.5 h-10 px-5'
            >
              {/* Point to uploader receipts index */}
              <Link href={`/dashboard/${userId}/profile`}>
                <Upload className='w-4 h-4 text-outline' />
                <span>Update Details</span>
              </Link>
            </Button>
          </div>
        </div>

        {/* B. Quick Actions (col-span-4) */}
        <div className='col-span-1 md:col-span-4 bg-surface-container-lowest rounded-lg p-6 border border-outline-variant/15 shadow-[0_4px_12px_rgba(0,0,0,0.03)] flex flex-col justify-between'>
          <h3 className='font-bold text-sm text-primary uppercase tracking-wide mb-4'>
            Quick Actions
          </h3>
          <div className='grid grid-cols-2 gap-3'>
            {!hasBankAccounts || !hasNextOfKin ? (
              <div
                title='Complete your profile (Bank & Next of Kin) to join Ajo'
                className='flex flex-col items-center justify-center p-3 bg-surface-container-low rounded-lg border border-outline-variant/10 opacity-60 cursor-not-allowed'
              >
                <div className='w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-2'>
                  <UserPlus className='w-4 h-4' />
                </div>
                <span className='text-xs font-semibold text-on-surface'>
                  Join Ajo
                </span>
              </div>
            ) : (
              <Link
                href={`/dashboard/${userId}/eajo`}
                className='flex flex-col items-center justify-center p-3 bg-surface-container-low hover:bg-primary/5 rounded-lg border border-outline-variant/10 group transition-all duration-200'
              >
                <div className='w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-2 group-hover:scale-110 transition-transform'>
                  <UserPlus className='w-4 h-4' />
                </div>
                <span className='text-xs font-semibold text-on-surface'>
                  Join Ajo
                </span>
              </Link>
            )}

            {!hasBankAccounts || !hasNextOfKin ? (
              <div
                title='Complete your profile (Bank & Next of Kin) to get a loan'
                className='flex flex-col items-center justify-center p-3 bg-surface-container-low rounded-lg border border-outline-variant/10 opacity-60 cursor-not-allowed'
              >
                <div className='w-9 h-9 rounded-full bg-secondary/15 text-secondary flex items-center justify-center mb-2'>
                  <Banknote className='w-4 h-4' />
                </div>
                <span className='text-xs font-semibold text-on-surface'>
                  Get Loan
                </span>
              </div>
            ) : (
              <Link
                href={`/dashboard/${userId}/loans`}
                className='flex flex-col items-center justify-center p-3 bg-surface-container-low hover:bg-secondary/5 rounded-lg border border-outline-variant/10 group transition-all duration-200'
              >
                <div className='w-9 h-9 rounded-full bg-secondary/15 text-secondary flex items-center justify-center mb-2 group-hover:scale-110 transition-transform'>
                  <Banknote className='w-4 h-4' />
                </div>
                <span className='text-xs font-semibold text-on-surface'>
                  Get Loan
                </span>
              </Link>
            )}

            {!hasBankAccounts || !hasNextOfKin ? (
              <div
                title='Complete your profile (Bank & Next of Kin) to start saving'
                className='flex flex-col items-center justify-center p-3 bg-surface-container-low rounded-lg border border-outline-variant/10 opacity-60 cursor-not-allowed'
              >
                <div className='w-9 h-9 rounded-full bg-success-green/10 text-success-green flex items-center justify-center mb-2'>
                  <PiggyBank className='w-4 h-4' />
                </div>
                <span className='text-xs font-semibold text-on-surface'>
                  My Savings
                </span>
              </div>
            ) : (
              <Link
                href={`/dashboard/${userId}/savings`}
                className='flex flex-col items-center justify-center p-3 bg-surface-container-low hover:bg-success-green/5 rounded-lg border border-outline-variant/10 group transition-all duration-200'
              >
                <div className='w-9 h-9 rounded-full bg-success-green/10 text-success-green flex items-center justify-center mb-2 group-hover:scale-110 transition-transform'>
                  <PiggyBank className='w-4 h-4' />
                </div>
                <span className='text-xs font-semibold text-on-surface'>
                  My Savings
                </span>
              </Link>
            )}

            <Link
              href={`/dashboard/${userId}/banks`}
              className='flex flex-col items-center justify-center p-3 bg-surface-container-low hover:bg-secondary-container/5 rounded-lg border border-outline-variant/10 group transition-all duration-200'
            >
              <div className='w-9 h-9 rounded-full bg-secondary-container/10 text-secondary-container flex items-center justify-center mb-2 group-hover:scale-110 transition-transform'>
                <Receipt className='w-4 h-4' />
              </div>
              <span className='text-xs font-semibold text-on-surface'>
                Banks Setup
              </span>
            </Link>
          </div>
        </div>

        {/* C. Active Ajo Groups (col-span-6) */}
        <div className='col-span-1 md:col-span-6 bg-surface-container-lowest rounded-lg p-6 border border-outline-variant/15 shadow-[0_4px_12px_rgba(0,0,0,0.03)] flex flex-col'>
          <div className='flex justify-between items-center mb-4 pb-2 border-b border-outline-variant/20'>
            <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
              My Active Ajo Groups
            </h3>
            <Link
              href={`/dashboard/${userId}/eajo`}
              className='text-xs text-secondary font-semibold hover:underline flex items-center gap-0.5'
            >
              <span>View All</span>
              <ArrowRight className='w-3 h-3' />
            </Link>
          </div>

          <div className='flex flex-col gap-4 flex-1 justify-start'>
            {ajoRecords.length === 0 ? (
              <div className='py-12 text-center text-xs text-muted-foreground font-medium select-none flex-1 flex items-center justify-center'>
                No active Ajo groups joined yet.
              </div>
            ) : (
              ajoRecords.slice(0, 2).map((ajo) => (
                <div
                  key={ajo.id}
                  className='bg-surface-container-low p-4 rounded-lg border border-outline-variant/25 hover:border-primary/40 transition-colors'
                >
                  <div className='flex justify-between items-start mb-2'>
                    <div>
                      <h4 className='font-semibold text-primary text-sm'>
                        Ajo Group #{ajo.id.substring(0, 8)}
                      </h4>
                      <p className='text-muted-foreground text-xs'>
                        {formatCurrency(ajo.contributionAmount)} /{' '}
                        {ajo.frequency.toLowerCase()}
                      </p>
                    </div>
                    <span className='bg-light-green text-success-green px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 border border-success-green/20'>
                      <CheckCircle2 className='w-3 h-3 text-success-green' />
                      <span>On Track</span>
                    </span>
                  </div>
                  <div className='w-full bg-outline-variant/35 rounded-full h-1.5 mt-3'>
                    {/* Simulated circle progress: just render a base filled bar */}
                    <div
                      className='bg-success-green h-1.5 rounded-full'
                      style={{ width: '40%' }}
                    ></div>
                  </div>
                  <div className='flex justify-between text-[10px] text-muted-foreground mt-2'>
                    <span>Position: {ajo.payoutPosition}</span>
                    <span>Target: {formatCurrency(ajo.netPayoutAmount)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* D. Recent Activity Ledger (col-span-6) */}
        <div className='col-span-1 md:col-span-6 bg-surface-container-lowest rounded-lg border border-outline-variant/15 shadow-[0_4px_12px_rgba(0,0,0,0.03)] overflow-hidden flex flex-col'>
          <div className='p-5 border-b border-outline-variant/15 flex justify-between items-center bg-surface-bright/50'>
            <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
              Recent Activity
            </h3>
            <button className='p-1 hover:bg-surface-container rounded-full text-muted-foreground transition-colors'>
              <MoreVertical className='w-4 h-4' />
            </button>
          </div>

          <div className='overflow-x-auto flex-1'>
            <table className='w-full text-left border-collapse text-xs'>
              <thead>
                <tr className='bg-primary text-on-primary'>
                  <th className='px-4 py-2 font-semibold tracking-wider'>
                    Transaction
                  </th>
                  <th className='px-4 py-2 font-semibold tracking-wider text-right'>
                    Amount
                  </th>
                  <th className='px-4 py-2 font-semibold tracking-wider text-right'>
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className='divide-y divide-outline-variant/15 bg-surface-container-lowest'>
                {transactions.length === 0 ? (
                  <tr>
                    <td
                      colSpan={3}
                      className='py-12 text-center text-muted-foreground font-medium'
                    >
                      No recent activity.
                    </td>
                  </tr>
                ) : (
                  transactions.slice(0, 3).map((tx) => {
                    const isDeposit = tx.type === TransactionType.DEPOSIT
                    return (
                      <tr
                        key={tx.id}
                        className='hover:bg-surface-container-low transition-colors group'
                      >
                        <td className='px-4 py-3'>
                          <div className='flex items-center gap-2'>
                            <div className='w-7 h-7 rounded bg-surface-container flex items-center justify-center text-outline group-hover:bg-primary/10 group-hover:text-primary transition-colors'>
                              {isDeposit ? (
                                <ArrowDownLeft className='w-4 h-4' />
                              ) : (
                                <ArrowUpRight className='w-4 h-4' />
                              )}
                            </div>
                            <div>
                              <div className='font-semibold text-primary capitalize'>
                                {formatCategory(tx.category)}
                              </div>
                              <div className='text-[10px] text-muted-foreground'>
                                {new Date(tx.createdAt).toLocaleDateString(
                                  undefined,
                                  { month: 'short', day: 'numeric' },
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono font-bold ${isDeposit ? 'text-on-success' : 'text-on-error'}`}
                        >
                          {isDeposit ? '+' : '-'}
                          {formatCurrency(tx.amount)}
                        </td>
                        <td className='px-4 py-3 text-right'>
                          <StatusPill
                            status={tx.status}
                            className='h-5 text-[9px] px-2 py-0'
                          />
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className='p-3 text-center border-t border-outline-variant/15 bg-surface-bright/50'>
            <Link
              href={`/dashboard/${userId}/profile`}
              className='text-secondary text-[11px] font-semibold hover:underline inline-flex items-center gap-1 cursor-pointer'
            >
              <span>View Full Ledger</span>
              <ArrowRight className='w-3.5 h-3.5' />
            </Link>
          </div>
        </div>
      </div>

      <ReceiptLightbox
        url={selectedReceipt}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
      />
    </div>
  )
}
