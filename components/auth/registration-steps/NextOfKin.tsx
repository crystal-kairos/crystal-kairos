'use client'

import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { RegistrationFormValues } from '@/types/register.interface'
import { Control, Controller } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import banksList from '@/data/bank-list.json'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox'
import { relationshipData } from './data'

const NextOfKin = ({
  control,
}: {
  control: Control<RegistrationFormValues>
}) => {
  const { t } = useTranslation('auth')

  return (
    <FieldGroup>
      <FieldGroup className='flex flex-col gap-1 md:flex-row'>
        <Controller
          name='name'
          control={control}
          render={({ field, fieldState }) => {
            return (
              <Field>
                <FieldLabel>
                  {t('register.form.next_of_kin.full_name')}
                </FieldLabel>
                <Input
                  {...field}
                  className='rounded-sm'
                  placeholder={t('register.form.next_of_kin.full_name')}
                />
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )
          }}
        />
        <Controller
          name='relationship'
          control={control}
          render={({ field, fieldState }) => {
            return (
              <Field>
                <FieldLabel>
                  {t('register.form.next_of_kin.relationship')}
                </FieldLabel>
                <Select
                  name={field.name}
                  value={field.value}
                  onValueChange={field.onChange}
                >
                  <SelectTrigger className='rounded-sm'>
                    <SelectValue
                      placeholder={t('register.form.next_of_kin.relationship')}
                    />
                  </SelectTrigger>
                  <SelectContent position='popper' className='rounded-md'>
                    {relationshipData.map((relationship) => {
                      return (
                        <SelectItem
                          value={relationship.value}
                          key={relationship.id}
                        >
                          {t(relationship.label)}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
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
          name='phoneNumber'
          control={control}
          render={({ field, fieldState }) => {
            return (
              <Field>
                <FieldLabel>
                  {t('register.form.next_of_kin.phone_number')}
                </FieldLabel>
                <Input
                  {...field}
                  className='rounded-sm'
                  placeholder={t('register.form.next_of_kin.phone_number')}
                />
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )
          }}
        />
        <Controller
          name='occupation'
          control={control}
          render={({ field, fieldState }) => {
            return (
              <Field>
                <FieldLabel>
                  {t('register.form.next_of_kin.occupation')}
                </FieldLabel>
                <Input
                  {...field}
                  className='rounded-sm'
                  placeholder={t('register.form.next_of_kin.occupation')}
                />
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
          name='address'
          control={control}
          render={({ field, fieldState }) => {
            return (
              <Field>
                <FieldLabel>
                  {t('register.form.next_of_kin.address')}
                </FieldLabel>
                <Textarea
                  {...field}
                  className='rounded-sm'
                  placeholder={t('register.form.next_of_kin.address')}
                />
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )
          }}
        />
      </FieldGroup>

      <Separator className='bg-outline-variant' />

      <h3>Bank Details</h3>
      <FieldGroup className='flex flex-col gap-1 md:flex-row'>
        <Controller
          name='bankName'
          control={control}
          render={({ field, fieldState }) => {
            return (
              <Field>
                <FieldLabel>
                  {t('register.form.next_of_kin.bank_name')}
                </FieldLabel>
                <Combobox
                  items={banksList}
                  itemToStringLabel={(item: any) => item?.name || ''}
                  name={field.name}
                  value={field.value}
                  onValueChange={field.onChange}
                >
                  <ComboboxInput
                    placeholder={t('register.form.next_of_kin.bank_name')}
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
                  {t('register.form.next_of_kin.account_number')}
                </FieldLabel>
                <Input
                  {...field}
                  className='rounded-sm'
                  placeholder={t('register.form.next_of_kin.account_number')}
                />
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )
          }}
        />

        <Controller
          name='accountName'
          control={control}
          render={({ field, fieldState }) => {
            return (
              <Field>
                <FieldLabel>
                  {t('register.form.next_of_kin.account_name')}
                </FieldLabel>
                <Input
                  {...field}
                  className='rounded-sm'
                  placeholder={t('register.form.next_of_kin.account_name')}
                />
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )
          }}
        />
      </FieldGroup>
    </FieldGroup>
  )
}

export default NextOfKin
