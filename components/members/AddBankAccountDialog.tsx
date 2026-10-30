'use client'

import React, { useState, useEffect } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { z } from 'zod'
import { bankInfoSchema } from '@/schema/auth.schema'
import { standardSchemaResolver } from '@hookform/resolvers/standard-schema'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog'
import { Button } from '../ui/button'
import { Field, FieldError, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { BankSelectCombobox } from '@/components/banking/BankSelectCombobox'
import {
  addBankAccountAction,
  getBankListAction,
  resolveAccountNameAction,
} from '@/models/members/actions'
import { toast } from 'sonner'
import { Plus, Loader2, ShieldCheck, AlertTriangle } from 'lucide-react'
import { Bank } from '@/lib/banking/provider'

type BankFormValues = z.infer<typeof bankInfoSchema>

interface AddBankAccountDialogProps {
  userId: string
  onSuccess?: () => void
}

export const AddBankAccountDialog = ({ userId, onSuccess }: AddBankAccountDialogProps) => {
  const [open, setOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isResolving, setIsResolving] = useState(false)
  const [banks, setBanks] = useState<Bank[]>([])
  const [selectedBankCode, setSelectedBankCode] = useState<string>('')
  const [nameMatchWarning, setNameMatchWarning] = useState<string | null>(null)

  const { control, handleSubmit, watch, setValue, formState: { errors }, reset } = useForm<BankFormValues>({
    resolver: standardSchemaResolver(bankInfoSchema),
    mode: 'onChange',
    defaultValues: {
      bankName: '',
      accountNumber: '',
      accountName: '',
    },
  })

  useEffect(() => {
    const fetchBanks = async () => {
      const res = await getBankListAction()
      if (res.success && res.data) {
        setBanks(res.data)
      }
    }
    fetchBanks()
  }, [])

  const accountNumberValue = watch('accountNumber')

  // Trigger account resolution when bank and 10-digit account number are provided
  useEffect(() => {
    const resolveName = async () => {
      if (selectedBankCode && accountNumberValue && accountNumberValue.length === 10) {
        setIsResolving(true)
        setNameMatchWarning(null)
        setValue('accountName', '') // Reset previous resolved name

        const result = await resolveAccountNameAction(selectedBankCode, accountNumberValue, userId)
        setIsResolving(false)

        if (result.success && result.accountName) {
          setValue('accountName', result.accountName, { shouldValidate: true })
          if (result.nameMatch && !result.nameMatch.isMatch) {
            setNameMatchWarning(result.nameMatch.reason || 'Account name does not match registered profile name.')
          }
          toast.success(`Account resolved: ${result.accountName}`)
        } else {
          toast.error(result.error || 'Failed to resolve account number. Verify details.')
        }
      }
    }

    resolveName()
  }, [selectedBankCode, accountNumberValue, setValue, userId])

  const onSubmit = async (data: BankFormValues) => {
    setIsSubmitting(true)
    const result = await addBankAccountAction(userId, {
      ...data,
      bankCode: selectedBankCode,
    })
    setIsSubmitting(false)

    if (result.success) {
      toast.success('Bank account added successfully.')
      setOpen(false)
      reset()
      setSelectedBankCode('')
      setNameMatchWarning(null)
      if (onSuccess) onSuccess()
    } else {
      toast.error(result.error || 'Failed to add bank account.')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(val) => {
      setOpen(val)
      if (!val) {
        reset()
        setSelectedBankCode('')
        setNameMatchWarning(null)
      }
    }}>
      <DialogTrigger asChild>
        <Button className="cursor-pointer rounded-sm text-on-primary flex items-center gap-1.5 h-10">
          <Plus className="w-4 h-4" />
          <span>Add Bank Account</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md rounded-md">
        <DialogHeader>
          <DialogTitle className="font-semibold text-lg">Add Bank Account</DialogTitle>
          <DialogDescription className="text-muted-foreground text-sm">
            Nominate a new bank account. The system will automatically resolve the account name via bank lookup network routing.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4 py-4">
          <Controller
            control={control}
            name="bankName"
            render={({ field, fieldState }) => (
              <Field>
                <FieldLabel htmlFor="bank-select">Select Bank</FieldLabel>
                <BankSelectCombobox
                  id="bank-select"
                  banks={banks}
                  selectedBankCode={selectedBankCode}
                  selectedBankName={field.value}
                  onSelectBank={(bank) => {
                    setSelectedBankCode(bank.code)
                    field.onChange(bank.name)
                  }}
                  placeholder="Search bank name or code..."
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />

          <Controller
            control={control}
            name="accountNumber"
            render={({ field, fieldState }) => (
              <Field>
                <FieldLabel htmlFor="account-num-input">Account Number</FieldLabel>
                <div className="relative">
                  <Input
                    {...field}
                    id="account-num-input"
                    maxLength={10}
                    placeholder="10-digit Account Number"
                    className="rounded-sm h-11 font-mono tracking-wider pr-10 text-xs"
                    onChange={(e) => field.onChange(e.target.value.replace(/\D/g, '').slice(0, 10))}
                  />
                  {isResolving && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <Loader2 className="w-4 h-4 animate-spin text-secondary" />
                    </div>
                  )}
                </div>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />

          <Controller
            control={control}
            name="accountName"
            render={({ field, fieldState }) => (
              <Field>
                <FieldLabel htmlFor="account-name-input">Resolved Account Name</FieldLabel>
                <Input
                  {...field}
                  id="account-name-input"
                  readOnly
                  placeholder={isResolving ? 'Resolving name via NUBAN provider...' : 'Auto-populated on account entry'}
                  className="rounded-sm h-11 bg-surface-container-low border-outline-variant/35 font-semibold text-primary/80 read-only:cursor-not-allowed uppercase text-xs"
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                {field.value && !nameMatchWarning && (
                  <span className="text-[11px] text-success flex items-center gap-1 font-medium mt-1">
                    <ShieldCheck className="w-3.5 h-3.5" /> Account name verified
                  </span>
                )}
                {nameMatchWarning && (
                  <span className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1 font-medium mt-1">
                    <AlertTriangle className="w-3.5 h-3.5" /> {nameMatchWarning}
                  </span>
                )}
              </Field>
            )}
          />

          <div className="flex gap-2 justify-end mt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              className="cursor-pointer rounded-sm h-10 text-xs"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || isResolving || !watch('accountName')}
              className="cursor-pointer rounded-sm text-on-primary h-10 px-5 text-xs"
            >
              {isSubmitting ? 'Saving...' : 'Add Account'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
