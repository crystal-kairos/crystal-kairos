'use client'

import React from 'react'
import {
  Clock,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  FileText,
  Key,
  CreditCard,
  Wallet,
  Handshake,
  UserCheck,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'

export interface MemberVisibleEvent {
  id: string
  action: string
  entityType: string
  entityId?: string | null
  outcome: string
  metadata?: any
  createdAt: string | Date
  actorLabel: string
}

interface MemberActivityListProps {
  events: MemberVisibleEvent[]
  className?: string
}

export function MemberActivityList({ events, className = '' }: MemberActivityListProps) {
  const getActionDetails = (action: string) => {
    switch (action) {
      case 'AUTH.SIGN_IN_SUCCESS':
        return {
          title: 'Account Sign In',
          description: 'Successfully signed in to cooperative portal',
          icon: Key,
          color: 'text-blue-500 bg-blue-500/10',
        }
      case 'AUTH.MFA_ENROLLED':
        return {
          title: 'MFA Enrolled',
          description: 'Two-factor authenticator app configured',
          icon: ShieldCheck,
          color: 'text-indigo-500 bg-indigo-500/10',
        }
      case 'AUTH.SESSION_REVOKED':
        return {
          title: 'Session Revoked',
          description: 'Signed out of active browser session',
          icon: Key,
          color: 'text-amber-500 bg-amber-500/10',
        }
      case 'LOAN.APPLIED':
        return {
          title: 'Loan Application Submitted',
          description: 'Applied for new cooperative loan',
          icon: CreditCard,
          color: 'text-emerald-500 bg-emerald-500/10',
        }
      case 'GUARANTEE.CONSENT_GIVEN':
        return {
          title: 'Guarantor Consent Provided',
          description: 'Accepted loan guarantee request with digital signature',
          icon: UserCheck,
          color: 'text-teal-500 bg-teal-500/10',
        }
      case 'GUARANTEE.CONSENT_DECLINED':
        return {
          title: 'Guarantor Consent Declined',
          description: 'Declined loan guarantee request',
          icon: XCircle,
          color: 'text-rose-500 bg-rose-500/10',
        }
      case 'SAVINGS.PLAN_CREATED':
        return {
          title: 'Savings Plan Created',
          description: 'Opened new savings product subscription',
          icon: Wallet,
          color: 'text-emerald-500 bg-emerald-500/10',
        }
      case 'RECEIPT.SUBMITTED':
        return {
          title: 'Payment Receipt Uploaded',
          description: 'Proof of deposit submitted for staff verification',
          icon: FileText,
          color: 'text-blue-500 bg-blue-500/10',
        }
      case 'RECEIPT.CONFIRMED':
        return {
          title: 'Payment Confirmed',
          description: 'Deposit verified and credited to cooperative account',
          icon: CheckCircle2,
          color: 'text-emerald-500 bg-emerald-500/10',
        }
      case 'RECEIPT.REJECTED':
        return {
          title: 'Payment Receipt Rejected',
          description: 'Deposit proof could not be verified by staff',
          icon: XCircle,
          color: 'text-rose-500 bg-rose-500/10',
        }
      case 'EAJO.GROUP_CREATED':
      case 'EAJO.MEMBER_JOINED':
        return {
          title: 'E-Ajo Group Activity',
          description: 'Digital thrift circle participation',
          icon: Handshake,
          color: 'text-cyan-500 bg-cyan-500/10',
        }
      case 'WALLET.WITHDRAWAL_REQUESTED':
        return {
          title: 'Wallet Withdrawal Requested',
          description: 'Requested funds payout to registered bank account',
          icon: Wallet,
          color: 'text-amber-500 bg-amber-500/10',
        }
      default:
        return {
          title: action.replace(/[._]/g, ' '),
          description: 'Cooperative account operation',
          icon: Clock,
          color: 'text-slate-500 bg-slate-500/10',
        }
    }
  }

  if (events.length === 0) {
    return (
      <div className={`p-8 text-center text-muted-foreground border border-dashed rounded-xl ${className}`}>
        <Clock className="w-8 h-8 mx-auto mb-2 opacity-50" />
        <p className="text-sm font-medium">No account activity recorded yet.</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Your transactions, applications, and security events will appear here.
        </p>
      </div>
    )
  }

  return (
    <div className={`space-y-3 ${className}`}>
      {events.map((evt) => {
        const details = getActionDetails(evt.action)
        const Icon = details.icon
        const dateStr = new Date(evt.createdAt).toLocaleString('en-NG', {
          dateStyle: 'medium',
          timeStyle: 'short',
        })

        return (
          <div
            key={evt.id}
            className="flex items-start gap-3.5 p-3.5 bg-card border border-border/50 rounded-xl hover:border-border transition-colors text-xs"
          >
            <div className={`p-2 rounded-lg shrink-0 ${details.color}`}>
              <Icon className="w-4 h-4" />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-foreground text-sm truncate">
                  {details.title}
                </span>
                <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                  {dateStr}
                </span>
              </div>

              <p className="text-muted-foreground mt-0.5 text-xs">
                {details.description}
              </p>

              <div className="flex items-center gap-2 mt-2">
                <Badge variant="outline" className="text-[10px] py-0 px-1.5 font-normal">
                  Initiated by: {evt.actorLabel}
                </Badge>

                {evt.outcome === 'SUCCESS' ? (
                  <span className="text-emerald-600 font-medium inline-flex items-center gap-1 text-[11px]">
                    <CheckCircle2 className="w-3 h-3" /> Success
                  </span>
                ) : (
                  <span className="text-rose-600 font-medium inline-flex items-center gap-1 text-[11px]">
                    <XCircle className="w-3 h-3" /> {evt.outcome}
                  </span>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
