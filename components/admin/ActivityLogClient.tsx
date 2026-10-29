'use client'

import React, { useState, useTransition } from 'react'
import {
  ShieldCheck,
  Search,
  Filter,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Info,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Eye,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { getAdminAuditEventsQuery } from '@/models/admin/query'
import { UserRole } from '@/generated/prisma/enums'

export interface AuditEventItem {
  id: string
  action: string
  entityType: string
  entityId: string | null
  outcome: string
  metadata: any
  beforeState: any
  afterState: any
  correlationId: string | null
  ipHash: string | null
  userAgent: string | null
  isSingleOperator: boolean
  createdAt: string | Date
  actorRole: UserRole | null
  actor: {
    id: string
    name: string | null
    email: string
    role: UserRole
  } | null
  affectedUser: {
    id: string
    name: string | null
    email: string
    role: UserRole
    membership: {
      membershipNumber: string | null
    } | null
  } | null
}

interface ActivityLogClientProps {
  initialData: {
    events: AuditEventItem[]
    total: number
    page: number
    pageSize: number
    totalPages: number
  }
}

export function ActivityLogClient({ initialData }: ActivityLogClientProps) {
  const [data, setData] = useState(initialData)
  const [isPending, startTransition] = useTransition()

  // Filter states
  const [searchTerm, setSearchTerm] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('ALL')
  const [outcomeFilter, setOutcomeFilter] = useState('ALL')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [selectedEvent, setSelectedEvent] = useState<AuditEventItem | null>(
    null,
  )

  const fetchEvents = (page = 1, currentFilters = {}) => {
    startTransition(async () => {
      const activeCategory = (currentFilters as any).category ?? categoryFilter
      const activeOutcome = (currentFilters as any).outcome ?? outcomeFilter
      const activeSearch = (currentFilters as any).search ?? searchTerm
      const activeStart = (currentFilters as any).start ?? startDate
      const activeEnd = (currentFilters as any).end ?? endDate

      const params: any = {
        page,
        pageSize: data.pageSize,
      }

      if (activeSearch) params.search = activeSearch
      if (activeStart) params.startDate = activeStart
      if (activeEnd) params.endDate = activeEnd
      if (activeOutcome !== 'ALL') params.outcome = activeOutcome

      if (activeCategory !== 'ALL') {
        params.action = activeCategory
      }

      const res = await getAdminAuditEventsQuery(params)
      if (res.success && res.data) {
        setData(res.data as any)
      }
    })
  }

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    fetchEvents(1, { search: searchTerm })
  }

  const handleClearFilters = () => {
    setSearchTerm('')
    setCategoryFilter('ALL')
    setOutcomeFilter('ALL')
    setStartDate('')
    setEndDate('')
    fetchEvents(1, {
      search: '',
      category: 'ALL',
      outcome: 'ALL',
      start: '',
      end: '',
    })
  }

  const getActionBadgeColor = (action: string) => {
    if (action.startsWith('AUTH.'))
      return 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300'
    if (action.startsWith('ADMIN.') || action.startsWith('STAFF.'))
      return 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/40 dark:text-purple-300'
    if (action.startsWith('SECURITY.'))
      return 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300'
    if (action.startsWith('RECEIPT.') || action.startsWith('FINANCIAL.'))
      return 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300'
    if (action.startsWith('LOAN.') || action.startsWith('GUARANTEE.'))
      return 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-300'
    if (action.startsWith('SAVINGS.'))
      return 'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/40 dark:text-teal-300'
    if (action.startsWith('EAJO.'))
      return 'bg-cyan-100 text-cyan-800 border-cyan-200 dark:bg-cyan-900/40 dark:text-cyan-300'
    return 'bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-800 dark:text-slate-300'
  }

  return (
    <div className='space-y-6'>
      {/* Header */}
      <div className='flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-border/50 pb-5'>
        <div>
          <div className='flex items-center gap-2'>
            <h1 className='text-2xl font-bold tracking-tight text-foreground'>
              Immutable Activity & Audit Log
            </h1>
            <Badge variant='outline' className='font-mono text-xs'>
              {data.total} Total Events
            </Badge>
          </div>
          <p className='text-sm text-muted-foreground mt-1'>
            Tamper-proof, append-only chronological record of all
            administrative, authentication, and financial operations.
          </p>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className='bg-card border border-border/50 rounded-xl p-4 shadow-sm space-y-3'>
        <form
          onSubmit={handleSearchSubmit}
          className='grid grid-cols-1 md:grid-cols-4 gap-3'
        >
          <div className='md:col-span-2 relative'>
            <Search className='absolute left-3 top-2.5 h-4 w-4 text-muted-foreground' />
            <Input
              placeholder='Search by action, email, name, correlation ID...'
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className='pl-9 h-9 text-sm'
            />
          </div>

          <div>
            <select
              value={outcomeFilter}
              onChange={(e) => {
                setOutcomeFilter(e.target.value)
                fetchEvents(1, { outcome: e.target.value })
              }}
              className='w-full h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
            >
              <option value='ALL'>All Outcomes</option>
              <option value='SUCCESS'>Success</option>
              <option value='FAILURE'>Failure</option>
              <option value='DENIED'>Denied</option>
              <option value='BLOCKED'>Blocked</option>
            </select>
          </div>

          <div className='flex gap-2'>
            <Button
              type='submit'
              size='sm'
              className='flex-1 h-9 font-medium'
              disabled={isPending}
            >
              Search
            </Button>
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={handleClearFilters}
              className='h-9'
              disabled={isPending}
            >
              Reset
            </Button>
          </div>
        </form>

        <div className='flex flex-wrap items-center gap-3 pt-2 border-t border-border/30 text-xs'>
          <div className='flex items-center gap-1.5 text-muted-foreground'>
            <Calendar className='w-3.5 h-3.5' />
            <span>Date Range:</span>
          </div>
          <input
            type='date'
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value)
              fetchEvents(1, { start: e.target.value })
            }}
            className='h-8 rounded border border-input bg-background px-2 text-xs'
          />
          <span className='text-muted-foreground'>to</span>
          <input
            type='date'
            value={endDate}
            onChange={(e) => {
              setEndDate(e.target.value)
              fetchEvents(1, { end: e.target.value })
            }}
            className='h-8 rounded border border-input bg-background px-2 text-xs'
          />
        </div>
      </div>

      {/* Main Table */}
      <div className='bg-card border border-border/50 rounded-xl overflow-hidden shadow-sm'>
        <div className='overflow-x-auto'>
          <table className='w-full text-xs text-left border-collapse'>
            <thead>
              <tr className='bg-muted/50 border-b border-border/60 text-muted-foreground font-semibold'>
                <th className='p-3'>Timestamp</th>
                <th className='p-3'>Action</th>
                <th className='p-3'>Actor</th>
                <th className='p-3'>Target / Affected</th>
                <th className='p-3'>Entity</th>
                <th className='p-3 text-center'>Outcome</th>
                <th className='p-3 text-center'>Dual Control</th>
                <th className='p-3 text-right'>Details</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-border/40'>
              {data.events.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className='p-12 text-center text-muted-foreground italic'
                  >
                    No activity audit events found matching your criteria.
                  </td>
                </tr>
              ) : (
                data.events.map((evt) => {
                  const dateStr = new Date(evt.createdAt).toLocaleString(
                    'en-NG',
                    {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    },
                  )

                  return (
                    <tr
                      key={evt.id}
                      className='hover:bg-muted/30 transition-colors'
                    >
                      <td className='p-3 whitespace-nowrap font-mono text-[11px] text-muted-foreground'>
                        {dateStr}
                      </td>

                      <td className='p-3 whitespace-nowrap'>
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[11px] font-mono font-medium border ${getActionBadgeColor(
                            evt.action,
                          )}`}
                        >
                          {evt.action}
                        </span>
                      </td>

                      <td className='p-3'>
                        {evt.actor ? (
                          <div>
                            <div className='font-medium text-foreground'>
                              {evt.actor.name || 'Staff User'}
                            </div>
                            <div className='text-[11px] text-muted-foreground font-mono'>
                              {evt.actor.email} ({evt.actor.role})
                            </div>
                          </div>
                        ) : (
                          <span className='text-muted-foreground italic'>
                            System Job
                          </span>
                        )}
                      </td>

                      <td className='p-3'>
                        {evt.affectedUser ? (
                          <div>
                            <div className='font-medium text-foreground'>
                              {evt.affectedUser.name || 'Member'}
                            </div>
                            <div className='text-[11px] text-muted-foreground font-mono'>
                              {evt.affectedUser.membership?.membershipNumber ||
                                evt.affectedUser.email}
                            </div>
                          </div>
                        ) : (
                          <span className='text-muted-foreground'>-</span>
                        )}
                      </td>

                      <td className='p-3 whitespace-nowrap'>
                        <div className='font-medium'>{evt.entityType}</div>
                        {evt.entityId && (
                          <div className='text-[10px] text-muted-foreground font-mono truncate max-w-30'>
                            {evt.entityId}
                          </div>
                        )}
                      </td>

                      <td className='p-3 text-center whitespace-nowrap'>
                        {evt.outcome === 'SUCCESS' ? (
                          <span className='inline-flex items-center gap-1 text-emerald-600 font-semibold text-[11px]'>
                            <CheckCircle2 className='w-3.5 h-3.5' />
                            SUCCESS
                          </span>
                        ) : (
                          <span className='inline-flex items-center gap-1 text-rose-600 font-semibold text-[11px]'>
                            <XCircle className='w-3.5 h-3.5' />
                            {evt.outcome}
                          </span>
                        )}
                      </td>

                      <td className='p-3 text-center whitespace-nowrap'>
                        {evt.isSingleOperator ? (
                          <Badge
                            variant='destructive'
                            className='text-[10px] font-bold'
                          >
                            OVERRIDE
                          </Badge>
                        ) : (
                          <span className='text-muted-foreground text-[11px]'>
                            -
                          </span>
                        )}
                      </td>

                      <td className='p-3 text-right whitespace-nowrap'>
                        <Button
                          variant='ghost'
                          size='sm'
                          onClick={() => setSelectedEvent(evt)}
                          className='h-7 px-2 text-xs font-semibold text-primary'
                        >
                          <Eye className='w-3.5 h-3.5 mr-1' />
                          View
                        </Button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Safe Pagination Controls */}
        <div className='p-3 border-t border-border/50 flex flex-col sm:flex-row justify-between items-center gap-3 bg-muted/20 text-xs'>
          <div className='text-muted-foreground'>
            Showing Page{' '}
            <span className='font-semibold text-foreground'>{data.page}</span>{' '}
            of{' '}
            <span className='font-semibold text-foreground'>
              {Math.max(1, data.totalPages)}
            </span>{' '}
            ({data.total} records)
          </div>

          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              onClick={() => fetchEvents(data.page - 1)}
              disabled={data.page <= 1 || isPending}
              className='h-8 px-2 text-xs'
            >
              <ChevronLeft className='w-3.5 h-3.5 mr-1' />
              Previous
            </Button>
            <Button
              variant='outline'
              size='sm'
              onClick={() => fetchEvents(data.page + 1)}
              disabled={data.page >= data.totalPages || isPending}
              className='h-8 px-2 text-xs'
            >
              Next
              <ChevronRight className='w-3.5 h-3.5 ml-1' />
            </Button>
          </div>
        </div>
      </div>

      {/* Inspect Event Modal / Drawer */}
      {selectedEvent && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4'>
          <div className='bg-background border border-border rounded-xl shadow-xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col animate-in fade-in zoom-in-95'>
            {/* Modal Header */}
            <div className='p-4 border-b border-border flex justify-between items-center bg-muted/40'>
              <div className='flex items-center gap-2'>
                <ShieldCheck className='w-5 h-5 text-primary' />
                <h3 className='font-bold text-base text-foreground'>
                  Audit Event Payload Details
                </h3>
              </div>
              <Button
                variant='ghost'
                size='sm'
                onClick={() => setSelectedEvent(null)}
                className='h-8 w-8 p-0 rounded-full'
              >
                <X className='w-4 h-4' />
              </Button>
            </div>

            {/* Modal Content */}
            <div className='p-5 overflow-y-auto space-y-4 text-xs font-mono'>
              <div className='grid grid-cols-2 gap-3 p-3 bg-muted/30 rounded-lg'>
                <div>
                  <span className='text-muted-foreground block text-[10px] uppercase font-sans'>
                    Event ID
                  </span>
                  <span className='text-foreground select-all'>
                    {selectedEvent.id}
                  </span>
                </div>
                <div>
                  <span className='text-muted-foreground block text-[10px] uppercase font-sans'>
                    Correlation ID
                  </span>
                  <span className='text-foreground select-all'>
                    {selectedEvent.correlationId || 'N/A'}
                  </span>
                </div>
                <div>
                  <span className='text-muted-foreground block text-[10px] uppercase font-sans'>
                    IP Hash
                  </span>
                  <span className='text-foreground select-all truncate block'>
                    {selectedEvent.ipHash || 'N/A'}
                  </span>
                </div>
                <div>
                  <span className='text-muted-foreground block text-[10px] uppercase font-sans'>
                    Timestamp
                  </span>
                  <span className='text-foreground'>
                    {new Date(selectedEvent.createdAt).toISOString()}
                  </span>
                </div>
              </div>

              {selectedEvent.metadata && (
                <div>
                  <span className='text-xs font-bold font-sans uppercase text-muted-foreground block mb-1'>
                    Safe Metadata
                  </span>
                  <pre className='p-3 bg-muted/50 border border-border/40 rounded-lg overflow-x-auto text-[11px] text-foreground'>
                    {JSON.stringify(selectedEvent.metadata, null, 2)}
                  </pre>
                </div>
              )}

              {selectedEvent.beforeState && (
                <div>
                  <span className='text-xs font-bold font-sans uppercase text-muted-foreground block mb-1'>
                    Before State
                  </span>
                  <pre className='p-3 bg-muted/50 border border-border/40 rounded-lg overflow-x-auto text-[11px] text-foreground'>
                    {JSON.stringify(selectedEvent.beforeState, null, 2)}
                  </pre>
                </div>
              )}

              {selectedEvent.afterState && (
                <div>
                  <span className='text-xs font-bold font-sans uppercase text-muted-foreground block mb-1'>
                    After State
                  </span>
                  <pre className='p-3 bg-muted/50 border border-border/40 rounded-lg overflow-x-auto text-[11px] text-foreground'>
                    {JSON.stringify(selectedEvent.afterState, null, 2)}
                  </pre>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className='p-3 border-t border-border bg-muted/20 flex justify-end'>
              <Button
                variant='outline'
                size='sm'
                onClick={() => setSelectedEvent(null)}
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
