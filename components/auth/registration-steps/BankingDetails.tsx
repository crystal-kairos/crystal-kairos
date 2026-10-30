'use client'

import React, { useState, useEffect } from 'react'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox'
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import banksList from '@/data/bank-list.json'
import { RegistrationFormValues } from '@/types/register.interface'
import { Control, Controller, useWatch, UseFormSetValue } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { resolveAccountNameAction } from '@/models/members/actions'
import { Loader2, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'

interface BankingDetailsProps {
  control: Control<RegistrationFormValues>
  setValue?: UseFormSetValue<RegistrationFormValues>
}

const BankingDetails = ({ control, setValue }: BankingDetailsProps) => {
  const { t } = useTranslation('auth')
  const [isResolving, setIsResolving] = useState(false)

  const bankName = useWatch({ control, name: 'bankName' })
  const accountNumber = useWatch({ control, name: 'accountNumber' })

  useEffect(() => {
    if (!setValue) return

    const resolve = async () => {
      if (bankName && accountNumber && accountNumber.trim().length === 10) {
        setIsResolving(true)
        const res = await resolveAccountNameAction(bankName, accountNumber.trim())
        setIsResolving(false)

        if (res.success && res.accountName) {
          setValue('accountName', res.accountName, { shouldValidate: true })
          toast.success(`Account resolved: ${res.accountName}`)
        } else if (res.error) {
          toast.error(res.error)
        }
      }
    }

    resolve()
  }, [bankName, accountNumber, setValue])

  return (
    <FieldGroup>
      <FieldGroup className='flex flex-col gap-1 md:flex-row'>
        <Controller
          name='bankName'
          control={control}
          render={({ field, fieldState }) => {
            return (
              <Field>
                <FieldLabel>
                  {t('register.form.banking_details.bank_name')}
                </FieldLabel>
                <Combobox
                  items={banksList}
                  itemToStringLabel={(item: any) => item?.name || ''}
                  name={field.name}
                  value={field.value}
                  onValueChange={field.onChange}
                >
                  <ComboboxInput
                    placeholder={t('register.form.banking_details.bank_name')}
                  />
                  <ComboboxContent>
                    <ComboboxEmpty>
                      {t('register.form.banking_details.no_account_found')}
                    </ComboboxEmpty>
                    <ComboboxList>
                      {(item) => (
                        <ComboboxItem
                          key={`${item.id ?? ''}-${item.code ?? ''}-${item.name}`}
                          value={item.name}
                        >
                          {item.name}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )
          }}
        />

        <Controller
          name='accountNumber'
          control={control}
          render={({ field, fieldState }) => {
            return (
              <Field>
                <FieldLabel>
                  {t('register.form.banking_details.account_number')}
                </FieldLabel>
                <div className='relative'>
                  <Input
                    {...field}
                    maxLength={10}
                    className='rounded-sm font-mono tracking-wider pr-9'
                    placeholder={t(
                      'register.form.banking_details.account_number',
                    )}
                    onChange={(e) => field.onChange(e.target.value.replace(/\D/g, '').slice(0, 10))}
                  />
                  {isResolving && (
                    <Loader2 className='w-4 h-4 animate-spin text-primary absolute right-3 top-2.5' />
                  )}
                </div>
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )
          }}
        />
      </FieldGroup>

      <FieldGroup className='flex flex-col gap-1 md:flex-row'>
        <Controller
          name='accountName'
          control={control}
          render={({ field, fieldState }) => {
            return (
              <Field>
                <FieldLabel>
                  {t('register.form.banking_details.account_name')}
                </FieldLabel>
                <Input
                  {...field}
                  className='rounded-sm uppercase'
                  placeholder={isResolving ? 'Resolving account name...' : t('register.form.banking_details.account_name')}
                />
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
                {field.value && !isResolving && (
                  <span className='text-[11px] text-success flex items-center gap-1 font-medium mt-1'>
                    <ShieldCheck className='w-3.5 h-3.5' /> Account name verified
                  </span>
                )}
              </Field>
            )
          }}
        />
      </FieldGroup>
    </FieldGroup>
  )
}

export default BankingDetails
