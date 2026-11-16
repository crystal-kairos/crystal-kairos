'use client'

import { loanStatusLabel } from '../loans/loanDisplay'
import { useState } from 'react'
import Link from 'next/link'
import {
  FileText,
  CheckCircle2,
  XCircle,
  Clock,
  TrendingUp,
  AlertTriangle,
  Search,
  ArrowRight
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

interface AdminLoanItem {
  id: string
  requestedAmount: number
  approvedAmount: number | null
  interestRate: number
  duration: number
  status: string
  requestedAt: Date
  user: {
    id: string
    name: string
    email: string
    photoUrl: string | null
  }
}

interface AdminLoansClientProps {
  loans: AdminLoanItem[]
}

const STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-amber-50 text-amber-700 border-amber-200',
  APPROVED: 'bg-blue-50 text-blue-700 border-blue-200',
  DISBURSED: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  ACTIVE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  COMPLETED: 'bg-slate-100 text-slate-600 border-slate-200',
  REJECTED: 'bg-red-50 text-red-700 border-red-200',
  DEFAULTED: 'bg-rose-50 text-rose-700 border-rose-200',
  OVERDUE: 'bg-orange-50 text-orange-700 border-orange-200',
}

const STATUS_ICONS: Record<string, React.ElementType> = {
  PENDING: Clock,
  APPROVED: CheckCircle2,
  DISBURSED: TrendingUp,
  ACTIVE: TrendingUp,
  COMPLETED: CheckCircle2,
  REJECTED: XCircle,
  DEFAULTED: AlertTriangle,
  OVERDUE: AlertTriangle,
}

const formatCurrency = (val: number) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 0 }).format(val)

export const AdminLoansClient = ({ loans }: AdminLoansClientProps) => {
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState('ALL')

  const filteredLoans = loans.filter((loan) => {
    const matchesSearch =
      loan.user.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      loan.user.email.toLowerCase().includes(searchTerm.toLowerCase())
    const matchesStatus = statusFilter === 'ALL' || loan.status === statusFilter
    return matchesSearch && matchesStatus
  })

  const pendingCount = loans.filter(l => l.status === 'PENDING').length
  const activeCount = loans.filter(l => l.status === 'ACTIVE').length

  return (
    <div className="flex flex-col gap-6 max-w-6xl mx-auto py-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold font-heading text-primary leading-tight">Loan Management</h2>
          <p className="text-muted-foreground text-sm mt-1">
            Review, approve, and disburse loan requests from members.
          </p>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Requests', value: loans.length, icon: FileText },
          { label: 'Active Loans', value: activeCount, icon: TrendingUp },
          { label: 'Pending Approval', value: pendingCount, icon: Clock },
        ].map(({ label, value, icon: Icon }) => (
          <Card key={label} className="bg-surface-container shadow-none border-0 rounded-xl">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
                <Icon className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xl font-bold text-primary font-mono">{value}</p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters and Search */}
      <div className="flex flex-col sm:flex-row justify-between gap-4 items-center bg-surface-container/50 p-2 rounded-xl border border-outline-variant/20">
        <div className="flex gap-1 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
          {['ALL', 'PENDING', 'APPROVED', 'AWAITING_RECONSENT', 'ACCEPTED', 'ACTIVE', 'OVERDUE', 'COMPLETED', 'REJECTED'].map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-colors shrink-0 ${
                statusFilter === status 
                  ? 'bg-primary text-on-primary' 
                  : 'text-muted-foreground hover:bg-outline-variant/20'
              }`}
            >
              {status === 'ALL' ? 'All' : loanStatusLabel(status)}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or email..."
            className="pl-9 h-9 text-xs rounded-lg border-outline-variant/50 focus-visible:ring-primary/20"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      {/* Loans list */}
      <div className="flex flex-col gap-3">
        {filteredLoans.length === 0 ? (
          <div className="border border-dashed border-outline-variant/30 rounded-xl py-20 flex flex-col items-center gap-3">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center text-primary">
              <FileText className="w-7 h-7" />
            </div>
            <p className="text-sm text-muted-foreground font-medium text-center max-w-xs">
              No loans found matching the selected filters.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredLoans.map((loan) => {
              const StatusIcon = STATUS_ICONS[loan.status] || FileText
              return (
                <Card
                  key={loan.id}
                  className="bg-surface-container border-0 shadow-none rounded-xl hover:ring-1 hover:ring-primary/20 transition-all"
                >
                  <CardContent className="p-5 flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs shrink-0">
                          {loan.user.name.charAt(0)}
                        </div>
                        <div className="min-w-0">
                          <h4 className="font-bold text-primary text-sm truncate">{loan.user.name}</h4>
                          <p className="text-[10px] text-muted-foreground truncate">{loan.user.email}</p>
                        </div>
                      </div>
                      <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border shrink-0 ${STATUS_STYLES[loan.status]}`}>
                        <StatusIcon className="w-3 h-3" />
                        {loanStatusLabel(loan.status)}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs py-3 mt-2 border-y border-outline-variant/15">
                      <div>
                        <span className="text-[9px] text-muted-foreground uppercase tracking-wider block mb-0.5">Amount</span>
                        <span className="font-bold text-primary font-mono text-[13px]">
                          {formatCurrency(loan.approvedAmount || loan.requestedAmount)}
                        </span>
                      </div>
                      <div>
                        <span className="text-[9px] text-muted-foreground uppercase tracking-wider block mb-0.5">Duration</span>
                        <span className="font-semibold text-primary text-[11px]">{loan.duration} Months @ {loan.interestRate}%</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <Clock className="w-3 h-3" />
                        <span>
                          Applied {new Date(loan.requestedAt).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </span>
                      </div>
                      <Button asChild variant="ghost" className="text-primary hover:bg-primary/5 h-7 px-3 text-[11px] font-bold rounded-md cursor-pointer">
                        <Link href={`/admin/loans/${loan.id}`}>
                          View Details <ArrowRight className="w-3 h-3 ml-1" />
                        </Link>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
