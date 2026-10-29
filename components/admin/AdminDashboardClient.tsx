'use client'

import React from 'react'
import {
  AlertTriangle,
  Receipt,
  Coins,
  Users,
  Handshake,
  ArrowRight,
  TrendingUp,
  ListTodo,
  ShieldCheck,
  CircleDollarSign,
} from 'lucide-react'
import Link from 'next/link'
import { Card } from '../ui/card'
import { Button } from '../ui/button'

interface RecentAction {
  id: string
  timestamp: Date
  adminName: string
  action: string
  target: string
  status: string
}

interface AdminStats {
  pendingReceiptsCount: number
  disbursementsDueCount: number
  activeMembersCount: number
  activeGroupsCount: number
  pendingKycCount: number
  recentActions: RecentAction[]
}

interface AdminDashboardClientProps {
  stats: AdminStats
  membersChange: number
}

export const AdminDashboardClient = ({ stats, membersChange }: AdminDashboardClientProps) => {
  const formatTime = (dateInput: Date) => {
    const d = new Date(dateInput)
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div className="flex flex-col gap-6 w-full py-2">
      
      {/* 1. Urgent Action Required Nudge Banner */}
      {stats.disbursementsDueCount > 0 && (
        <div className="bg-light-red border-l border-error-red p-4 rounded-md flex items-start gap-3 shadow-sm animate-in fade-in slide-in-from-top-4 duration-300">
          <AlertTriangle className="w-5 h-5 text-error-red shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="text-xs font-bold text-error-red uppercase tracking-wider">Urgent Action Required</h3>
            <p className="text-xs text-on-background mt-1 leading-relaxed">
              There are <span className="font-bold">{stats.disbursementsDueCount}</span> scheduled disbursements due today that require administrative authorization.
            </p>
          </div>
          <Button asChild variant="ghost" className="text-xs font-bold text-error-red hover:underline p-0 h-auto cursor-pointer hover:bg-transparent">
            <Link href="/admin/disbursements">Review Now</Link>
          </Button>
        </div>
      )}

      {/* 2. Dashboard Title */}
      <div>
        <h2 className="text-2xl font-bold font-heading text-primary leading-tight">
          System Overview
        </h2>
        <p className="text-muted-foreground text-xs mt-1">
          Real-time metrics and activity for the cooperative network.
        </p>
      </div>

      {/* 3. Bento Grid: Summary Cards */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Pending Receipts */}
        <Link href="/admin/verification" className="block">
          <Card className="bg-surface-container-lowest border border-outline-variant/15 rounded-lg p-5 shadow-sm flex flex-col justify-between h-32 hover:border-warning-amber/50 transition-all duration-200 cursor-pointer group">
            <div className="flex justify-between items-start">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Pending Receipts</span>
              <div className="w-8 h-8 rounded bg-light-amber flex items-center justify-center text-warning-amber group-hover:scale-110 transition-transform">
                <Receipt className="w-4.5 h-4.5" />
              </div>
            </div>
            <div className="flex items-baseline gap-1 mt-2">
              <span className="text-3xl font-extrabold text-warning-amber font-mono">{stats.pendingReceiptsCount}</span>
              <span className="text-[10px] text-muted-foreground font-semibold">awaiting review</span>
            </div>
          </Card>
        </Link>

        {/* Card 2: Disbursements Due */}
        <Link href="/admin/disbursements" className="block">
          <Card className="bg-surface-container-lowest border border-outline-variant/15 rounded-lg p-5 shadow-sm flex flex-col justify-between h-32 hover:border-error-red/50 transition-all duration-200 cursor-pointer group">
            <div className="flex justify-between items-start">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Disbursements Due</span>
              <div className="w-8 h-8 rounded bg-light-red flex items-center justify-center text-error-red group-hover:scale-110 transition-transform">
                <CircleDollarSign className="w-4.5 h-4.5" />
              </div>
            </div>
            <div className="flex items-baseline gap-1 mt-2">
              <span className="text-3xl font-extrabold text-error-red font-mono">{stats.disbursementsDueCount}</span>
              <span className="text-[10px] text-muted-foreground font-semibold">scheduled today</span>
            </div>
          </Card>
        </Link>

        {/* Card 3: Active Members */}
        <Link href="/admin/members" className="block">
          <Card className="bg-surface-container-lowest border border-outline-variant/15 rounded-lg p-5 shadow-sm flex flex-col justify-between h-32 hover:border-primary/50 transition-all duration-200 cursor-pointer group">
            <div className="flex justify-between items-start">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Active Members</span>
              <div className="w-8 h-8 rounded bg-light-blue flex items-center justify-center text-primary group-hover:scale-110 transition-transform">
                <Users className="w-4.5 h-4.5" />
              </div>
            </div>
            <div className="flex items-baseline gap-1.5 mt-2">
              <span className="text-3xl font-extrabold text-primary font-mono">{stats.activeMembersCount}</span>
              <span className="text-[10px] text-success-green flex items-center gap-0.5 font-semibold">
                <TrendingUp className="w-3.5 h-3.5" />
                <span>+{membersChange} this week</span>
              </span>
            </div>
          </Card>
        </Link>

        {/* Card 4: Active Groups */}
        <Link href="/admin/eajo" className="block">
          <Card className="bg-surface-container-lowest border border-outline-variant/15 rounded-lg p-5 shadow-sm flex flex-col justify-between h-32 hover:border-slate-grey/50 transition-all duration-200 cursor-pointer group">
            <div className="flex justify-between items-start">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Active Ajo Groups</span>
              <div className="w-8 h-8 rounded bg-surface-container flex items-center justify-center text-slate-grey group-hover:scale-110 transition-transform">
                <Coins className="w-4.5 h-4.5" />
              </div>
            </div>
            <div className="flex items-baseline gap-1 mt-2">
              <span className="text-3xl font-extrabold text-primary font-mono">{stats.activeGroupsCount}</span>
              <span className="text-[10px] text-muted-foreground font-semibold">running cycles</span>
            </div>
          </Card>
        </Link>
      </section>

      {/* 4. Asymmetric Grid Layout: Recent Actions Feed & Sidebar Widgets */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        
        {/* Left 2/3 Main Panel: Recent Activity Log */}
        <div className="lg:col-span-2 bg-surface-container-lowest border border-outline-variant/10 rounded-xl shadow-sm overflow-hidden flex flex-col">
          <div className="p-4 border-b border-outline-variant/15 flex justify-between items-center bg-surface-container-low/50">
            <h3 className="font-bold text-sm text-primary uppercase tracking-wide">Recent Admin Actions</h3>
            <Button asChild variant="ghost" className="text-xs font-bold text-primary hover:underline hover:bg-transparent flex items-center gap-1 p-0 h-auto cursor-pointer">
              <Link href="/admin/activity">
                <span>View Full Log</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </Button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="bg-primary text-on-primary font-bold">
                  <th className="p-3 font-normal opacity-90">Timestamp</th>
                  <th className="p-3 font-normal opacity-90">Admin</th>
                  <th className="p-3 font-normal opacity-90">Action</th>
                  <th className="p-3 font-normal opacity-90">Target Entity</th>
                  <th className="p-3 font-normal opacity-90 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/15 text-muted-foreground">
                {stats.recentActions.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-muted-foreground font-medium italic">
                      No administrative transactions verified yet.
                    </td>
                  </tr>
                ) : (
                  stats.recentActions.map((action) => (
                    <tr key={action.id} className="hover:bg-surface-container-low transition-colors text-primary font-medium">
                      <td className="p-3 whitespace-nowrap text-muted-foreground">
                        {formatTime(action.timestamp)}
                      </td>
                      <td className="p-3 font-semibold text-primary">{action.adminName}</td>
                      <td className="p-3">{action.action}</td>
                      <td className="p-3 text-secondary font-mono hover:underline cursor-pointer">
                        {action.target}
                      </td>
                      <td className="p-3 text-center whitespace-nowrap">
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border ${
                          action.status === 'CONFIRMED' || action.status === 'DISBURSED'
                            ? 'bg-light-green text-success-green border-success-green/20'
                            : 'bg-error-container/10 text-error border-error-container/20'
                        }`}>
                          {action.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right 1/3 Column Panel: Verification Queue & Health Widget */}
        <div className="flex flex-col gap-6">
          
          {/* Verification Queue Card */}
          <div className="relative overflow-hidden rounded-xl bg-primary-container p-5 text-on-primary-container shadow-md border border-outline-variant/15">
            <div className="absolute -right-6 -top-6 w-32 h-32 bg-primary blur-2xl rounded-full opacity-40 pointer-events-none" />
            
            <h3 className="font-bold text-sm text-on-primary mb-2 relative z-10 flex items-center gap-1.5 font-heading">
              <ListTodo className="w-5 h-5 text-secondary" />
              <span>Verification Queue</span>
            </h3>
            
            <p className="text-xs text-on-primary-container/85 mb-4 relative z-10 leading-relaxed">
              Receipts and identity documents requiring manual review to maintain ledger integrity.
            </p>

            <div className="space-y-2 relative z-10">
              <div className="flex justify-between items-center bg-white/5 p-2.5 rounded border border-white/10 backdrop-blur-sm">
                <span className="text-[11px] font-semibold text-on-primary-container/80">KYC Documents</span>
                <span className="text-sm font-bold text-on-primary font-mono">{stats.pendingKycCount}</span>
              </div>
              <div className="flex justify-between items-center bg-white/5 p-2.5 rounded border border-white/10 backdrop-blur-sm">
                <span className="text-[11px] font-semibold text-on-primary-container/80">Payment Receipts</span>
                <span className="text-sm font-bold text-warning-amber font-mono">{stats.pendingReceiptsCount}</span>
              </div>
            </div>

            <Button asChild className="w-full mt-4 bg-on-primary text-primary hover:bg-surface-bright py-2 h-9 text-xs font-bold rounded-sm relative z-10 cursor-pointer shadow-sm">
              <Link href="/admin/verification">Start Queue Processing</Link>
            </Button>
          </div>

          {/* System Health Widget */}
          <div className="bg-surface-container-lowest border border-outline-variant/15 rounded-xl p-5 shadow-sm">
            <h3 className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold mb-4">System Health</h3>
            
            <div className="space-y-4">
              <div>
                <div className="flex justify-between text-xs font-semibold text-primary mb-1">
                  <span>Ledger Sync</span>
                  <span className="text-success-green">Operational</span>
                </div>
                <div className="w-full bg-surface-container rounded-full h-1">
                  <div className="bg-success-green h-1 rounded-full" style={{ width: '100%' }} />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-xs font-semibold text-primary mb-1">
                  <span>Payment Gateway</span>
                  <span className="text-success-green">Operational</span>
                </div>
                <div className="w-full bg-surface-container rounded-full h-1">
                  <div className="bg-success-green h-1 rounded-full" style={{ width: '100%' }} />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-xs font-semibold text-primary mb-1">
                  <span>SMS Notifications</span>
                  <span className="text-success-green">Operational</span>
                </div>
                <div className="w-full bg-surface-container rounded-full h-1">
                  <div className="bg-success-green h-1 rounded-full" style={{ width: '100%' }} />
                </div>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-outline-variant/20 text-[10px] text-muted-foreground text-center">
              Last checked: Just now
            </div>
          </div>

        </div>

      </section>

    </div>
  )
}
export default AdminDashboardClient
