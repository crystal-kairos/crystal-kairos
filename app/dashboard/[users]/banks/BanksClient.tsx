'use client'

import React, { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { BankAccountCard } from '@/components/members/BankAccountCard'
import { AddBankAccountDialog } from '@/components/members/AddBankAccountDialog'
import { deleteBankAccountAction } from '@/models/members/actions'
import { requestPrimaryBankAccountChangeAction } from '@/models/members/profile-change-actions'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Landmark, ArrowLeft, Star, Trash2 } from 'lucide-react'
import Link from 'next/link'

interface BankAccount {
  id: string
  accountNumber: string
  accountName: string
  bankName: string
  isPrimary: boolean
}

interface BanksClientProps {
  userId: string
  bankAccounts: BankAccount[]
  pendingPrimaryAccountId?: string | null
}

export default function BanksClient({
  userId,
  bankAccounts,
  pendingPrimaryAccountId,
}: BanksClientProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const handleSetPrimary = async (accountId: string) => {
    const result = await requestPrimaryBankAccountChangeAction(accountId)
    if (result.success) {
      toast.success(
        'Primary account change requested. An administrator will review your change before it takes effect.',
      )
      startTransition(() => {
        router.refresh()
      })
    } else {
      toast.error(result.error || 'Failed to request primary account change.')
    }
  }

  const handleDelete = async (accountId: string) => {
    const result = await deleteBankAccountAction(userId, accountId)
    if (result.success) {
      toast.success('Bank account removed successfully.')
      startTransition(() => {
        router.refresh()
      })
    } else {
      toast.error(result.error || 'Failed to delete bank account.')
    }
  }

  return (
    <div className="w-[90%] mx-auto py-8 max-w-4xl flex flex-col gap-6">
      {/* Navigation & Header */}
      <div className="flex flex-col gap-3">
        <Link href={`/dashboard/${userId}/profile`} className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 w-fit transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to Profile</span>
        </Link>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-md bg-secondary/10 flex items-center justify-center text-secondary shrink-0">
              <Landmark className="w-6 h-6" />
            </div>
            <div className="flex flex-col">
              <h2 className="text-2xl font-bold font-heading tracking-tight">Bank Configurations</h2>
              <p className="text-sm text-muted-foreground">Manage Nominated Bank payout channels for Ajo payouts & loan disbursements</p>
            </div>
          </div>
          <AddBankAccountDialog userId={userId} onSuccess={() => router.refresh()} />
        </div>
      </div>

      {/* Accounts List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        {bankAccounts.length === 0 ? (
          <div className="md:col-span-2 p-12 bg-surface-container rounded-md border border-dashed border-outline-variant text-center flex flex-col items-center gap-3">
            <Landmark className="w-10 h-10 text-muted-foreground" />
            <h4 className="font-semibold text-sm text-primary">No bank accounts registered</h4>
            <p className="text-xs text-muted-foreground max-w-xs">
              Please register at least one account to receive payouts, rotatingajo cycle payments, or loan disbursements.
            </p>
          </div>
        ) : (
          bankAccounts.map((account) => (
            <div key={account.id} className="relative flex flex-col gap-4 bg-surface-container p-5 rounded-md border border-outline-variant/20">
              <BankAccountCard
                bankName={account.bankName}
                accountNumber={account.accountNumber}
                accountName={account.accountName}
                isPrimary={account.isPrimary}
                isPendingPrimary={pendingPrimaryAccountId === account.id}
              />
              <div className="flex gap-2 justify-end border-t border-outline-variant/30 pt-3">
                {!account.isPrimary && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isPending || pendingPrimaryAccountId === account.id}
                    onClick={() => handleSetPrimary(account.id)}
                    className="cursor-pointer h-8 text-[11px] font-semibold flex items-center gap-1"
                  >
                    <Star className="w-3.5 h-3.5 text-secondary" />
                    <span>{pendingPrimaryAccountId === account.id ? 'Review Pending' : 'Set Primary'}</span>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isPending || (account.isPrimary && bankAccounts.length > 1)}
                  onClick={() => handleDelete(account.id)}
                  title={account.isPrimary && bankAccounts.length > 1 ? 'Nominate another primary account first' : 'Delete account'}
                  className="cursor-pointer h-8 text-[11px] font-semibold text-error hover:text-error hover:bg-error/10 flex items-center gap-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Remove</span>
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
