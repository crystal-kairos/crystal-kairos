'use client'

import React from 'react'
import {
  Calendar,
  PlusCircle,
  ShieldCheck,
  ArrowLeft,
  ChevronRight,
} from 'lucide-react'
import Link from 'next/link'
import { Card } from '../ui/card'
import { Button } from '../ui/button'
import { LoanStatusBadge } from './loanDisplay'

interface LoanPlan {
  id: string
  requestedAmount: number
  approvedAmount: number | null
  interestRate: number
  duration: number
  purpose: string
  outstandingBalance: number
  totalRepaid: number
  status: string
  createdAt: Date | string
}

interface LoansHubClientProps {
  userId: string
  loans: LoanPlan[]
  totalSavings: number
}

export const LoansHubClient = ({ userId, loans, totalSavings }: LoansHubClientProps) => {
  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 0,
    }).format(val)
  }

  const maxBorrowLimit = totalSavings * 2
  const totalOutstanding = loans.reduce((sum, l) => sum + l.outstandingBalance, 0)

  return (
    <div className="flex flex-col gap-6 w-full max-w-5xl mx-auto py-6">
      
      {/* Back button */}
      <div className="flex items-center gap-1.5 text-muted-foreground hover:text-primary cursor-pointer transition-colors w-fit text-xs font-semibold">
        <ArrowLeft className="w-4 h-4" />
        <Link href={`/dashboard/${userId}`}>Back to Dashboard</Link>
      </div>

      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold font-heading text-primary leading-tight">
            Borrowing Hub
          </h2>
          <p className="text-muted-foreground text-sm mt-1">
            Access affordable cooperative credit lines and request custom loan approvals.
          </p>
        </div>
        <Button asChild className="cursor-pointer rounded-sm bg-primary hover:bg-primary/95 text-on-primary font-semibold flex items-center justify-center gap-1.5 h-10 px-5 shadow-sm">
          <Link href={`/dashboard/${userId}/loans/new`}>
            <PlusCircle className="w-4 h-4" />
            <span>Apply for Loan</span>
          </Link>
        </Button>
      </header>

      {/* Borrow limits widgets */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card className="border-0 bg-primary text-on-primary rounded-md shadow-none relative overflow-hidden p-6 min-h-[120px] flex flex-col justify-between">
          <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full blur-2xl pointer-events-none" />
          <span className="text-[10px] uppercase tracking-wider font-semibold opacity-85">Standalone Borrowing Limit</span>
          <span className="text-3xl font-extrabold font-mono mt-2">{formatCurrency(maxBorrowLimit)}</span>
          <span className="text-[10px] opacity-75 mt-2">2 × your savings ({formatCurrency(totalSavings)}); a guarantor can add capacity</span>
        </Card>

        <Card className="border-0 bg-surface-container rounded-md shadow-none p-6 min-h-[120px] flex flex-col justify-between">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Outstanding Loan Balance</span>
          <span className="text-3xl font-extrabold text-secondary font-mono mt-2">{formatCurrency(totalOutstanding)}</span>
          <span className="text-[10px] text-muted-foreground mt-2">Active debt remaining to repay</span>
        </Card>

        <Card className="border-0 bg-surface-container rounded-md shadow-none p-6 min-h-[120px] flex flex-col justify-between">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Active Credit Lines</span>
          <span className="text-3xl font-extrabold text-primary font-mono mt-2">
            {loans.filter((l) => l.status === 'ACTIVE' || l.status === 'OVERDUE').length} / {loans.length}
          </span>
          <span className="text-[10px] text-muted-foreground mt-2">Total loan applications approved</span>
        </Card>
      </section>

      {/* Loan applications list */}
      <section className="flex flex-col gap-3">
        <h3 className="font-bold text-sm text-primary uppercase tracking-wide">My Loans</h3>
        {loans.length === 0 ? (
          <div className="border border-dashed border-outline-variant/30 rounded-lg py-12 text-center text-xs text-muted-foreground font-medium bg-surface-container-lowest">
            No loans requested yet. Click &ldquo;Apply for Loan&rdquo; above to begin.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {loans.map((loan) => (
              <Link key={loan.id} href={`/dashboard/${userId}/loans/${loan.id}`}>
                <Card className="border-0 bg-surface-container rounded-md shadow-none hover:ring-1 hover:ring-primary/20 transition-all duration-200 cursor-pointer p-5 flex flex-col justify-between min-h-[160px] group">
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <h4 className="font-bold text-primary text-sm flex items-center gap-1.5 truncate max-w-[240px]">
                        <span>{loan.purpose}</span>
                        <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
                      </h4>
                      <p className="text-[10px] text-muted-foreground mt-0.5">ID: #{loan.id.substring(0, 8).toUpperCase()}</p>
                    </div>
                    <LoanStatusBadge status={loan.status} />
                  </div>

                  <div className="grid grid-cols-3 gap-2 py-2 border-y border-outline-variant/20 mb-3 text-xs">
                    <div>
                      <span className="text-[9px] text-muted-foreground uppercase tracking-wider block">Requested</span>
                      <span className="font-bold text-primary font-mono">{formatCurrency(loan.requestedAmount)}</span>
                    </div>
                    <div>
                      <span className="text-[9px] text-muted-foreground uppercase tracking-wider block">Outstanding</span>
                      <span className="font-bold text-secondary font-mono">{formatCurrency(loan.outstandingBalance)}</span>
                    </div>
                    <div>
                      <span className="text-[9px] text-muted-foreground uppercase tracking-wider block">Monthly Rate</span>
                      <span className="font-bold text-primary font-mono">{loan.interestRate}%</span>
                    </div>
                  </div>

                  <div className="flex justify-between items-center text-[10px] text-muted-foreground">
                    <span>Repaid: {formatCurrency(loan.totalRepaid)}</span>
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5" />
                      <span>Term: {loan.duration} Months</span>
                    </span>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <div className="bg-success-green/10 border border-success-green/20 rounded-xl p-4 flex items-start gap-2.5 mt-4">
        <ShieldCheck className="w-5 h-5 text-success-green shrink-0 mt-0.5" />
        <div>
          <h4 className="text-xs font-bold text-primary">Cooperative Credit Backing</h4>
          <p className="text-[10px] text-muted-foreground leading-normal mt-0.5">
            Rates are flat per month on the amount borrowed and are set by the cooperative for each term. Every loan is reviewed by an administrator and needs a consenting guarantor.
          </p>
        </div>
      </div>

    </div>
  )
}
export default LoansHubClient
