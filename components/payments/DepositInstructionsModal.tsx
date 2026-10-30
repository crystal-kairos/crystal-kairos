'use client'

import React, { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Check, Copy, Landmark, ShieldCheck, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import {
  generateMemberPaymentReference,
  PaymentPurposeCode,
} from '@/lib/domain/payment-reference'

interface DepositInstructionsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  membershipNumber?: string | null
  purpose?: PaymentPurposeCode | string
  societyAccount?: {
    bankName: string
    accountNumber: string
    accountName: string
  } | null
}

export const DepositInstructionsModal = ({
  open,
  onOpenChange,
  membershipNumber,
  purpose = 'SAV',
  societyAccount,
}: DepositInstructionsModalProps) => {
  const [copiedAccount, setCopiedAccount] = useState(false)
  const [copiedNarration, setCopiedNarration] = useState(false)

  const narration = membershipNumber
    ? generateMemberPaymentReference(membershipNumber, purpose)
    : `CK000000 ${purpose}`

  const copyToClipboard = async (text: string, type: 'account' | 'narration') => {
    try {
      await navigator.clipboard.writeText(text)
      if (type === 'account') {
        setCopiedAccount(true)
        setTimeout(() => setCopiedAccount(false), 2000)
        toast.success('Account number copied to clipboard.')
      } else {
        setCopiedNarration(true)
        setTimeout(() => setCopiedNarration(false), 2000)
        toast.success('Transfer narration copied to clipboard.')
      }
    } catch {
      toast.error('Failed to copy to clipboard.')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <Landmark className='w-5 h-5 text-primary' />
            Deposit Instructions
          </DialogTitle>
          <DialogDescription>
            Pay directly to the cooperative&apos;s verified bank account below via mobile transfer or cash deposit.
          </DialogDescription>
        </DialogHeader>

        {societyAccount ? (
          <div className='flex flex-col gap-4 py-2'>
            {/* Account Details Box */}
            <div className='bg-surface-container rounded-xl p-4 border border-outline-variant/30 flex flex-col gap-3'>
              <div className='flex items-center justify-between text-xs text-muted-foreground'>
                <span>Bank Name</span>
                <span className='font-semibold text-foreground'>{societyAccount.bankName}</span>
              </div>

              <div className='flex items-center justify-between'>
                <div className='flex flex-col'>
                  <span className='text-xs text-muted-foreground'>Account Number</span>
                  <span className='text-lg font-mono font-bold tracking-wider text-primary'>
                    {societyAccount.accountNumber}
                  </span>
                </div>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() => copyToClipboard(societyAccount.accountNumber, 'account')}
                  className='h-8 px-2 text-xs gap-1 cursor-pointer'
                >
                  {copiedAccount ? (
                    <>
                      <Check className='w-3.5 h-3.5 text-success' /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className='w-3.5 h-3.5' /> Copy
                    </>
                  )}
                </Button>
              </div>

              <div className='flex items-center justify-between text-xs text-muted-foreground'>
                <span>Account Name</span>
                <span className='font-semibold text-foreground uppercase tracking-wide'>
                  {societyAccount.accountName}
                </span>
              </div>
            </div>

            {/* Transfer Narration Box (§1.2) */}
            <div className='bg-primary/5 border border-primary/20 rounded-xl p-4 flex flex-col gap-2'>
              <div className='flex items-center justify-between'>
                <div className='flex items-center gap-1.5 text-xs font-semibold text-primary'>
                  <ShieldCheck className='w-4 h-4' />
                  Required Transfer Narration (§1.2)
                </div>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  onClick={() => copyToClipboard(narration, 'narration')}
                  className='h-7 px-2 text-xs text-primary hover:bg-primary/10 cursor-pointer gap-1'
                >
                  {copiedNarration ? (
                    <>
                      <Check className='w-3.5 h-3.5 text-success' /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className='w-3.5 h-3.5' /> Copy
                    </>
                  )}
                </Button>
              </div>
              <p className='font-mono font-bold text-base tracking-wider bg-background/80 p-2 rounded-md border border-primary/20 text-center select-all'>
                {narration}
              </p>
              <p className='text-[11px] text-muted-foreground leading-relaxed'>
                <strong>Important:</strong> Enter this exact reference code in your bank transfer remarks or deposit slip so the cooperative can immediately identify and reconcile your payment.
              </p>
            </div>

            <div className='bg-surface-container-low rounded-lg p-3 text-xs text-muted-foreground flex gap-2 items-start'>
              <AlertCircle className='w-4 h-4 shrink-0 text-secondary mt-0.5' />
              <span>
                After completing the transfer, take a screenshot or download the receipt and upload it in the payment submission form.
              </span>
            </div>
          </div>
        ) : (
          <div className='py-6 text-center text-sm text-muted-foreground flex flex-col items-center gap-2'>
            <AlertCircle className='w-8 h-8 text-amber-500' />
            <span>No active society receiving account is currently configured. Please contact cooperative administration.</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
