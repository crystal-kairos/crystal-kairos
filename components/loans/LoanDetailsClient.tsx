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
  AlertCircle,
  FileText,
  Eye,
  CheckCircle,
  Briefcase,
  Users,
  XCircle,
  Loader2,
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
  submitLoanRepaymentAction,
  acceptLoanOfferAction,
  declineLoanOfferAction,
} from '@/models/loans/actions'
import { uploadReceiptAction } from '@/models/eajo/actions'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

interface Transaction {
  id: string
  amount: number
  category: string
  type: string
  status: string
  receiptUrl: string | null
  referenceNumber: string | null
  notes: string | null
  createdAt: any
}

interface Installment {
  installmentNumber: number
  dueDate: any
  principalAmount: number
  interestAmount: number
  totalAmount: number
  status: 'PAID' | 'PENDING' | 'OVERDUE'
}

interface LoanPlan {
  id: string
  requestedAmount: number
  approvedAmount: number | null
  interestRate: number
  duration: number
  purpose: string
  guarantorId: string | null
  guarantorName: string | null
  guarantorPhoneNumber: string | null
  collateralDetails: string | null
  applicationFee: number
  outstandingBalance: number
  totalRepaid: number
  defaultPenalty: number
  status: string
  disbursedAt: any
  repaymentEndDate?: any
  rejectionReason?: string
  computedPenaltyAmount?: number
  user: {
    id: string
    name: string
    email: string
  }
  transactions: Transaction[]
  schedule: Installment[]
}

interface LoanDetailsClientProps {
  userId: string
  loan: LoanPlan
}

export const LoanDetailsClient = ({ userId, loan }: LoanDetailsClientProps) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Modal / Lightbox states
  const [repayOpen, setRepayOpen] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [selectedReceiptUrl, setSelectedReceiptUrl] = useState<string | null>(
    null,
  )

  // Form states (Repayment)
  const [repayAmount, setRepayAmount] = useState<number>(
    loan.schedule.find((i) => i.status !== 'PAID')?.totalAmount || 10000,
  )
  const [receiptFile, setReceiptFile] = useState<File | null>(null)
  const [refNo, setRefNo] = useState('')
  const [notes, setNotes] = useState('')
  const [repayError, setRepayError] = useState<string | null>(null)
  const [repaySuccess, setRepaySuccess] = useState(false)

  // Decline states
  const [declineOpen, setDeclineOpen] = useState(false)
  const [declineReason, setDeclineReason] = useState('')
  const [declineError, setDeclineError] = useState<string | null>(null)

  const handleAcceptOffer = () => {
    startTransition(async () => {
      const res = await acceptLoanOfferAction(userId, loan.id)
      if (res.success) {
        toast.success('Loan offer accepted successfully!')
        router.refresh()
      } else {
        toast.error(res.error || 'Failed to accept loan offer.')
      }
    })
  }

  const handleDeclineSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!declineReason.trim()) {
      setDeclineError('Please provide a reason for declining the offer.')
      return
    }
    setDeclineError(null)
    startTransition(async () => {
      const res = await declineLoanOfferAction(userId, loan.id, declineReason)
      if (res.success) {
        toast.success('Loan offer declined.')
        setDeclineOpen(false)
        router.refresh()
      } else {
        setDeclineError(res.error || 'Failed to decline loan offer.')
      }
    })
  }

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 0,
    }).format(val)
  }

  // Calculate repayment progress
  const approvedAmt = loan.approvedAmount || loan.requestedAmount
  const totalInterest = (approvedAmt * loan.interestRate * loan.duration) / 100
  const penaltyAmt = loan.computedPenaltyAmount || 0
  const totalDebt = approvedAmt + totalInterest + penaltyAmt
  const progressPct = Math.min(
    100,
    Math.max(0, (loan.totalRepaid / totalDebt) * 100),
  )

  const getAlertStatus = () => {
    if (
      !loan.repaymentEndDate ||
      (loan.status !== 'ACTIVE' &&
        loan.status !== 'OVERDUE' &&
        loan.status !== 'DEFAULTED')
    )
      return null

    const now = new Date()
    const dueDate = new Date(loan.repaymentEndDate)
    const diffTime = dueDate.getTime() - now.getTime()
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

    if (diffDays <= 7 && diffDays >= 0) {
      return {
        type: 'WARNING',
        message: `Your loan due date is approaching in ${diffDays} day(s). Please prepare for repayment.`,
      }
    } else if (diffDays < 0) {
      const pastDays = Math.abs(diffDays)
      if (pastDays <= 3) {
        return {
          type: 'CAUTION',
          message: `Your loan due date has passed! You have ${3 - pastDays} day(s) of grace period left before daily penalties begin.`,
        }
      } else {
        return {
          type: 'CAUTION_PENALTY',
          message: `Your loan is overdue! A daily penalty is now being applied. Current penalty amount: ${formatCurrency(penaltyAmt)}.`,
        }
      }
    }
    return null
  }

  const alertStatus = getAlertStatus()

  const handleRepaySubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (repayAmount <= 0) {
      setRepayError('Please enter a valid repayment amount.')
      return
    }
    if (!receiptFile) {
      setRepayError('Please select or upload a payment receipt file.')
      return
    }

    setRepayError(null)
    setRepaySuccess(false)

    startTransition(async () => {
      // 1. Upload receipt to Cloudinary
      const uploadFormData = new FormData()
      uploadFormData.append('file', receiptFile)

      const uploadRes = await uploadReceiptAction(uploadFormData)
      if (!uploadRes.success || !uploadRes.url) {
        setRepayError(
          uploadRes.error || 'Failed to upload receipt file to storage.',
        )
        return
      }

      // 2. Submit repayment transaction
      const res = await submitLoanRepaymentAction(userId, {
        loanId: loan.id,
        amount: repayAmount,
        receiptUrl: uploadRes.url,
        referenceNumber: refNo.trim() || undefined,
        notes: notes.trim() || undefined,
      })

      if (res.success) {
        setRepaySuccess(true)
        setReceiptFile(null)
        setRefNo('')
        setNotes('')
        setTimeout(() => {
          setRepaySuccess(false)
          setRepayOpen(false)
          router.refresh()
        }, 1500)
      } else {
        setRepayError(res.error || 'Failed to submit loan repayment receipt.')
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
        <Link href={`/dashboard/${userId}/loans`}>Back to Borrowing Hub</Link>
      </div>

      {/* Alerts */}
      {alertStatus && (
        <div
          className={`p-4 rounded-xl border flex gap-3 ${
            alertStatus.type === 'WARNING'
              ? 'bg-amber-50 border-amber-200 text-amber-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          <AlertTriangle className='w-5 h-5 shrink-0 mt-0.5' />
          <div>
            <h4 className='font-bold text-sm mb-1'>
              {alertStatus.type === 'WARNING'
                ? 'Upcoming Due Date'
                : 'Action Required: Loan Overdue'}
            </h4>
            <p className='text-xs'>{alertStatus.message}</p>
          </div>
        </div>
      )}

      {(loan.status === 'REJECTED' || loan.status === 'DECLINED') &&
        loan.rejectionReason && (
          <div className='bg-red-50 border-red-200 text-red-800 p-4 rounded-xl border flex gap-3'>
            <XCircle className='w-5 h-5 shrink-0 mt-0.5' />
            <div>
              <h4 className='font-bold text-sm mb-1'>
                Application{' '}
                {loan.status === 'DECLINED' ? 'Declined by You' : 'Rejected'}
              </h4>
              <p className='text-xs'>{loan.rejectionReason}</p>
            </div>
          </div>
        )}

      {/* Loan Header */}
      <div className='bg-surface-container-lowest border border-outline-variant/10 rounded-xl p-6 md:p-8 relative overflow-hidden'>
        <div className='flex flex-col md:flex-row justify-between items-start md:items-center gap-6 relative z-10'>
          <div className='flex flex-col gap-2'>
            <div className='inline-flex items-center gap-2'>
              <span className='px-3 py-1 bg-light-blue text-primary rounded-full text-[10px] font-bold tracking-wider uppercase'>
                COOPERATIVE LOAN RECORD
              </span>
              <StatusPill status={loan.status} />
            </div>
            <h1 className='text-2xl font-bold text-primary font-heading leading-tight'>
              ₦{loan.outstandingBalance.toLocaleString('en-NG')} Outstanding
            </h1>
            <p className='text-xs text-muted-foreground mt-0.5'>
              ID: #{loan.id.toUpperCase()}
            </p>
          </div>

          <div className='flex flex-wrap gap-3'>
            {loan.status === 'APPROVED' ? (
              <>
                <Button
                  onClick={() => setDeclineOpen(true)}
                  variant='outline'
                  disabled={isPending}
                  className='rounded-sm h-10 px-5 shadow-sm font-semibold text-error hover:text-error hover:bg-error/10 border-error/20'
                >
                  Decline Offer
                </Button>
                <Button
                  onClick={handleAcceptOffer}
                  disabled={isPending}
                  className='rounded-sm bg-success text-on-success hover:bg-success-green/90 flex items-center justify-center gap-1.5 h-10 px-5 shadow-sm font-semibold'
                >
                  {isPending ? (
                    <Loader2 className='w-4 h-4 animate-spin' />
                  ) : (
                    <CheckCircle className='w-4 h-4' />
                  )}
                  <span>Accept Offer</span>
                </Button>
              </>
            ) : (
              <Button
                onClick={() => setRepayOpen(true)}
                disabled={
                  loan.status !== 'ACTIVE' &&
                  loan.status !== 'OVERDUE' &&
                  loan.status !== 'DEFAULTED'
                }
                className='cursor-pointer rounded-sm bg-primary text-on-primary hover:bg-primary/95 flex items-center justify-center gap-1.5 h-10 px-5 shadow-sm font-semibold'
              >
                <Upload className='w-4 h-4' />
                <span>Upload Repayment Receipt</span>
              </Button>
            )}
          </div>
        </div>

        {/* Progress Bar (Repayment completion progress) */}
        {(loan.status === 'ACTIVE' ||
          loan.status === 'OVERDUE' ||
          loan.status === 'COMPLETED' ||
          loan.status === 'DEFAULTED') && (
          <div className='mt-8 pt-4 border-t border-outline-variant/20'>
            <div className='flex justify-between items-center text-xs text-muted-foreground mb-2'>
              <span className='flex items-center gap-1 font-semibold'>
                <Briefcase className='w-3.5 h-3.5' />
                <span>Loan Repayment Completion</span>
              </span>
              <span className='font-bold text-primary font-mono'>
                {formatCurrency(loan.totalRepaid)} Repaid of{' '}
                {formatCurrency(totalDebt)}
              </span>
            </div>
            <div className='w-full bg-outline-variant/35 rounded-full h-2'>
              <div
                className='bg-success h-2 rounded-full transition-all duration-300'
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className='flex justify-between text-[10px] text-muted-foreground mt-1.5 font-mono'>
              <span>{progressPct.toFixed(0)}% Repayment Completed</span>
              <span>
                Remaining:{' '}
                {formatCurrency(Math.max(0, totalDebt - loan.totalRepaid))}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Loan Metrics Grid */}
      <section className='grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4'>
        <Card className='border-0 bg-surface-container rounded-md shadow-none p-5 flex flex-col justify-between min-h-25'>
          <span className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold'>
            Approved Principal
          </span>
          <span className='text-xl font-extrabold text-primary font-mono mt-1'>
            {formatCurrency(approvedAmt)}
          </span>
        </Card>

        <Card className='border-0 bg-surface-container rounded-md shadow-none p-5 flex flex-col justify-between min-h-25'>
          <span className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold'>
            Monthly Interest Rate
          </span>
          <span className='text-xl font-extrabold text-primary font-mono mt-1'>
            {loan.interestRate}% / Month
          </span>
        </Card>

        <Card className='border-0 bg-surface-container rounded-md shadow-none p-5 flex flex-col justify-between min-h-25'>
          <span className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold'>
            Repayment Term
          </span>
          <span className='text-xl font-extrabold text-primary font-mono mt-1'>
            {loan.duration} Months
          </span>
        </Card>

        <Card
          className={`border-0 rounded-md shadow-none p-5 flex flex-col justify-between min-h-25 ${penaltyAmt > 0 ? 'bg-red-50 text-red-800' : 'bg-surface-container'}`}
        >
          <span
            className={`text-[10px] uppercase tracking-wider font-semibold ${penaltyAmt > 0 ? 'text-red-600' : 'text-muted-foreground'}`}
          >
            Accrued Penalty
          </span>
          <span
            className={`text-xl font-extrabold font-mono mt-1 ${penaltyAmt > 0 ? 'text-red-700' : 'text-secondary'}`}
          >
            {formatCurrency(penaltyAmt)}
          </span>
        </Card>
      </section>

      {/* Guarantor / Collateral metadata */}
      <section className='bg-surface-container-lowest border border-outline-variant/10 rounded-xl p-5 flex flex-col gap-3'>
        <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
          Nominated Guarantor / Collateral
        </h3>
        <div className='grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs'>
          {loan.guarantorName ? (
            <div className='bg-surface-container-low rounded-md p-4 border border-outline-variant/10 flex items-start gap-3'>
              <Users className='w-5 h-5 text-primary shrink-0 mt-0.5' />
              <div>
                <span className='text-muted-foreground block mb-0.5'>
                  Cooperative Guarantor
                </span>
                <span className='font-bold text-primary text-sm'>
                  {loan.guarantorName}
                </span>
                {loan.guarantorPhoneNumber && (
                  <span className='text-muted-foreground block mt-1 font-mono'>
                    {loan.guarantorPhoneNumber}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className='bg-surface-container-low rounded-md p-4 border border-outline-variant/10 flex items-start gap-3'>
              <AlertTriangle className='w-5 h-5 text-secondary shrink-0 mt-0.5' />
              <div>
                <span className='text-muted-foreground block mb-0.5'>
                  Securing Collateral Details
                </span>
                <span className='font-semibold text-primary leading-normal'>
                  {loan.collateralDetails || 'None nominated'}
                </span>
              </div>
            </div>
          )}

          <div className='bg-surface-container-low rounded-md p-4 border border-outline-variant/10 flex items-start gap-3'>
            <Info className='w-5 h-5 text-primary shrink-0 mt-0.5' />
            <div>
              <span className='text-muted-foreground block mb-0.5'>
                Loan Purpose Description
              </span>
              <span className='font-semibold text-primary leading-normal'>
                {loan.purpose}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Amortization installments list */}
      {(loan.status === 'ACTIVE' ||
        loan.status === 'OVERDUE' ||
        loan.status === 'COMPLETED' ||
        loan.status === 'DEFAULTED') && (
        <section className='flex flex-col gap-3'>
          <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
            Repayment Installments Schedule
          </h3>
          <div className='bg-surface-container-lowest border border-outline-variant/10 rounded-xl overflow-hidden shadow-sm'>
            <div className='overflow-x-auto'>
              <table className='w-full text-xs text-left border-collapse'>
                <thead>
                  <tr className='bg-surface-container border-b border-outline-variant/20 text-muted-foreground font-semibold'>
                    <th className='p-3'>Installment</th>
                    <th className='p-3'>Due Date</th>
                    <th className='p-3 text-right'>Principal</th>
                    <th className='p-3 text-right'>Interest</th>
                    <th className='p-3 text-right'>Total Installment</th>
                    <th className='p-3 text-center'>Status</th>
                  </tr>
                </thead>
                <tbody className='divide-y divide-outline-variant/15 font-mono'>
                  {loan.schedule.map((inst) => (
                    <tr
                      key={inst.installmentNumber}
                      className='hover:bg-surface-container-low transition-colors'
                    >
                      <td className='p-3 text-primary font-sans font-bold'>
                        Month 0{inst.installmentNumber}
                      </td>
                      <td className='p-3 text-muted-foreground whitespace-nowrap'>
                        {new Date(inst.dueDate).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </td>
                      <td className='p-3 text-right text-muted-foreground'>
                        {formatCurrency(inst.principalAmount)}
                      </td>
                      <td className='p-3 text-right text-success-green'>
                        +{formatCurrency(inst.interestAmount)}
                      </td>
                      <td className='p-3 text-right font-bold text-primary'>
                        {formatCurrency(inst.totalAmount)}
                      </td>
                      <td className='p-3 text-center whitespace-nowrap'>
                        <span
                          className={`px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border ${
                            inst.status === 'PAID'
                              ? 'bg-light-green text-success-green border-success-green/20'
                              : inst.status === 'OVERDUE'
                                ? 'bg-error-container/10 text-error border-error-container/20'
                                : 'bg-warning-container/10 text-warning-amber border-warning-container/20'
                          }`}
                        >
                          {inst.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* Transactions Repayments list */}
      <section className='flex flex-col gap-3'>
        <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
          Repayments History
        </h3>
        {loan.transactions.length === 0 ? (
          <div className='border border-dashed border-outline-variant/30 rounded-lg py-12 text-center text-xs text-muted-foreground font-medium bg-surface-container-lowest'>
            No repayment transaction receipts submitted yet.
          </div>
        ) : (
          <div className='bg-surface-container-lowest border border-outline-variant/10 rounded-xl overflow-hidden shadow-sm'>
            <div className='overflow-x-auto'>
              <table className='w-full text-xs text-left border-collapse'>
                <thead>
                  <tr className='bg-surface-container border-b border-outline-variant/20 text-muted-foreground font-semibold'>
                    <th className='p-3'>Repayment Date</th>
                    <th className='p-3'>Reference / Notes</th>
                    <th className='p-3 text-right'>Repayment Amount</th>
                    <th className='p-3'>Status</th>
                    <th className='p-3 text-center'>Receipt</th>
                  </tr>
                </thead>
                <tbody className='divide-y divide-outline-variant/15'>
                  {loan.transactions.map((tx) => (
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
                        </div>
                      </td>
                      <td className='p-3 text-right font-bold font-mono text-secondary'>
                        -{formatCurrency(tx.amount)}
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

      {/* 1. Upload Repayment Receipt Dialog */}
      <Dialog open={repayOpen} onOpenChange={setRepayOpen}>
        <DialogContent className='max-w-md bg-surface rounded-md p-6 border-0 shadow-lg'>
          <DialogHeader className='pb-3 border-b border-outline-variant/20 mb-4'>
            <DialogTitle className='text-primary font-bold text-base flex items-center gap-2'>
              <Upload className='w-5 h-5 text-secondary' />
              <span>Upload Repayment Receipt</span>
            </DialogTitle>
          </DialogHeader>

          {repaySuccess ? (
            <div className='py-8 flex flex-col items-center justify-center text-center gap-3 animate-in fade-in duration-200'>
              <CheckCircle className='w-12 h-12 text-success-green' />
              <h3 className='font-bold text-sm text-primary'>
                Repayment Receipt Submitted
              </h3>
              <p className='text-muted-foreground text-xs'>
                Your proof of repayment has been logged and is pending admin
                review.
              </p>
            </div>
          ) : (
            <form onSubmit={handleRepaySubmit} className='flex flex-col gap-4'>
              <div className='flex flex-col gap-1.5'>
                <Label
                  htmlFor='repAmount'
                  className='text-xs font-semibold text-muted-foreground'
                >
                  Repayment Amount (₦)
                </Label>
                <Input
                  id='repAmount'
                  type='number'
                  value={repayAmount}
                  onChange={(e) => setRepayAmount(Number(e.target.value))}
                  className='rounded-sm h-10 border-outline-variant/35 font-mono text-sm'
                />
              </div>

              {/* Receipt dropzone uploader */}
              <div className='flex flex-col gap-1.5'>
                <Label className='text-xs font-semibold text-muted-foreground'>
                  Upload Payment Receipt (Image/PDF)
                </Label>
                <ReceiptDropzone
                  onFileSelected={setReceiptFile}
                  value={receiptFile}
                  maxSizeMb={5}
                  error={repayError || undefined}
                />
              </div>

              <div className='flex flex-col gap-1.5'>
                <Label
                  htmlFor='repayRef'
                  className='text-xs font-semibold text-muted-foreground'
                >
                  Bank Reference Number (Optional)
                </Label>
                <Input
                  id='repayRef'
                  placeholder='e.g. Transaction ID, transfer reference'
                  value={refNo}
                  onChange={(e) => setRefNo(e.target.value)}
                  className='rounded-sm h-10 border-outline-variant/35 text-xs'
                />
              </div>

              <div className='flex flex-col gap-1.5'>
                <Label
                  htmlFor='repayNotes'
                  className='text-xs font-semibold text-muted-foreground'
                >
                  Notes / Comments (Optional)
                </Label>
                <Textarea
                  id='repayNotes'
                  placeholder='Add any details regarding this repayment...'
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  className='rounded-sm border-outline-variant/35 text-xs'
                />
              </div>

              {repayError && (
                <div className='bg-error-container/10 border border-error-container/30 text-error p-3 rounded-lg flex items-start gap-2 text-xs'>
                  <AlertCircle className='w-4 h-4 shrink-0 mt-0.5' />
                  <span>{repayError}</span>
                </div>
              )}

              <div className='flex gap-3 justify-end mt-2 pt-3 border-t border-outline-variant/20'>
                <Button
                  type='button'
                  variant='ghost'
                  disabled={isPending}
                  onClick={() => setRepayOpen(false)}
                  className='cursor-pointer text-muted-foreground hover:bg-surface-container text-xs h-9 rounded-sm px-4'
                >
                  Cancel
                </Button>
                <Button
                  type='submit'
                  disabled={isPending || !receiptFile}
                  className='cursor-pointer rounded-sm bg-primary text-on-primary hover:bg-primary/95 text-xs h-9 px-5 shadow-sm font-semibold'
                >
                  {isPending ? 'Submitting...' : 'Submit Repayment'}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Decline Reason Modal */}
      <Dialog
        open={declineOpen}
        onOpenChange={(val) => !isPending && setDeclineOpen(val)}
      >
        <DialogContent className='sm:max-w-106.25 bg-surface-container-lowest border-outline-variant/30 shadow-2xl p-0 overflow-hidden'>
          <div className='bg-error/10 p-4 border-b border-error/20 flex items-center gap-3'>
            <div className='w-10 h-10 rounded-full bg-error/20 flex items-center justify-center text-error'>
              <AlertTriangle className='w-5 h-5' />
            </div>
            <div>
              <DialogTitle className='text-lg font-bold text-error font-heading'>
                Decline Loan Offer
              </DialogTitle>
              <p className='text-xs text-error/80 mt-0.5'>
                Please provide a reason for declining.
              </p>
            </div>
          </div>
          <div className='p-6 pt-4 bg-surface-container-lowest'>
            <form
              onSubmit={handleDeclineSubmit}
              className='flex flex-col gap-4'
            >
              {declineError && (
                <div className='p-3 bg-red-50 text-red-600 text-[11px] font-semibold rounded-md flex items-start gap-2 border border-red-100'>
                  <AlertCircle className='w-3.5 h-3.5 mt-0.5 shrink-0' />
                  <span>{declineError}</span>
                </div>
              )}
              <div className='flex flex-col gap-2'>
                <Label
                  htmlFor='declineReason'
                  className='text-xs font-semibold'
                >
                  Reason <span className='text-error'>*</span>
                </Label>
                <Textarea
                  id='declineReason'
                  placeholder='Why are you declining this approved amount?'
                  value={declineReason}
                  onChange={(e) => setDeclineReason(e.target.value)}
                  className='min-h-25 resize-none'
                  required
                  disabled={isPending}
                />
              </div>
              <div className='flex gap-3 justify-end mt-2 pt-4 border-t border-outline-variant/10'>
                <Button
                  type='button'
                  variant='outline'
                  onClick={() => setDeclineOpen(false)}
                  disabled={isPending}
                  className='h-9 px-4 font-semibold text-xs rounded-sm hover:bg-surface-container-low transition-colors'
                >
                  Cancel
                </Button>
                <Button
                  type='submit'
                  disabled={isPending}
                  className='h-9 px-5 bg-error text-white hover:bg-error/90 font-semibold text-xs rounded-sm shadow-sm transition-all'
                >
                  {isPending ? (
                    <Loader2 className='w-3.5 h-3.5 mr-1.5 animate-spin' />
                  ) : (
                    <CheckCircle className='w-3.5 h-3.5 mr-1.5' />
                  )}
                  Confirm Decline
                </Button>
              </div>
            </form>
          </div>
        </DialogContent>
      </Dialog>
      {/* 2. Zoomable Receipt Modal Lightbox */}
      <ReceiptLightbox
        url={selectedReceiptUrl}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
      />
    </div>
  )
}
