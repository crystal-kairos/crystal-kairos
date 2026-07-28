'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Clock,
  User as UserIcon,
  Briefcase,
  AlertTriangle,
  Upload,
  Receipt,
  Download,
  TrendingUp,
  History,
  Loader2,
  Check,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  approveLoanAction,
  rejectLoanAction,
  disburseLoanAction,
  reviewLoanRepaymentAction,
} from '@/models/admin/loanActions'
import { ReceiptDropzone } from '@/components/ui/ReceiptDropzone'
import { ReceiptLightbox } from '@/components/ui/ReceiptLightbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { format } from 'date-fns'
import { uploadReceiptAction } from '@/models/eajo/actions'

interface AdminLoanDetailsClientProps {
  loan: any // Type from getLoanByIdQuery
}

const formatCurrency = (val: number) =>
  new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 0,
  }).format(val)

export const AdminLoanDetailsClient = ({
  loan,
}: AdminLoanDetailsClientProps) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Modal states
  const [showApproveModal, setShowApproveModal] = useState(false)
  const [showRejectModal, setShowRejectModal] = useState(false)
  const [showDisburseModal, setShowDisburseModal] = useState(false)

  // Form states
  const [approvedAmount, setApprovedAmount] = useState(
    loan.requestedAmount.toString(),
  )
  const [rejectionReason, setRejectionReason] = useState('')
  const [receiptFile, setReceiptFile] = useState<File | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [selectedReceiptUrl, setSelectedReceiptUrl] = useState<string | null>(
    null,
  )

  // Transaction Review states
  const [reviewTxId, setReviewTxId] = useState<string | null>(null)
  const [showTxRejectModal, setShowTxRejectModal] = useState(false)
  const [txRejectionReason, setTxRejectionReason] = useState('')

  const handleApprove = () => {
    startTransition(async () => {
      const amount = Number(approvedAmount)
      if (amount <= 0 || amount > loan.requestedAmount) {
        toast.error('Invalid approval amount.')
        return
      }

      const res = await approveLoanAction(loan.id, amount)
      if (res.success) {
        toast.success('Loan approved successfully!')
        setShowApproveModal(false)
      } else {
        toast.error(res.error)
      }
    })
  }

  const handleReject = () => {
    startTransition(async () => {
      if (!rejectionReason.trim()) {
        toast.error('Rejection reason is required.')
        return
      }

      const res = await rejectLoanAction(loan.id, rejectionReason)
      if (res.success) {
        toast.success('Loan rejected successfully.')
        setShowRejectModal(false)
      } else {
        toast.error(res.error)
      }
    })
  }

  const handleDisburse = () => {
    startTransition(async () => {
      if (!receiptFile) {
        toast.error('Disbursement receipt is required.')
        return
      }

      const uploadFormData = new FormData()
      uploadFormData.append('file', receiptFile)

      const uploadRes = await uploadReceiptAction(uploadFormData)
      if (!uploadRes.success || !uploadRes.url) {
        toast.error(
          uploadRes.error || 'Failed to upload receipt file to storage.',
        )
        return
      }

      const res = await disburseLoanAction(loan.id, uploadRes.url)
      if (res.success) {
        toast.success('Loan disbursed successfully!')
        setShowDisburseModal(false)
      } else {
        toast.error(res.error)
      }
    })
  }
  const handleReviewTransaction = (
    txId: string,
    action: 'CONFIRMED' | 'REJECTED',
  ) => {
    if (action === 'REJECTED') {
      setReviewTxId(txId)
      setTxRejectionReason('')
      setShowTxRejectModal(true)
      return
    }

    startTransition(async () => {
      const res = await reviewLoanRepaymentAction(txId, 'CONFIRMED')
      if (res.success) {
        toast.success('Repayment approved successfully')
        router.refresh()
      } else {
        toast.error(res.error || 'Failed to approve repayment')
      }
    })
  }

  const handleRejectTransaction = () => {
    if (!reviewTxId) return
    if (!txRejectionReason.trim()) {
      toast.error('Rejection reason is required')
      return
    }

    startTransition(async () => {
      const res = await reviewLoanRepaymentAction(
        reviewTxId,
        'REJECTED',
        txRejectionReason,
      )
      if (res.success) {
        toast.success('Repayment rejected')
        setShowTxRejectModal(false)
        router.refresh()
      } else {
        toast.error(res.error || 'Failed to reject repayment')
      }
    })
  }

  return (
    <div className='flex flex-col gap-6 max-w-4xl mx-auto py-6'>
      <div className='flex items-center gap-4'>
        <Button asChild variant='ghost' className='h-8 w-8 p-0 rounded-full'>
          <Link href='/admin/loans'>
            <ArrowLeft className='w-4 h-4 text-muted-foreground' />
          </Link>
        </Button>
        <div>
          <h2 className='text-2xl font-bold font-heading text-primary'>
            Loan Details
          </h2>
          <p className='text-sm text-muted-foreground mt-0.5'>
            Application ID: {loan.id.substring(0, 13).toUpperCase()}
          </p>
        </div>
      </div>

      <div className='grid grid-cols-1 md:grid-cols-3 gap-6'>
        {/* Main Details */}
        <div className='md:col-span-2 flex flex-col gap-6'>
          <Card className='bg-surface-container border-0 shadow-none rounded-xl'>
            <CardHeader className='pb-3 border-b border-outline-variant/20'>
              <div className='flex items-center justify-between'>
                <CardTitle className='text-sm font-bold text-primary uppercase tracking-widest'>
                  Application Info
                </CardTitle>
                <div className='px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded-full border bg-background'>
                  {loan.status}
                </div>
              </div>
            </CardHeader>
            <CardContent className='p-5 grid grid-cols-2 gap-y-6 gap-x-4'>
              <div>
                <p className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-1'>
                  Requested Amount
                </p>
                <p className='text-lg font-mono font-bold text-primary'>
                  {formatCurrency(loan.requestedAmount)}
                </p>
              </div>
              <div>
                <p className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-1'>
                  Duration
                </p>
                <p className='text-sm font-bold text-primary'>
                  {loan.duration} Months
                </p>
              </div>
              <div>
                <p className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-1'>
                  Interest Rate
                </p>
                <p className='text-sm font-bold text-primary'>
                  {loan.interestRate}% monthly
                </p>
              </div>
              <div>
                <p className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-1'>
                  Application Date
                </p>
                <p className='text-sm font-bold text-primary'>
                  {new Date(loan.requestedAt).toLocaleDateString()}
                </p>
              </div>
              <div className='col-span-2'>
                <p className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-1'>
                  Purpose
                </p>
                <div className='bg-background p-3 rounded-lg border text-sm text-primary'>
                  {loan.purpose}
                </div>
              </div>

              {loan.status === 'REJECTED' && loan.rejectionReason && (
                <div className='col-span-2 bg-red-50 p-4 rounded-lg border border-red-200'>
                  <p className='text-[10px] text-red-600 uppercase tracking-wider font-bold mb-1'>
                    Rejection Reason
                  </p>
                  <p className='text-sm text-red-800'>{loan.rejectionReason}</p>
                </div>
              )}

              {['ACTIVE', 'DISBURSED', 'OVERDUE', 'COMPLETED'].includes(
                loan.status,
              ) && (
                <div className='col-span-2 grid grid-cols-2 gap-4 bg-emerald-50/50 p-4 rounded-lg border border-emerald-100'>
                  <div>
                    <p className='text-[10px] text-emerald-600 uppercase tracking-wider font-bold mb-1'>
                      Approved Amount
                    </p>
                    <p className='text-sm font-bold font-mono text-emerald-800'>
                      {formatCurrency(
                        loan.approvedAmount || loan.requestedAmount,
                      )}
                    </p>
                  </div>
                  <div>
                    <p className='text-[10px] text-emerald-600 uppercase tracking-wider font-bold mb-1'>
                      Outstanding Balance
                    </p>
                    <p className='text-sm font-bold font-mono text-emerald-800'>
                      {formatCurrency(loan.outstandingBalance)}
                    </p>
                  </div>
                  <div>
                    <p className='text-[10px] text-emerald-600 uppercase tracking-wider font-bold mb-1'>
                      Disbursed Date
                    </p>
                    <p className='text-sm font-bold text-emerald-800'>
                      {loan.disbursedAt
                        ? new Date(loan.disbursedAt).toLocaleDateString()
                        : 'N/A'}
                    </p>
                  </div>
                  <div>
                    <p className='text-[10px] text-emerald-600 uppercase tracking-wider font-bold mb-1'>
                      Repayment End Date
                    </p>
                    <p className='text-sm font-bold text-emerald-800'>
                      {loan.repaymentEndDate
                        ? new Date(loan.repaymentEndDate).toLocaleDateString()
                        : 'N/A'}
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar Actions & User Profile */}
        <div className='flex flex-col gap-6'>
          {/* Action Buttons */}
          <Card className='bg-surface-container border-0 shadow-none rounded-xl'>
            <CardHeader className='pb-3 border-b border-outline-variant/20'>
              <CardTitle className='text-sm font-bold text-primary uppercase tracking-widest'>
                Admin Actions
              </CardTitle>
            </CardHeader>
            <CardContent className='p-5 flex flex-col gap-3'>
              {loan.status === 'PENDING' ? (
                <>
                  <Button
                    onClick={() => setShowApproveModal(true)}
                    className='w-full bg-blue-600 hover:bg-blue-700 text-white font-bold h-10'
                  >
                    <CheckCircle2 className='w-4 h-4 mr-2' /> Approve Loan
                  </Button>
                  <Button
                    onClick={() => setShowRejectModal(true)}
                    variant='outline'
                    className='w-full border-red-200 text-red-600 hover:bg-red-50 font-bold h-10'
                  >
                    <XCircle className='w-4 h-4 mr-2' /> Reject Loan
                  </Button>
                </>
              ) : loan.status === 'ACCEPTED' ? (
                <Button
                  onClick={() => setShowDisburseModal(true)}
                  className='w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold h-10'
                >
                  <TrendingUp className='w-4 h-4 mr-2' /> Disburse Loan
                </Button>
              ) : (
                <div className='flex items-center justify-center p-4 bg-background rounded-lg border text-sm text-muted-foreground font-medium text-center'>
                  No actions available for
                  <br />
                  status: {loan.status}
                </div>
              )}
            </CardContent>
          </Card>

          {/* User Profile */}
          <Card className='bg-surface-container border-0 shadow-none rounded-xl'>
            <CardHeader className='pb-3 border-b border-outline-variant/20'>
              <CardTitle className='text-sm font-bold text-primary uppercase tracking-widest'>
                Applicant
              </CardTitle>
            </CardHeader>
            <CardContent className='p-5 flex flex-col gap-4'>
              <div className='flex items-center gap-3'>
                <div className='w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm shrink-0'>
                  {loan.user.name.charAt(0)}
                </div>
                <div className='min-w-0'>
                  <h4 className='font-bold text-primary text-sm truncate'>
                    {loan.user.name}
                  </h4>
                  <p className='text-xs text-muted-foreground truncate'>
                    {loan.user.email}
                  </p>
                </div>
              </div>
              <div className='pt-3 border-t border-outline-variant/20 space-y-3'>
                <div>
                  <p className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-1'>
                    Guarantor Name
                  </p>
                  <p className='text-sm font-medium text-primary'>
                    {loan.guarantorName || 'N/A'}
                  </p>
                </div>
                <div>
                  <p className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-1'>
                    Guarantor Phone
                  </p>
                  <p className='text-sm font-medium text-primary'>
                    {loan.guarantorPhoneNumber || 'N/A'}
                  </p>
                </div>
                {loan.collateralDetails && (
                  <div>
                    <p className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold mb-1'>
                      Collateral Details
                    </p>
                    <p className='text-sm font-medium text-primary'>
                      {loan.collateralDetails}
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Transactions Table */}
      <Card className='border border-outline-variant/30 shadow-none rounded-xl mt-4'>
        <div className='p-5 border-b border-outline-variant/30 flex justify-between items-center bg-surface-container/30'>
          <h3 className='font-bold text-primary flex items-center gap-2'>
            <History className='w-4 h-4' /> Repayment History
          </h3>
          {isPending && (
            <Loader2 className='w-4 h-4 animate-spin text-muted-foreground' />
          )}
        </div>
        <div className='p-0'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Receipt</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className='text-right'>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!loan.transactions ||
              loan.transactions.filter(
                (tx: any) =>
                  tx.category === 'LOAN_REPAYMENT' || tx.category === 'FEE',
              ).length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className='text-center py-8 text-muted-foreground'
                  >
                    No repayments found for this loan.
                  </TableCell>
                </TableRow>
              ) : (
                loan.transactions
                  .filter(
                    (tx: any) =>
                      tx.category === 'LOAN_REPAYMENT' || tx.category === 'FEE',
                  )
                  .map((tx: any) => (
                    <TableRow key={tx.id}>
                      <TableCell className='font-medium'>
                        {format(new Date(tx.createdAt), 'MMM d, yyyy h:mm a')}
                      </TableCell>
                      <TableCell>
                        <div className='flex flex-col gap-1'>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider w-fit ${
                              tx.type === 'DEPOSIT'
                                ? 'bg-success-green/10 text-success-green'
                                : 'bg-error/10 text-error'
                            }`}
                          >
                            {tx.category.replace('_', ' ')}
                          </span>
                          {tx.status === 'REJECTED' && tx.rejectionReason && (
                            <span className='text-[10px] text-error italic mt-1 max-w-xs wrap-break-word'>
                              Reason: {tx.rejectionReason}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className='font-mono font-semibold'>
                        {formatCurrency(tx.amount)}
                      </TableCell>
                      <TableCell>
                        {tx.receiptUrl ? (
                          <Button
                            variant='outline'
                            size='sm'
                            className='h-7 text-xs'
                            onClick={() => {
                              setSelectedReceiptUrl(tx.receiptUrl)
                              setLightboxOpen(true)
                            }}
                          >
                            View Receipt
                          </Button>
                        ) : (
                          <span className='text-xs text-muted-foreground italic'>
                            None
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                            tx.status === 'PENDING'
                              ? 'bg-amber-100 text-amber-800'
                              : tx.status === 'CONFIRMED'
                                ? 'bg-success-green/10 text-success-green'
                                : 'bg-error/10 text-error'
                          }`}
                        >
                          {tx.status}
                        </span>
                      </TableCell>
                      <TableCell className='text-right'>
                        {tx.status === 'PENDING' && (
                          <div className='flex justify-end gap-2'>
                            <Button
                              size='sm'
                              onClick={() =>
                                handleReviewTransaction(tx.id, 'CONFIRMED')
                              }
                              disabled={isPending}
                              className='h-7 px-2 bg-emerald-600 hover:bg-emerald-700 text-white'
                            >
                              <Check className='w-3.5 h-3.5 mr-1' />
                              Approve
                            </Button>
                            <Button
                              size='sm'
                              variant='outline'
                              onClick={() =>
                                handleReviewTransaction(tx.id, 'REJECTED')
                              }
                              disabled={isPending}
                              className='h-7 px-2 border-red-200 text-red-600 hover:bg-red-50'
                            >
                              <XCircle className='w-3.5 h-3.5 mr-1' />
                              Reject
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Approve Modal */}
      <Dialog open={showApproveModal} onOpenChange={setShowApproveModal}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>Approve Loan Application</DialogTitle>
            <DialogDescription>
              Confirm the final approved amount. This will move the loan to the
              APPROVED stage awaiting disbursement.
            </DialogDescription>
          </DialogHeader>
          <div className='py-4 space-y-4'>
            <div className='space-y-2'>
              <label className='text-xs font-bold text-primary uppercase tracking-wider'>
                Approved Amount (NGN)
              </label>
              <Input
                type='number'
                value={approvedAmount}
                onChange={(e) => setApprovedAmount(e.target.value)}
                className='font-mono'
              />
              <p className='text-xs text-muted-foreground'>
                Requested: {formatCurrency(loan.requestedAmount)}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setShowApproveModal(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleApprove}
              disabled={isPending}
              className='bg-blue-600 hover:bg-blue-700 text-white'
            >
              Confirm Approval
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Modal */}
      <Dialog open={showRejectModal} onOpenChange={setShowRejectModal}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>Reject Loan Application</DialogTitle>
            <DialogDescription>
              Please provide a reason for rejecting this loan. The applicant
              will see this reason on their dashboard.
            </DialogDescription>
          </DialogHeader>
          <div className='py-4 space-y-4'>
            <div className='space-y-2'>
              <label className='text-xs font-bold text-primary uppercase tracking-wider'>
                Rejection Reason
              </label>
              <Textarea
                placeholder='e.g. Guarantor details could not be verified.'
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                className='resize-none h-24'
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setShowRejectModal(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleReject}
              disabled={isPending}
              className='bg-red-600 hover:bg-red-700 text-white'
            >
              Confirm Rejection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disburse Modal */}
      <Dialog open={showDisburseModal} onOpenChange={setShowDisburseModal}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>Disburse Approved Loan</DialogTitle>
            <DialogDescription>
              Upload the payment receipt to confirm the transfer of funds to the
              applicant's bank account. This will activate the loan and begin
              the repayment timeline.
            </DialogDescription>
          </DialogHeader>
          <div className='py-4 space-y-4'>
            <div className='bg-slate-50 p-4 rounded-lg border flex justify-between items-center'>
              <div>
                <p className='text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-0.5'>
                  Amount to Disburse
                </p>
                <p className='font-bold font-mono text-primary'>
                  {formatCurrency(loan.approvedAmount || loan.requestedAmount)}
                </p>
              </div>
              <Download className='w-5 h-5 text-muted-foreground' />
            </div>

            <div className='space-y-2'>
              <label className='text-xs font-bold text-primary uppercase tracking-wider'>
                Payment Receipt
              </label>
              <ReceiptDropzone
                onFileSelected={setReceiptFile}
                value={receiptFile}
                maxSizeMb={5}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setShowDisburseModal(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleDisburse}
              disabled={isPending || !receiptFile}
              className='bg-emerald-600 hover:bg-emerald-700 text-white'
            >
              Confirm Disbursement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Transaction Reject Modal */}
      <Dialog open={showTxRejectModal} onOpenChange={setShowTxRejectModal}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>Reject Repayment</DialogTitle>
            <DialogDescription>
              Provide a reason for rejecting this repayment.
            </DialogDescription>
          </DialogHeader>
          <div className='py-4 space-y-4'>
            <div className='space-y-2'>
              <label className='text-xs font-bold text-primary uppercase tracking-wider'>
                Rejection Reason
              </label>
              <Textarea
                placeholder='e.g. Invalid receipt'
                value={txRejectionReason}
                onChange={(e) => setTxRejectionReason(e.target.value)}
                className='resize-none h-24'
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setShowTxRejectModal(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRejectTransaction}
              disabled={isPending}
              className='bg-red-600 hover:bg-red-700 text-white'
            >
              Confirm Rejection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReceiptLightbox
        url={selectedReceiptUrl}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
      />
    </div>
  )
}
