'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { StatusPill } from '@/components/ui/StatusPill'
import { ArrowLeft, CheckCircle, XCircle, Clock, Search, Target, PiggyBank, History, Loader2, Calendar } from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { format } from 'date-fns'
import { reviewSavingsTransactionAction } from '@/models/admin/savingsActions'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

interface Transaction {
  id: string
  amount: number
  type: string
  status: string
  receiptUrl: string | null
  createdAt: string
  referenceNumber: string | null
  rejectionReason: string | null
}

interface User {
  name: string
  email: string
  username: string
}

interface SavingsPlan {
  id: string
  savingsType: string
  status: string
  targetAmount: number | null
  currentBalance: number
  totalDeposited: number
  accruedInterest: number
  frequency: string
  maturityDate: string | null
  createdAt: string
  transactions: Transaction[]
  user: User
}

export const AdminSavingsDetailsClient = ({ savingsPlan }: { savingsPlan: SavingsPlan }) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [selectedReceiptUrl, setSelectedReceiptUrl] = useState<string | null>(null)
  
  const [reviewModalOpen, setReviewModalOpen] = useState(false)
  const [reviewAction, setReviewAction] = useState<{ id: string, status: 'CONFIRMED' | 'REJECTED' } | null>(null)
  const [rejectionReason, setRejectionReason] = useState('')

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 0,
    }).format(val)
  }

  const handleReviewTransaction = (transactionId: string, status: 'CONFIRMED' | 'REJECTED') => {
    setReviewAction({ id: transactionId, status })
    setRejectionReason('')
    setReviewModalOpen(true)
  }

  const confirmReviewTransaction = () => {
    if (!reviewAction) return
    if (reviewAction.status === 'REJECTED' && !rejectionReason.trim()) {
      toast.error('Rejection reason is required.')
      return
    }

    startTransition(async () => {
      const res = await reviewSavingsTransactionAction(reviewAction.id, reviewAction.status, undefined, rejectionReason.trim() || undefined)
      if (res.error) {
        toast.error(res.error)
      } else {
        toast.success(`Transaction ${reviewAction.status === 'CONFIRMED' ? 'Approved' : 'Rejected'} successfully`)
        setReviewModalOpen(false)
        router.refresh()
      }
    })
  }

  return (
    <div className='flex flex-col gap-6 w-full max-w-5xl mx-auto'>
      <div className='flex items-center gap-1.5 text-muted-foreground hover:text-primary cursor-pointer transition-colors w-fit text-sm font-semibold'>
        <ArrowLeft className='w-4 h-4' />
        <Link href='/admin/savings'>Back to Savings Management</Link>
      </div>

      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className='text-2xl font-bold font-heading text-primary leading-tight'>
            Savings Account Details
          </h2>
          <p className='text-muted-foreground text-sm mt-1'>
            {savingsPlan.user.name} ({savingsPlan.user.email})
          </p>
        </div>
        <StatusPill status={savingsPlan.status} />
      </header>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-4 border border-outline-variant/30 shadow-none flex flex-col gap-2 rounded-xl">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Target className="w-4 h-4" />
            <span className="text-xs font-semibold uppercase tracking-wider">Commitment</span>
          </div>
          <p className="text-xl font-bold text-primary">
            {savingsPlan.targetAmount ? formatCurrency(savingsPlan.targetAmount) : 'Flexible'}
          </p>
          <p className="text-xs text-muted-foreground">Amount to save</p>
        </Card>

        <Card className="p-4 border border-outline-variant/30 shadow-none flex flex-col gap-2 rounded-xl">
          <div className="flex items-center gap-2 text-muted-foreground">
            <History className="w-4 h-4" />
            <span className="text-xs font-semibold uppercase tracking-wider">Interval</span>
          </div>
          <p className="text-xl font-bold text-primary">
            {savingsPlan.frequency || 'N/A'}
          </p>
          <p className="text-xs text-muted-foreground">Savings frequency</p>
        </Card>

        <Card className="p-4 border border-outline-variant/30 shadow-none flex flex-col gap-2 rounded-xl">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Calendar className="w-4 h-4" />
            <span className="text-xs font-semibold uppercase tracking-wider">Maturity Date</span>
          </div>
          <p className="text-xl font-bold text-primary">
            {savingsPlan.maturityDate ? format(new Date(savingsPlan.maturityDate), 'MMM d, yyyy') : 'N/A'}
          </p>
          <p className="text-xs text-muted-foreground">Expected maturity</p>
        </Card>

        <Card className="p-4 border border-outline-variant/30 shadow-none flex flex-col gap-2 rounded-xl">
          <div className="flex items-center gap-2 text-muted-foreground">
            <PiggyBank className="w-4 h-4" />
            <span className="text-xs font-semibold uppercase tracking-wider">Current Balance</span>
          </div>
          <p className="text-xl font-bold text-primary">
            {formatCurrency(savingsPlan.currentBalance)}
          </p>
          <p className="text-xs text-success-green font-medium">
            +{formatCurrency(savingsPlan.accruedInterest)} Interest
          </p>
        </Card>
      </div>

      {/* Transactions Table */}
      <Card className="border border-outline-variant/30 shadow-none rounded-xl mt-4">
        <div className="p-5 border-b border-outline-variant/30 flex justify-between items-center bg-surface-container/30">
          <h3 className="font-bold text-primary flex items-center gap-2">
            <History className="w-4 h-4" /> Transactions History
          </h3>
          {isPending && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
        </div>
        <div className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Receipt</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {savingsPlan.transactions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    No transactions found for this savings plan.
                  </TableCell>
                </TableRow>
              ) : (
                savingsPlan.transactions.map((tx) => (
                  <TableRow key={tx.id}>
                    <TableCell className="font-medium">
                      {format(new Date(tx.createdAt), 'MMM d, yyyy h:mm a')}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider w-fit ${
                          tx.type === 'DEPOSIT' ? 'bg-success-green/10 text-success-green' : 'bg-error/10 text-error'
                        }`}>
                          {tx.type}
                        </span>
                        {tx.status === 'REJECTED' && tx.rejectionReason && (
                          <span className="text-[10px] text-error italic mt-1 max-w-xs break-words">
                            Reason: {tx.rejectionReason}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono font-semibold">
                      {formatCurrency(tx.amount)}
                    </TableCell>
                    <TableCell>
                      {tx.receiptUrl ? (
                        <Button 
                          variant="outline" 
                          size="sm" 
                          className="h-7 text-xs"
                          onClick={() => {
                            setSelectedReceiptUrl(tx.receiptUrl)
                            setLightboxOpen(true)
                          }}
                        >
                          View Receipt
                        </Button>
                      ) : (
                        <span className="text-muted-foreground text-xs">No receipt</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusPill status={tx.status} />
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {tx.status === 'PENDING' && (
                        <>
                          <Button 
                            variant="default" 
                            size="sm" 
                            className="bg-success-green hover:bg-success-green/90 h-8 px-2"
                            onClick={() => handleReviewTransaction(tx.id, 'CONFIRMED')}
                            disabled={isPending}
                          >
                            <CheckCircle className="w-3.5 h-3.5 mr-1" /> Approve
                          </Button>
                          <Button 
                            variant="destructive" 
                            size="sm" 
                            className="h-8 px-2"
                            onClick={() => handleReviewTransaction(tx.id, 'REJECTED')}
                            disabled={isPending}
                          >
                            <XCircle className="w-3.5 h-3.5 mr-1" /> Reject
                          </Button>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Lightbox for Receipt */}
      {lightboxOpen && selectedReceiptUrl && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightboxOpen(false)}
        >
          <div className="relative max-w-4xl max-h-[90vh] w-full flex items-center justify-center">
            <button 
              className="absolute top-4 right-4 bg-white/20 hover:bg-white/40 p-2 rounded-full backdrop-blur transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                setLightboxOpen(false)
              }}
            >
              <XCircle className="w-6 h-6 text-white" />
            </button>
            <img 
              src={selectedReceiptUrl} 
              alt="Transaction Receipt" 
              className="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl border border-white/10"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      )}

      {/* Confirmation Dialog */}
      <Dialog open={reviewModalOpen} onOpenChange={setReviewModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Action</DialogTitle>
            <DialogDescription>
              Are you sure you want to {reviewAction?.status === 'CONFIRMED' ? 'approve' : 'reject'} this transaction?
              {reviewAction?.status === 'CONFIRMED' && ' This will update the member\'s savings balance.'}
            </DialogDescription>
          </DialogHeader>

          {reviewAction?.status === 'REJECTED' && (
            <div className="flex flex-col gap-2 mt-2">
              <Label htmlFor="rejectionReason" className="text-xs font-semibold text-primary">
                Rejection Reason <span className="text-error">*</span>
              </Label>
              <Textarea 
                id="rejectionReason"
                placeholder="Briefly explain why this deposit is being rejected..."
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                className="resize-none"
                rows={3}
              />
            </div>
          )}

          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setReviewModalOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button 
              variant={reviewAction?.status === 'CONFIRMED' ? 'default' : 'destructive'} 
              onClick={confirmReviewTransaction}
              disabled={isPending}
            >
              {isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {reviewAction?.status === 'CONFIRMED' ? 'Yes, Approve' : 'Yes, Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
