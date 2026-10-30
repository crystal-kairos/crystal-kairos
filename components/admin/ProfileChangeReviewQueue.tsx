'use client'

import React, { useState } from 'react'
import {
  ProfileChangeStatus,
  ProfileChangeType,
} from '@/generated/prisma/enums'
import {
  approveProfileChangeRequestAction,
  rejectProfileChangeRequestAction,
} from '@/models/admin/profile-change-actions'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  CheckCircle2,
  XCircle,
  Clock,
  User,
  Landmark,
  Heart,
  ShieldAlert,
  ArrowRight,
  Search,
  RefreshCw,
  FileText,
  AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

export interface ProfileChangeRequestItem {
  id: string
  userId: string
  changeType: ProfileChangeType
  previousValue: any
  proposedValue: any
  status: ProfileChangeStatus
  submittedAt: Date | string
  reviewedAt: Date | string | null
  reviewedById: string | null
  rejectionReason: string | null
  user: {
    id: string
    name: string
    email: string
    role?: string
  }
  reviewedBy?: {
    id: string
    name: string
    email: string
  } | null
}

interface ProfileChangeReviewQueueProps {
  initialRequests: ProfileChangeRequestItem[]
  currentAdminId: string
  initialStats?: {
    pending: number
    approved: number
    rejected: number
    cancelled: number
    total: number
  }
}

export const ProfileChangeReviewQueue: React.FC<ProfileChangeReviewQueueProps> = ({
  initialRequests,
  currentAdminId,
  initialStats,
}) => {
  const router = useRouter()
  const [requests, setRequests] = useState<ProfileChangeRequestItem[]>(initialRequests)
  const [statusFilter, setStatusFilter] = useState<string>('PENDING')
  const [typeFilter, setTypeFilter] = useState<string>('ALL')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedRequest, setSelectedRequest] = useState<ProfileChangeRequestItem | null>(null)

  // Rejection modal state
  const [rejectModalOpen, setRejectModalOpen] = useState(false)
  const [rejectionReason, setRejectionReason] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)

  // Approval modal state
  const [approveModalOpen, setApproveModalOpen] = useState(false)

  // Filtered requests
  const filteredRequests = requests.filter((req) => {
    const matchesStatus = statusFilter === 'ALL' || req.status === statusFilter
    const matchesType = typeFilter === 'ALL' || req.changeType === typeFilter
    const q = searchQuery.toLowerCase().trim()
    const matchesSearch =
      !q ||
      req.user.name.toLowerCase().includes(q) ||
      req.user.email.toLowerCase().includes(q) ||
      req.id.toLowerCase().includes(q)

    return matchesStatus && matchesType && matchesSearch
  })

  // Compute live stats from state if not passed or after optimistic actions
  const stats = {
    pending: requests.filter((r) => r.status === ProfileChangeStatus.PENDING).length,
    approved: requests.filter((r) => r.status === ProfileChangeStatus.APPROVED).length,
    rejected: requests.filter((r) => r.status === ProfileChangeStatus.REJECTED).length,
    total: requests.length,
  }

  const handleApprove = async () => {
    if (!selectedRequest) return

    if (selectedRequest.userId === currentAdminId) {
      toast.error('Separation of duties: You cannot approve your own profile change request.')
      return
    }

    setIsProcessing(true)
    const result = await approveProfileChangeRequestAction(selectedRequest.id)
    setIsProcessing(false)

    if (result.success) {
      toast.success('Profile change request approved and applied.')
      setRequests((prev) =>
        prev.map((r) =>
          r.id === selectedRequest.id
            ? { ...r, status: ProfileChangeStatus.APPROVED, reviewedAt: new Date().toISOString() }
            : r,
        ),
      )
      setApproveModalOpen(false)
      setSelectedRequest(null)
      router.refresh()
    } else {
      toast.error(result.error || 'Failed to approve request.')
    }
  }

  const handleReject = async () => {
    if (!selectedRequest) return

    if (selectedRequest.userId === currentAdminId) {
      toast.error('Separation of duties: You cannot reject your own profile change request.')
      return
    }

    if (!rejectionReason.trim() || rejectionReason.trim().length < 3) {
      toast.error('Please enter a clear rejection reason (minimum 3 characters).')
      return
    }

    setIsProcessing(true)
    const result = await rejectProfileChangeRequestAction(
      selectedRequest.id,
      rejectionReason.trim(),
    )
    setIsProcessing(false)

    if (result.success) {
      toast.success('Profile change request rejected.')
      setRequests((prev) =>
        prev.map((r) =>
          r.id === selectedRequest.id
            ? {
                ...r,
                status: ProfileChangeStatus.REJECTED,
                reviewedAt: new Date().toISOString(),
                rejectionReason: rejectionReason.trim(),
              }
            : r,
        ),
      )
      setRejectModalOpen(false)
      setRejectionReason('')
      setSelectedRequest(null)
      router.refresh()
    } else {
      toast.error(result.error || 'Failed to reject request.')
    }
  }

  const renderTypeBadge = (type: ProfileChangeType) => {
    switch (type) {
      case ProfileChangeType.PRIMARY_BANK:
        return (
          <Badge variant='outline' className='bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30 text-[10px] flex items-center gap-1 font-medium'>
            <Landmark className='w-3 h-3' /> Primary Bank Account
          </Badge>
        )
      case ProfileChangeType.NEXT_OF_KIN:
        return (
          <Badge variant='outline' className='bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30 text-[10px] flex items-center gap-1 font-medium'>
            <Heart className='w-3 h-3' /> Next of Kin
          </Badge>
        )
      case ProfileChangeType.BANK_DETAILS:
        return (
          <Badge variant='outline' className='bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30 text-[10px] flex items-center gap-1 font-medium'>
            <Landmark className='w-3 h-3' /> Bank Account Details
          </Badge>
        )
      default:
        return <Badge variant='outline'>{type}</Badge>
    }
  }

  const renderStatusBadge = (status: ProfileChangeStatus) => {
    switch (status) {
      case ProfileChangeStatus.PENDING:
        return (
          <Badge className='bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30 text-[10px] font-medium'>
            <Clock className='w-3 h-3 mr-1 inline' /> Pending Review
          </Badge>
        )
      case ProfileChangeStatus.APPROVED:
        return (
          <Badge className='bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30 text-[10px] font-medium'>
            <CheckCircle2 className='w-3 h-3 mr-1 inline' /> Approved
          </Badge>
        )
      case ProfileChangeStatus.REJECTED:
        return (
          <Badge className='bg-rose-500/15 text-rose-700 dark:text-rose-400 border border-rose-500/30 text-[10px] font-medium'>
            <XCircle className='w-3 h-3 mr-1 inline' /> Rejected
          </Badge>
        )
      case ProfileChangeStatus.CANCELLED:
        return (
          <Badge variant='outline' className='text-muted-foreground text-[10px] font-medium'>
            Cancelled
          </Badge>
        )
    }
  }

  return (
    <div className='flex flex-col gap-6 max-w-7xl mx-auto'>
      {/* Page Header */}
      <div className='flex flex-col sm:flex-row sm:items-center justify-between gap-4'>
        <div>
          <h1 className='text-2xl font-bold tracking-tight'>Profile Change Review Queue</h1>
          <p className='text-muted-foreground text-sm mt-0.5'>
            Review and govern sensitive member profile alterations including receiving bank accounts and Next of Kin.
          </p>
        </div>
        <Button
          variant='outline'
          size='sm'
          onClick={() => router.refresh()}
          className='gap-1.5 self-start sm:self-auto cursor-pointer rounded-lg text-xs'
        >
          <RefreshCw className='w-3.5 h-3.5' /> Refresh
        </Button>
      </div>

      {/* Metrics Row */}
      <div className='grid grid-cols-2 md:grid-cols-4 gap-4'>
        <Card className='rounded-lg shadow-none border bg-card'>
          <CardContent className='p-4 flex items-center justify-between'>
            <div>
              <p className='text-xs text-muted-foreground font-medium'>Pending Review</p>
              <p className='text-2xl font-bold text-amber-600 dark:text-amber-400 mt-1'>{stats.pending}</p>
            </div>
            <div className='w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center text-amber-600'>
              <Clock className='w-5 h-5' />
            </div>
          </CardContent>
        </Card>

        <Card className='rounded-lg shadow-none border bg-card'>
          <CardContent className='p-4 flex items-center justify-between'>
            <div>
              <p className='text-xs text-muted-foreground font-medium'>Approved Changes</p>
              <p className='text-2xl font-bold text-emerald-600 dark:text-emerald-400 mt-1'>{stats.approved}</p>
            </div>
            <div className='w-10 h-10 rounded-full bg-emerald-500/10 flex items-center justify-center text-emerald-600'>
              <CheckCircle2 className='w-5 h-5' />
            </div>
          </CardContent>
        </Card>

        <Card className='rounded-lg shadow-none border bg-card'>
          <CardContent className='p-4 flex items-center justify-between'>
            <div>
              <p className='text-xs text-muted-foreground font-medium'>Rejected</p>
              <p className='text-2xl font-bold text-rose-600 dark:text-rose-400 mt-1'>{stats.rejected}</p>
            </div>
            <div className='w-10 h-10 rounded-full bg-rose-500/10 flex items-center justify-center text-rose-600'>
              <XCircle className='w-5 h-5' />
            </div>
          </CardContent>
        </Card>

        <Card className='rounded-lg shadow-none border bg-card'>
          <CardContent className='p-4 flex items-center justify-between'>
            <div>
              <p className='text-xs text-muted-foreground font-medium'>Total Requests</p>
              <p className='text-2xl font-bold text-foreground mt-1'>{stats.total}</p>
            </div>
            <div className='w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary'>
              <FileText className='w-5 h-5' />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filter and Search Bar */}
      <Card className='rounded-lg shadow-none border'>
        <CardContent className='p-4 flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between'>
          <div className='flex items-center gap-2 flex-wrap'>
            <div className='flex bg-muted p-0.5 rounded-md'>
              {(['PENDING', 'APPROVED', 'REJECTED', 'ALL'] as const).map((tab) => (
                <button
                  key={tab}
                  type='button'
                  onClick={() => setStatusFilter(tab)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-sm transition-colors cursor-pointer ${
                    statusFilter === tab
                      ? 'bg-background text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {tab === 'ALL' ? 'All' : tab.charAt(0) + tab.slice(1).toLowerCase()}
                </button>
              ))}
            </div>

            <div className='flex bg-muted p-0.5 rounded-md'>
              {(['ALL', 'PRIMARY_BANK', 'NEXT_OF_KIN'] as const).map((tab) => (
                <button
                  key={tab}
                  type='button'
                  onClick={() => setTypeFilter(tab)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-sm transition-colors cursor-pointer ${
                    typeFilter === tab
                      ? 'bg-background text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {tab === 'ALL' ? 'All Types' : tab === 'PRIMARY_BANK' ? 'Primary Bank' : 'Next of Kin'}
                </button>
              ))}
            </div>
          </div>

          <div className='relative w-full md:w-64'>
            <Search className='w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground' />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder='Search member name or email...'
              className='pl-8.5 h-9 text-xs rounded-md'
            />
          </div>
        </CardContent>
      </Card>

      {/* Requests Table */}
      <Card className='rounded-lg shadow-none border overflow-hidden'>
        <div className='overflow-x-auto'>
          <table className='w-full text-left text-xs'>
            <thead className='bg-muted/50 border-b text-muted-foreground font-semibold uppercase tracking-wider text-[11px]'>
              <tr>
                <th className='py-3 px-4'>Member</th>
                <th className='py-3 px-4'>Change Type</th>
                <th className='py-3 px-4'>Summary of Proposed Change</th>
                <th className='py-3 px-4'>Submitted At</th>
                <th className='py-3 px-4'>Status</th>
                <th className='py-3 px-4 text-right'>Action</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-outline-variant/10'>
              {filteredRequests.length === 0 ? (
                <tr>
                  <td colSpan={6} className='py-12 text-center text-muted-foreground'>
                    No profile change requests found matching current filters.
                  </td>
                </tr>
              ) : (
                filteredRequests.map((req) => {
                  const isOwnRequest = req.userId === currentAdminId
                  const proposed = req.proposedValue as any
                  const previous = req.previousValue as any

                  return (
                    <tr key={req.id} className='hover:bg-muted/30 transition-colors'>
                      <td className='py-3 px-4'>
                        <div className='flex flex-col'>
                          <span className='font-medium text-foreground'>{req.user.name}</span>
                          <span className='text-[11px] text-muted-foreground'>{req.user.email}</span>
                          {isOwnRequest && (
                            <span className='text-[10px] text-amber-600 font-medium'>
                              (Your Own Request - Review Restricted)
                            </span>
                          )}
                        </div>
                      </td>

                      <td className='py-3 px-4'>
                        {renderTypeBadge(req.changeType)}
                      </td>

                      <td className='py-3 px-4 max-w-xs'>
                        {req.changeType === ProfileChangeType.PRIMARY_BANK && (
                          <div className='flex items-center gap-1.5 text-xs truncate'>
                            <span className='text-muted-foreground truncate'>
                              {previous?.bankName ? `${previous.bankName} (${previous.accountNumberMasked})` : 'None'}
                            </span>
                            <ArrowRight className='w-3 h-3 text-primary shrink-0' />
                            <span className='font-medium text-foreground truncate'>
                              {proposed?.bankName} ({proposed?.accountNumberMasked})
                            </span>
                          </div>
                        )}

                        {req.changeType === ProfileChangeType.NEXT_OF_KIN && (
                          <div className='flex items-center gap-1.5 text-xs truncate'>
                            <span className='text-muted-foreground truncate'>
                              {previous?.name ? `${previous.name} (${previous.relationship})` : 'New'}
                            </span>
                            <ArrowRight className='w-3 h-3 text-primary shrink-0' />
                            <span className='font-medium text-foreground truncate'>
                              {proposed?.name} ({proposed?.relationship})
                            </span>
                          </div>
                        )}

                        {req.changeType === ProfileChangeType.BANK_DETAILS && (
                          <div className='text-xs truncate font-medium'>
                            {proposed?.bankName} ({proposed?.accountNumberMasked || 'Updated'})
                          </div>
                        )}
                      </td>

                      <td className='py-3 px-4 text-muted-foreground'>
                        {new Date(req.submittedAt).toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>

                      <td className='py-3 px-4'>
                        {renderStatusBadge(req.status)}
                      </td>

                      <td className='py-3 px-4 text-right'>
                        {req.status === ProfileChangeStatus.PENDING ? (
                          <div className='flex items-center justify-end gap-1.5'>
                            <Button
                              size='sm'
                              variant='outline'
                              onClick={() => {
                                setSelectedRequest(req)
                                setApproveModalOpen(true)
                              }}
                              disabled={isOwnRequest}
                              className='h-7 px-2.5 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10 border-emerald-500/30'
                            >
                              Approve
                            </Button>
                            <Button
                              size='sm'
                              variant='outline'
                              onClick={() => {
                                setSelectedRequest(req)
                                setRejectModalOpen(true)
                              }}
                              disabled={isOwnRequest}
                              className='h-7 px-2.5 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-500/10 border-rose-500/30'
                            >
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <Button
                            size='sm'
                            variant='ghost'
                            onClick={() => setSelectedRequest(req)}
                            className='h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground'
                          >
                            Details
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Approve Confirmation Modal */}
      <Dialog open={approveModalOpen} onOpenChange={setApproveModalOpen}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle className='flex items-center gap-2 text-emerald-600'>
              <CheckCircle2 className='w-5 h-5' /> Approve Profile Change
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to approve this request? Once approved, the changes will be applied to the member's active profile in an atomic transaction.
            </DialogDescription>
          </DialogHeader>

          {selectedRequest && (
            <div className='bg-muted/50 p-3.5 rounded-lg text-xs flex flex-col gap-2 my-2 border'>
              <div className='flex justify-between'>
                <span className='text-muted-foreground'>Member:</span>
                <span className='font-semibold'>{selectedRequest.user.name} ({selectedRequest.user.email})</span>
              </div>
              <div className='flex justify-between'>
                <span className='text-muted-foreground'>Change Type:</span>
                <span className='font-semibold'>{selectedRequest.changeType}</span>
              </div>

              {selectedRequest.changeType === ProfileChangeType.PRIMARY_BANK && (
                <div className='mt-2 pt-2 border-t flex flex-col gap-1'>
                  <span className='text-muted-foreground font-medium'>New Primary Bank:</span>
                  <div className='bg-background p-2 rounded border text-foreground font-mono'>
                    {(selectedRequest.proposedValue as any)?.bankName} — {(selectedRequest.proposedValue as any)?.accountNumberMasked}
                  </div>
                </div>
              )}

              {selectedRequest.changeType === ProfileChangeType.NEXT_OF_KIN && (
                <div className='mt-2 pt-2 border-t flex flex-col gap-1'>
                  <span className='text-muted-foreground font-medium'>New Next of Kin:</span>
                  <div className='bg-background p-2 rounded border text-foreground flex flex-col gap-0.5'>
                    <span className='font-semibold'>{(selectedRequest.proposedValue as any)?.name} ({(selectedRequest.proposedValue as any)?.relationship})</span>
                    <span className='text-muted-foreground'>Phone: {(selectedRequest.proposedValue as any)?.phoneNumber}</span>
                    <span className='text-muted-foreground'>Bank: {(selectedRequest.proposedValue as any)?.bankName} ({(selectedRequest.proposedValue as any)?.accountNumberMasked})</span>
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter className='gap-2 sm:gap-0'>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => setApproveModalOpen(false)}
              disabled={isProcessing}
            >
              Cancel
            </Button>
            <Button
              size='sm'
              onClick={handleApprove}
              disabled={isProcessing}
              className='bg-emerald-600 hover:bg-emerald-700 text-white'
            >
              {isProcessing ? 'Applying Change...' : 'Confirm & Apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Reason Modal */}
      <Dialog open={rejectModalOpen} onOpenChange={setRejectModalOpen}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle className='flex items-center gap-2 text-rose-600'>
              <AlertTriangle className='w-5 h-5' /> Reject Profile Change
            </DialogTitle>
            <DialogDescription>
              State the reason for rejecting this change. The reason will be recorded and presented to the member.
            </DialogDescription>
          </DialogHeader>

          <div className='flex flex-col gap-2 my-2'>
            <Label htmlFor='rejectReason' className='text-xs font-semibold'>
              Rejection Reason <span className='text-rose-500'>*</span>
            </Label>
            <Textarea
              id='rejectReason'
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder='e.g., Name on bank account does not match registered profile identity; contact proof invalid.'
              rows={3}
              className='text-xs'
            />
          </div>

          <DialogFooter className='gap-2 sm:gap-0'>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => {
                setRejectModalOpen(false)
                setRejectionReason('')
              }}
              disabled={isProcessing}
            >
              Cancel
            </Button>
            <Button
              variant='destructive'
              size='sm'
              onClick={handleReject}
              disabled={isProcessing || !rejectionReason.trim()}
            >
              {isProcessing ? 'Rejecting...' : 'Confirm Rejection'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
