'use client'

import React, { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog'
import { Button } from '../ui/button'
import { Field, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { BankSelectCombobox } from '@/components/banking/BankSelectCombobox'
import { getBankListAction, resolveAccountNameAction } from '@/models/members/actions'
import { requestBankDetailsChangeAction } from '@/models/members/profile-change-actions'
import { Bank } from '@/lib/banking/provider'
import { useStepUp } from '@/components/auth/StepUpDialog'
import { toast } from 'sonner'
import { AlertTriangle, Loader2, Pencil, ShieldCheck } from 'lucide-react'

interface EditBankDetailsDialogProps {
  userId: string
  bankAccountId: string
  currentBankName: string
  disabled?: boolean
  /** True when this account is the one with a details change under review. */
  isPendingForThisAccount?: boolean
  disabledReason?: string
  onSuccess?: () => void
}

/**
 * Lets a member request new bank / account-number details for one of their existing
 * accounts (PR P3-02B, change type BANK_DETAILS). Nothing changes until an
 * administrator approves the request.
 */
export const EditBankDetailsDialog = ({
  userId,
  bankAccountId,
  currentBankName,
  disabled,
  isPendingForThisAccount,
  disabledReason,
  onSuccess,
}: EditBankDetailsDialogProps) => {
  const [open, setOpen] = useState(false)
  const [banks, setBanks] = useState<Bank[]>([])
  const [bankCode, setBankCode] = useState('')
  const [bankName, setBankName] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [resolvedName, setResolvedName] = useState('')
  const [nameWarning, setNameWarning] = useState<string | null>(null)
  const [isResolving, setIsResolving] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const { withStepUp, stepUpDialog } = useStepUp()

  const reset = () => {
    setBankCode('')
    setBankName('')
    setAccountNumber('')
    setResolvedName('')
    setNameWarning(null)
  }

  useEffect(() => {
    if (!open || banks.length > 0) return
    getBankListAction().then((res) => {
      if (res.success && res.data) setBanks(res.data)
    })
  }, [open, banks.length])

  // Preview the account name once a bank and a 10-digit number are entered.
  useEffect(() => {
    if (!bankCode || accountNumber.length !== 10) return
    let cancelled = false
    const run = async () => {
      setIsResolving(true)
      setResolvedName('')
      setNameWarning(null)
      const result = await resolveAccountNameAction(bankCode, accountNumber)
      if (cancelled) return
      setIsResolving(false)
      if (result.success && result.accountName) {
        setResolvedName(result.accountName)
        if (result.nameMatch && !result.nameMatch.isMatch) {
          setNameWarning(
            'The account name does not match your registered name. You can still submit; an administrator will review it.',
          )
        }
      } else {
        toast.error(result.error || 'Could not resolve this account. Check the details.')
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [bankCode, accountNumber])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    // With MFA enabled the server asks for a fresh MFA step-up first (P1-07).
    const result = await withStepUp(() =>
      requestBankDetailsChangeAction(bankAccountId, { bankCode, accountNumber }),
    )
    setIsSubmitting(false)

    if (result.success) {
      toast.success('Change requested. An administrator will review it before it takes effect.')
      setOpen(false)
      reset()
      onSuccess?.()
    } else if (result.code !== 'STEP_UP_REQUIRED') {
      toast.error(result.error || 'Failed to submit the change request.')
    }
  }

  return (
    <>
    {stepUpDialog}
    <Dialog
      open={open}
      onOpenChange={(val) => {
        setOpen(val)
        if (!val) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant='ghost'
          size='sm'
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
          className='cursor-pointer h-8 text-[11px] font-semibold flex items-center gap-1'
        >
          <Pencil className='w-3.5 h-3.5' />
          <span>{isPendingForThisAccount ? 'Change Pending' : 'Change Details'}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className='max-w-md rounded-md'>
        <DialogHeader>
          <DialogTitle className='font-semibold text-lg'>Change Bank Details</DialogTitle>
          <DialogDescription className='text-muted-foreground text-sm'>
            Request new details for your {currentBankName} account. Your current details stay
            active until an administrator approves the change.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className='flex flex-col gap-4 py-4'>
          <Field>
            <FieldLabel htmlFor={`edit-bank-${bankAccountId}`}>New Bank</FieldLabel>
            <BankSelectCombobox
              id={`edit-bank-${bankAccountId}`}
              banks={banks}
              selectedBankCode={bankCode}
              selectedBankName={bankName}
              onSelectBank={(bank) => {
                setBankCode(bank.code)
                setBankName(bank.name)
              }}
              placeholder='Search bank name or code...'
            />
          </Field>

          <Field>
            <FieldLabel htmlFor={`edit-acc-${bankAccountId}`}>New Account Number</FieldLabel>
            <div className='relative'>
              <Input
                id={`edit-acc-${bankAccountId}`}
                value={accountNumber}
                maxLength={10}
                placeholder='10-digit Account Number'
                className='rounded-sm h-11 font-mono tracking-wider pr-10 text-xs'
                onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 10))}
              />
              {isResolving && (
                <div className='absolute right-3 top-1/2 -translate-y-1/2'>
                  <Loader2 className='w-4 h-4 animate-spin text-secondary' />
                </div>
              )}
            </div>
          </Field>

          <Field>
            <FieldLabel htmlFor={`edit-name-${bankAccountId}`}>Resolved Account Name</FieldLabel>
            <Input
              id={`edit-name-${bankAccountId}`}
              value={resolvedName}
              readOnly
              placeholder={isResolving ? 'Resolving...' : 'Auto-populated on account entry'}
              className='rounded-sm h-11 bg-surface-container-low font-semibold uppercase text-xs read-only:cursor-not-allowed'
            />
            {resolvedName && !nameWarning && (
              <span className='text-[11px] text-success flex items-center gap-1 font-medium mt-1'>
                <ShieldCheck className='w-3.5 h-3.5' /> Account name verified
              </span>
            )}
            {nameWarning && (
              <span className='text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1 font-medium mt-1'>
                <AlertTriangle className='w-3.5 h-3.5 shrink-0' /> {nameWarning}
              </span>
            )}
          </Field>

          <div className='flex gap-2 justify-end mt-4'>
            <Button
              type='button'
              variant='ghost'
              onClick={() => setOpen(false)}
              className='cursor-pointer rounded-sm h-10 text-xs'
            >
              Cancel
            </Button>
            <Button
              type='submit'
              disabled={isSubmitting || isResolving || !resolvedName}
              className='cursor-pointer rounded-sm text-on-primary h-10 px-5 text-xs'
            >
              {isSubmitting ? 'Submitting...' : 'Request Change'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
    </>
  )
}
