'use client'

import React, { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Check, Copy, Landmark, HelpCircle, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { DepositInstructionsModal } from './DepositInstructionsModal'
import {
  generateMemberPaymentReference,
  PaymentPurposeCode,
} from '@/lib/domain/payment-reference'

interface SocietyAccountBannerProps {
  societyAccount: {
    bankName: string
    accountNumber: string
    accountName: string
  } | null
  membershipNumber?: string | null
}

export const SocietyAccountBanner = ({
  societyAccount,
  membershipNumber,
}: SocietyAccountBannerProps) => {
  const [modalOpen, setModalOpen] = useState(false)
  const [copiedAccount, setCopiedAccount] = useState(false)
  const [copiedNarration, setCopiedNarration] = useState(false)

  if (!societyAccount) return null

  const generalNarration = membershipNumber
    ? generateMemberPaymentReference(membershipNumber, 'SAV')
    : 'CK000000 SAV'

  const copyAccount = async () => {
    try {
      await navigator.clipboard.writeText(societyAccount.accountNumber)
      setCopiedAccount(true)
      setTimeout(() => setCopiedAccount(false), 2000)
      toast.success('Society account number copied to clipboard.')
    } catch {
      toast.error('Failed to copy account number.')
    }
  }

  const copyNarration = async () => {
    try {
      await navigator.clipboard.writeText(generalNarration)
      setCopiedNarration(true)
      setTimeout(() => setCopiedNarration(false), 2000)
      toast.success('Transfer narration copied to clipboard.')
    } catch {
      toast.error('Failed to copy transfer narration.')
    }
  }

  return (
    <>
      <Card className='mb-6 border border-primary/20 bg-gradient-to-r from-primary/5 via-surface-container to-surface-container rounded-2xl shadow-sm overflow-hidden'>
        <CardContent className='p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4'>
          <div className='flex items-start sm:items-center gap-3.5'>
            <div className='w-11 h-11 rounded-2xl bg-primary/10 text-primary flex items-center justify-center shrink-0 mt-0.5 sm:mt-0'>
              <Landmark className='w-5 h-5' />
            </div>
            <div className='flex flex-col'>
              <div className='flex items-center gap-2 flex-wrap'>
                <span className='text-xs font-semibold text-primary uppercase tracking-wider'>
                  Cooperative Receiving Account
                </span>
                <span className='text-[10px] bg-primary/10 text-primary font-medium px-2 py-0.5 rounded-full'>
                  Verified Bank
                </span>
              </div>
              <div className='flex items-baseline gap-2 mt-0.5 flex-wrap'>
                <span className='font-bold text-sm sm:text-base text-foreground'>
                  {societyAccount.bankName}
                </span>
                <span className='font-mono font-bold text-base sm:text-lg text-primary tracking-wider'>
                  {societyAccount.accountNumber}
                </span>
                <span className='text-xs text-muted-foreground uppercase hidden sm:inline'>
                  ({societyAccount.accountName})
                </span>
              </div>
              {membershipNumber && (
                <div className='flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap'>
                  <span className='flex items-center gap-1 font-medium'>
                    <ShieldCheck className='w-3.5 h-3.5 text-primary' /> Narration:
                  </span>
                  <code className='bg-surface-container-high px-1.5 py-0.5 rounded font-mono font-bold text-foreground text-[11px]'>
                    {generalNarration}
                  </code>
                  <button
                    type='button'
                    onClick={copyNarration}
                    className='text-primary hover:underline inline-flex items-center gap-0.5 text-[11px] cursor-pointer'
                  >
                    {copiedNarration ? 'Copied!' : 'Copy narration'}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className='flex items-center gap-2 shrink-0 self-end md:self-center'>
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={copyAccount}
              className='h-8 px-3 text-xs gap-1.5 cursor-pointer rounded-lg'
            >
              {copiedAccount ? (
                <>
                  <Check className='w-3.5 h-3.5 text-success' /> Copied
                </>
              ) : (
                <>
                  <Copy className='w-3.5 h-3.5' /> Copy Account
                </>
              )}
            </Button>
            <Button
              type='button'
              variant='default'
              size='sm'
              onClick={() => setModalOpen(true)}
              className='h-8 px-3 text-xs gap-1.5 cursor-pointer rounded-lg bg-primary text-on-primary'
            >
              <HelpCircle className='w-3.5 h-3.5' /> How to Pay
            </Button>
          </div>
        </CardContent>
      </Card>

      <DepositInstructionsModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        membershipNumber={membershipNumber}
        societyAccount={societyAccount}
      />
    </>
  )
}
