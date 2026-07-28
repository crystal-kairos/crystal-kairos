'use client'

import React, { useState, useTransition } from 'react'
import {
  ArrowLeft,
  Calendar,
  Lock,
  PiggyBank,
  RefreshCw,
  Info,
  ShieldCheck,
  AlertTriangle,
  Upload,
  CircleDollarSign,
  Download,
  AlertCircle,
  FileText,
  Eye,
  CheckCircle,
} from 'lucide-react'
import Link from 'next/link'
import { Card, CardContent } from '../ui/card'
import { Button } from '../ui/button'
import { StatusPill } from '../ui/StatusPill'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Label } from '../ui/label'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { ReceiptDropzone } from '../ui/ReceiptDropzone'
import { ReceiptLightbox } from '../ui/ReceiptLightbox'
import {
  submitSavingsDepositAction,
  requestSavingsWithdrawalAction,
} from '@/models/savings/actions'
import { uploadReceiptAction } from '@/models/eajo/actions'
import { useRouter } from 'next/navigation'

interface Transaction {
  id: string
  amount: number
  category: string
  type: string
  status: string
  receiptUrl: string | null
  referenceNumber: string | null
  notes: string | null
  rejectionReason: string | null
  createdAt: any
}

interface SavingsPlan {
  id: string
  savingsType: string
  targetAmount: number | null
  frequency: string
  maturity: string
  interestRate: number
  currentBalance: number
  totalDeposited: number
  accruedInterest: number
  expectedMaturityAmount: number | null
  status: string
  startDate: any
  maturityDate: any
  bankName: string
  accountNumber: string
  accountName: string
  transactions: Transaction[]
}

interface SavingsDetailsClientProps {
  userId: string
  savingsPlan: SavingsPlan
}

export const SavingsDetailsClient = ({
  userId,
  savingsPlan,
}: SavingsDetailsClientProps) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Modals / Lightboxes state
  const [depositOpen, setDepositOpen] = useState(false)
  const [withdrawOpen, setWithdrawOpen] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [selectedReceiptUrl, setSelectedReceiptUrl] = useState<string | null>(
    null,
  )

  // Form states (Deposit)
  const [depositAmount, setDepositAmount] = useState<number>(
    savingsPlan.savingsType === 'FIXED' ? savingsPlan.targetAmount || 0 : 10000,
  )
  const [receiptFile, setReceiptFile] = useState<File | null>(null)
  const [refNo, setRefNo] = useState('')
  const [notes, setNotes] = useState('')
  const [depositError, setDepositError] = useState<string | null>(null)
  const [depositSuccess, setDepositSuccess] = useState(false)

  // Form states (Withdrawal)
  const [withdrawConfirm, setWithdrawConfirm] = useState(false)
  const [withdrawNotes, setWithdrawNotes] = useState('')
  const [withdrawError, setWithdrawError] = useState<string | null>(null)
  const [withdrawSuccess, setWithdrawSuccess] = useState(false)

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 0,
    }).format(val)
  }

  // Calculate maturity progress
  const now = new Date()
  const isMatured = savingsPlan.maturityDate
    ? now >= new Date(savingsPlan.maturityDate)
    : false
  const isEarly = !isMatured

  let progressPct = 0
  let daysRemaining = 0

  if (savingsPlan.startDate && savingsPlan.maturityDate) {
    const start = new Date(savingsPlan.startDate).getTime()
    const end = new Date(savingsPlan.maturityDate).getTime()
    const total = end - start
    const elapsed = Date.now() - start

    progressPct = Math.min(100, Math.max(0, (elapsed / total) * 100))
    daysRemaining = Math.max(
      0,
      Math.ceil((end - Date.now()) / (1000 * 60 * 60 * 24)),
    )
  }

  const handleDepositSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (depositAmount <= 0) {
      setDepositError('Please enter a valid deposit amount.')
      return
    }
    if (!receiptFile) {
      setDepositError('Please select or upload a payment receipt file.')
      return
    }

    setDepositError(null)
    setDepositSuccess(false)

    startTransition(async () => {
      // 1. Upload receipt to Cloudinary
      const uploadFormData = new FormData()
      uploadFormData.append('file', receiptFile)

      const uploadRes = await uploadReceiptAction(uploadFormData)
      if (!uploadRes.success || !uploadRes.url) {
        setDepositError(
          uploadRes.error || 'Failed to upload receipt file to storage.',
        )
        return
      }

      // 2. Log deposit transaction
      const res = await submitSavingsDepositAction(userId, {
        savingsId: savingsPlan.id,
        amount: depositAmount,
        receiptUrl: uploadRes.url,
        referenceNumber: refNo.trim() || undefined,
        notes: notes.trim() || undefined,
      })

      if (res.success) {
        setDepositSuccess(true)
        setReceiptFile(null)
        setRefNo('')
        setNotes('')
        setTimeout(() => {
          setDepositSuccess(false)
          setDepositOpen(false)
          router.refresh()
        }, 1500)
      } else {
        setDepositError(res.error || 'Failed to submit savings deposit.')
      }
    })
  }

  const handleWithdrawSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (isEarly && !withdrawConfirm) {
      setWithdrawError(
        'You must acknowledge the interest forfeiture to proceed.',
      )
      return
    }

    setWithdrawError(null)
    setWithdrawSuccess(false)

    startTransition(async () => {
      const res = await requestSavingsWithdrawalAction(
        userId,
        savingsPlan.id,
        withdrawNotes.trim() || undefined,
      )
      if (res.success) {
        setWithdrawSuccess(true)
        setWithdrawNotes('')
        setWithdrawConfirm(false)
        setTimeout(() => {
          setWithdrawSuccess(false)
          setWithdrawOpen(false)
          router.refresh()
        }, 1500)
      } else {
        setWithdrawError(res.error || 'Failed to request savings withdrawal.')
      }
    })
  }

  const openLightbox = (url: string) => {
    setSelectedReceiptUrl(url)
    setLightboxOpen(true)
  }

  return (
    <div className='flex flex-col gap-6 w-full max-w-5xl mx-auto py-6'>
      {/* Back button */}
      <div className='flex items-center gap-1.5 text-muted-foreground hover:text-primary cursor-pointer transition-colors w-fit text-xs font-semibold'>
        <ArrowLeft className='w-4 h-4' />
        <Link href={`/dashboard/${userId}/savings`}>Back to Savings Hub</Link>
      </div>

      {/* Plan Header */}
      <div className='bg-surface-container-lowest border border-outline-variant/10 rounded-xl p-6 md:p-8 relative overflow-hidden'>
        <div className='flex flex-col md:flex-row justify-between items-start md:items-center gap-6 relative z-10'>
          <div className='flex flex-col gap-2'>
            <div className='inline-flex items-center gap-2'>
              <span className='px-3 py-1 bg-light-blue text-primary rounded-full text-[10px] font-bold tracking-wider uppercase'>
                {savingsPlan.savingsType} SAVINGS PLAN
              </span>
              <StatusPill status={savingsPlan.status} />
            </div>
            <h1 className='text-2xl font-bold text-primary font-heading leading-tight'>
              ₦{savingsPlan.currentBalance.toLocaleString('en-NG')} Savings
            </h1>
            <p className='text-xs text-muted-foreground mt-0.5'>
              ID: #{savingsPlan.id.toUpperCase()}
            </p>
          </div>

          <div className='flex flex-wrap gap-3'>
            <Button
              onClick={() => setDepositOpen(true)}
              disabled={
                savingsPlan.status === 'WITHDRAWN' ||
                savingsPlan.status === 'EARLY_WITHDRAWAL'
              }
              className='cursor-pointer rounded-sm bg-primary text-on-primary hover:bg-primary/95 flex items-center justify-center gap-1.5 h-10 px-5 shadow-sm font-semibold'
            >
              <Upload className='w-4 h-4' />
              <span>Deposit Savings</span>
            </Button>

            <Button
              onClick={() => setWithdrawOpen(true)}
              disabled={savingsPlan.status !== 'ACTIVE'}
              variant='outline'
              className='cursor-pointer rounded-sm border-outline-variant text-primary hover:bg-surface-container-low flex items-center justify-center gap-1.5 h-10 px-5 font-semibold'
            >
              <CircleDollarSign className='w-4 h-4' />
              <span>Withdraw Plan</span>
            </Button>
          </div>
        </div>

        {/* Progress Bar (Maturity term progress) */}
        {savingsPlan.status === 'ACTIVE' &&
          savingsPlan.startDate &&
          savingsPlan.maturityDate && (
            <div className='mt-8 pt-4 border-t border-outline-variant/20'>
              <div className='flex justify-between items-center text-xs text-muted-foreground mb-2'>
                <span className='flex items-center gap-1 font-semibold'>
                  <Calendar className='w-3.5 h-3.5' />
                  <span>Plan Maturity Duration</span>
                </span>
                <span className='font-bold text-primary'>
                  {daysRemaining > 0
                    ? `${daysRemaining} days remaining`
                    : 'Matured! Collect Yield'}
                </span>
              </div>
              <div className='w-full bg-outline-variant/35 rounded-full h-2'>
                <div
                  className='bg-success-green h-2 rounded-full transition-all duration-300'
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className='flex justify-between text-[10px] text-muted-foreground mt-1.5 font-mono'>
                <span>
                  Start: {new Date(savingsPlan.startDate).toLocaleDateString()}
                </span>
                <span>{progressPct.toFixed(0)}% Time Complete</span>
                <span>
                  Matures:{' '}
                  {new Date(savingsPlan.maturityDate).toLocaleDateString()}
                </span>
              </div>
            </div>
          )}
      </div>

      {/* Plan Metrics grid */}
      <section className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4'>
        <Card className='border-0 bg-surface-container rounded-md shadow-none p-5 flex flex-col justify-between min-h-25'>
          <span className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold'>
            Commitment Amount
          </span>
          <span className='text-xl font-extrabold text-primary font-mono mt-1'>
            {savingsPlan.targetAmount
              ? formatCurrency(savingsPlan.targetAmount)
              : 'Flexible'}
          </span>
        </Card>

        <Card className='border-0 bg-surface-container rounded-md shadow-none p-5 flex flex-col justify-between min-h-25'>
          <span className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold'>
            Savings Interval
          </span>
          <span className='text-xl font-extrabold text-primary font-mono mt-1'>
            {savingsPlan.frequency || 'N/A'}
          </span>
        </Card>

        <Card className='border-0 bg-surface-container rounded-md shadow-none p-5 flex flex-col justify-between min-h-25'>
          <span className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold'>
            Total Deposited
          </span>
          <span className='text-xl font-extrabold text-primary font-mono mt-1'>
            {formatCurrency(savingsPlan.totalDeposited)}
          </span>
        </Card>

        <Card className='border-0 bg-surface-container rounded-md shadow-none p-5 flex flex-col justify-between min-h-25'>
          <span className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold'>
            Accrued Interest Rate
          </span>
          <span className='text-xl font-extrabold text-success-green font-mono mt-1'>
            +{savingsPlan.interestRate}%
          </span>
        </Card>

        <Card className='border-0 bg-surface-container rounded-md shadow-none p-5 flex flex-col justify-between min-h-25'>
          <span className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold'>
            Earned Accrued Interest
          </span>
          <span className='text-xl font-extrabold text-success-green font-mono mt-1'>
            {formatCurrency(savingsPlan.accruedInterest)}
          </span>
        </Card>

        <Card className='border-0 bg-surface-container rounded-md shadow-none p-5 flex flex-col justify-between min-h-25'>
          <span className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold'>
            Expected Maturity Amount
          </span>
          <span className='text-xl font-extrabold text-primary font-mono mt-1'>
            {savingsPlan.expectedMaturityAmount
              ? formatCurrency(savingsPlan.expectedMaturityAmount)
              : 'Flexible'}
          </span>
        </Card>
      </section>

      {/* bank account routing details */}
      <section className='bg-surface-container-lowest border border-outline-variant/10 rounded-xl p-5 flex flex-col gap-3'>
        <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
          Payout Bank Account Details
        </h3>
        <div className='grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs'>
          <div className='bg-surface-container-low rounded-md p-3 border border-outline-variant/10'>
            <span className='text-muted-foreground block mb-0.5'>
              Bank Name
            </span>
            <span className='font-semibold text-primary'>
              {savingsPlan.bankName}
            </span>
          </div>
          <div className='bg-surface-container-low rounded-md p-3 border border-outline-variant/10'>
            <span className='text-muted-foreground block mb-0.5'>
              Account Number
            </span>
            <span className='font-bold text-primary font-mono'>
              {savingsPlan.accountNumber}
            </span>
          </div>
          <div className='bg-surface-container-low rounded-md p-3 border border-outline-variant/10'>
            <span className='text-muted-foreground block mb-0.5'>
              Account Name
            </span>
            <span className='font-semibold text-primary'>
              {savingsPlan.accountName}
            </span>
          </div>
        </div>
      </section>

      {/* Transactions ledger history table */}
      <section className='flex flex-col gap-3'>
        <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
          Transaction Ledger
        </h3>
        {savingsPlan.transactions.length === 0 ? (
          <div className='border border-dashed border-outline-variant/30 rounded-lg py-12 text-center text-xs text-muted-foreground font-medium bg-surface-container-lowest'>
            No transactions found for this savings plan.
          </div>
        ) : (
          <div className='bg-surface-container-lowest border border-outline-variant/10 rounded-xl overflow-hidden shadow-sm'>
            <div className='overflow-x-auto'>
              <table className='w-full text-xs text-left border-collapse'>
                <thead>
                  <tr className='bg-surface-container border-b border-outline-variant/20 text-muted-foreground font-semibold'>
                    <th className='p-3'>Date</th>
                    <th className='p-3'>Reference / Category</th>
                    <th className='p-3 text-right'>Amount</th>
                    <th className='p-3'>Status</th>
                    <th className='p-3 text-center'>Receipt</th>
                  </tr>
                </thead>
                <tbody className='divide-y divide-outline-variant/15'>
                  {savingsPlan.transactions.map((tx) => (
                    <tr
                      key={tx.id}
                      className='hover:bg-surface-container-low transition-colors'
                    >
                      <td className='p-3 text-muted-foreground whitespace-nowrap'>
                        {new Date(tx.createdAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </td>
                      <td className='p-3'>
                        <div className='flex flex-col gap-0.5'>
                          <span className='font-semibold text-primary'>
                            {tx.category.replace('_', ' ')}
                          </span>
                          {tx.referenceNumber && (
                            <span className='text-[10px] text-muted-foreground font-mono'>
                              Ref: {tx.referenceNumber}
                            </span>
                          )}
                          {tx.status === 'REJECTED' && tx.rejectionReason && (
                            <span className='text-[10px] text-error mt-1 italic max-w-xs wrap-break-word'>
                              Reason: {tx.rejectionReason}
                            </span>
                          )}
                        </div>
                      </td>
                      <td
                        className={`p-3 text-right font-bold font-mono ${tx.type === 'DEPOSIT' ? 'text-primary' : 'text-secondary'}`}
                      >
                        {tx.type === 'DEPOSIT' ? '+' : '-'}
                        {formatCurrency(tx.amount)}
                      </td>
                      <td className='p-3 whitespace-nowrap'>
                        <StatusPill status={tx.status} />
                      </td>
                      <td className='p-3 text-center'>
                        {tx.receiptUrl ? (
                          <Button
                            onClick={() => openLightbox(tx.receiptUrl!)}
                            variant='ghost'
                            size='icon'
                            className='cursor-pointer text-primary hover:bg-light-blue w-7 h-7 rounded-sm'
                          >
                            <Eye className='w-4 h-4' />
                          </Button>
                        ) : (
                          <span className='text-muted-foreground text-[10px] italic'>
                            N/A
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* 1. Deposit Savings Dialog */}
      <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
        <DialogContent className='max-w-md bg-surface rounded-md p-6 border-0 shadow-lg'>
          <DialogHeader className='pb-3 border-b border-outline-variant/20 mb-4'>
            <DialogTitle className='text-primary font-bold text-base flex items-center gap-2'>
              <Upload className='w-5 h-5 text-secondary' />
              <span>Deposit Savings Contribution</span>
            </DialogTitle>
          </DialogHeader>

          {depositSuccess ? (
            <div className='py-8 flex flex-col items-center justify-center text-center gap-3 animate-in fade-in duration-200'>
              <CheckCircle className='w-12 h-12 text-success-green' />
              <h3 className='font-bold text-sm text-primary'>
                Receipt Submitted Successfully
              </h3>
              <p className='text-muted-foreground text-xs'>
                Your deposit is pending administrative reconciliation review.
              </p>
            </div>
          ) : (
            <form
              onSubmit={handleDepositSubmit}
              className='flex flex-col gap-4'
            >
              <div className='flex flex-col gap-1.5'>
                <Label
                  htmlFor='depAmount'
                  className='text-xs font-semibold text-muted-foreground'
                >
                  Deposit Amount (₦)
                </Label>
                <Input
                  id='depAmount'
                  type='number'
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(Number(e.target.value))}
                  disabled={savingsPlan.savingsType === 'FIXED'}
                  className='rounded-sm h-10 border-outline-variant/35 font-mono text-sm'
                />
                {savingsPlan.savingsType === 'FIXED' && (
                  <p className='text-[10px] text-muted-foreground leading-normal'>
                    * Bulk Fixed deposit amount is locked in for the term.
                  </p>
                )}
              </div>

              {/* Receipt dropzone uploader */}
              <div className='flex flex-col gap-1.5'>
                <Label className='text-xs font-semibold text-muted-foreground'>
                  Upload Transfer Receipt (Image/PDF)
                </Label>
                <ReceiptDropzone
                  onFileSelected={setReceiptFile}
                  value={receiptFile}
                  maxSizeMb={5}
                  error={depositError || undefined}
                />
              </div>

              <div className='flex flex-col gap-1.5'>
                <Label
                  htmlFor='depositRef'
                  className='text-xs font-semibold text-muted-foreground'
                >
                  Bank Reference Number (Optional)
                </Label>
                <Input
                  id='depositRef'
                  placeholder='e.g. Transaction ID, transfer reference'
                  value={refNo}
                  onChange={(e) => setRefNo(e.target.value)}
                  className='rounded-sm h-10 border-outline-variant/35 text-xs'
                />
              </div>

              <div className='flex flex-col gap-1.5'>
                <Label
                  htmlFor='depositNotes'
                  className='text-xs font-semibold text-muted-foreground'
                >
                  Notes / Comments (Optional)
                </Label>
                <Textarea
                  id='depositNotes'
                  placeholder='Add any extra comments...'
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  className='rounded-sm border-outline-variant/35 text-xs'
                />
              </div>

              {depositError && (
                <div className='bg-error-container/10 border border-error-container/30 text-error p-3 rounded-lg flex items-start gap-2 text-xs'>
                  <AlertCircle className='w-4 h-4 shrink-0 mt-0.5' />
                  <span>{depositError}</span>
                </div>
              )}

              <div className='flex gap-3 justify-end mt-2 pt-3 border-t border-outline-variant/20'>
                <Button
                  type='button'
                  variant='ghost'
                  disabled={isPending}
                  onClick={() => setDepositOpen(false)}
                  className='cursor-pointer text-muted-foreground hover:bg-surface-container text-xs h-9 rounded-sm px-4'
                >
                  Cancel
                </Button>
                <Button
                  type='submit'
                  disabled={isPending || !receiptFile}
                  className='cursor-pointer rounded-sm bg-primary text-on-primary hover:bg-primary/95 text-xs h-9 px-5 shadow-sm font-semibold'
                >
                  {isPending ? 'Submitting...' : 'Submit Deposit'}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* 2. Withdrawal Request Dialog (Forfeiture validation modal) */}
      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent className='max-w-md bg-surface rounded-md p-6 border-0 shadow-lg'>
          <DialogHeader className='pb-3 border-b border-outline-variant/20 mb-4'>
            <DialogTitle className='text-primary font-bold text-base flex items-center gap-2'>
              <AlertTriangle className='w-5 h-5 text-secondary' />
              <span>Withdraw Savings Plan</span>
            </DialogTitle>
          </DialogHeader>

          {withdrawSuccess ? (
            <div className='py-8 flex flex-col items-center justify-center text-center gap-3 animate-in fade-in duration-200'>
              <CheckCircle className='w-12 h-12 text-success-green' />
              <h3 className='font-bold text-sm text-primary'>
                Withdrawal Requested
              </h3>
              <p className='text-muted-foreground text-xs'>
                Your request is pending in the admin disbursement queue.
              </p>
            </div>
          ) : (
            <form
              onSubmit={handleWithdrawSubmit}
              className='flex flex-col gap-4'
            >
              {isEarly ? (
                // Early Withdrawal Warning (PRD Rule §8.3.2)
                <div className='bg-error-container/10 border border-error-container/30 rounded-lg p-4 flex flex-col gap-2'>
                  <div className='flex items-start gap-2 text-error text-xs font-bold uppercase tracking-wide'>
                    <AlertTriangle className='w-5 h-5 shrink-0 mt-0.5' />
                    <span>⚠️ Interest Forfeiture Alert</span>
                  </div>
                  <p className='text-xs text-muted-foreground leading-relaxed mt-1'>
                    You are withdrawing your savings plan before the maturity
                    date of{' '}
                    <span className='font-bold text-primary'>
                      {savingsPlan.maturityDate
                        ? new Date(
                            savingsPlan.maturityDate,
                          ).toLocaleDateString()
                        : 'N/A'}
                    </span>
                    .
                  </p>
                  <p className='text-xs text-error font-semibold leading-relaxed'>
                    By proceeding, you will forfeit 100% of your accrued
                    interest ({formatCurrency(savingsPlan.accruedInterest)}).
                    You will only receive your principal amount:{' '}
                    {formatCurrency(savingsPlan.currentBalance)}.
                  </p>

                  <label className='flex items-start gap-2.5 mt-3 cursor-pointer select-none'>
                    <input
                      type='checkbox'
                      checked={withdrawConfirm}
                      onChange={(e) => setWithdrawConfirm(e.target.checked)}
                      className='w-4 h-4 text-primary border-outline-variant/30 rounded-sm mt-0.5 focus:ring-primary cursor-pointer'
                    />
                    <span className='text-[11px] text-muted-foreground font-semibold leading-snug'>
                      I acknowledge and accept 100% forfeiture of my accrued
                      interest.
                    </span>
                  </label>
                </div>
              ) : (
                // Matured withdrawal information
                <div className='bg-success-green/10 border border-success-green/20 rounded-lg p-4 flex flex-col gap-1'>
                  <h4 className='text-xs font-bold text-primary flex items-center gap-1'>
                    <ShieldCheck className='w-4.5 h-4.5 text-success-green' />
                    <span>Matured Plan Payout</span>
                  </h4>
                  <p className='text-xs text-muted-foreground leading-relaxed mt-1'>
                    Your savings plan has reached maturity. You will collect
                    your principal plus full accrued interest:
                  </p>
                  <div className='flex flex-col gap-1 mt-2 text-xs border-t border-outline-variant/20 pt-2 font-mono'>
                    <div className='flex justify-between'>
                      <span className='text-muted-foreground'>Principal:</span>
                      <span className='font-semibold text-primary'>
                        {formatCurrency(savingsPlan.currentBalance)}
                      </span>
                    </div>
                    <div className='flex justify-between'>
                      <span className='text-muted-foreground'>
                        Accrued Interest:
                      </span>
                      <span className='font-semibold text-success-green'>
                        +{formatCurrency(savingsPlan.accruedInterest)}
                      </span>
                    </div>
                    <div className='flex justify-between border-t border-dashed border-outline-variant/30 pt-1 font-bold'>
                      <span className='text-primary font-sans text-[10px] uppercase font-bold'>
                        Total Disbursement:
                      </span>
                      <span className='text-success-green'>
                        {formatCurrency(
                          savingsPlan.currentBalance +
                            savingsPlan.accruedInterest,
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <div className='flex flex-col gap-1.5'>
                <Label
                  htmlFor='withdrawNotes'
                  className='text-xs font-semibold text-muted-foreground'
                >
                  Reason for withdrawal (Optional)
                </Label>
                <Textarea
                  id='withdrawNotes'
                  placeholder='e.g. Funding inventory purchase...'
                  value={withdrawNotes}
                  onChange={(e) => setWithdrawNotes(e.target.value)}
                  rows={2}
                  className='rounded-sm border-outline-variant/35 text-xs'
                />
              </div>

              {withdrawError && (
                <div className='bg-error-container/10 border border-error-container/30 text-error p-3 rounded-lg flex items-start gap-2 text-xs'>
                  <AlertCircle className='w-4 h-4 shrink-0 mt-0.5' />
                  <span>{withdrawError}</span>
                </div>
              )}

              <div className='flex gap-3 justify-end mt-2 pt-3 border-t border-outline-variant/20'>
                <Button
                  type='button'
                  variant='ghost'
                  disabled={isPending}
                  onClick={() => setWithdrawOpen(false)}
                  className='cursor-pointer text-muted-foreground hover:bg-surface-container text-xs h-9 rounded-sm px-4'
                >
                  Cancel
                </Button>
                <Button
                  type='submit'
                  disabled={isPending || (isEarly && !withdrawConfirm)}
                  className='cursor-pointer rounded-sm bg-primary text-on-primary hover:bg-primary/95 text-xs h-9 px-5 shadow-sm font-semibold'
                >
                  {isPending ? 'Processing...' : 'Confirm Withdrawal'}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* 3. Zoomable Receipt Modal Lightbox */}
      <ReceiptLightbox
        url={selectedReceiptUrl}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
      />
    </div>
  )
}
export default SavingsDetailsClient
