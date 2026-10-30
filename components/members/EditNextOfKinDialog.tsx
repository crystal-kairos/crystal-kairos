'use client'

import React, { useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { z } from 'zod'
import { nextOfKinSchema } from '@/schema/auth.schema'
import { standardSchemaResolver } from '@hookform/resolvers/standard-schema'
import { Relationship } from '@/generated/prisma/enums'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { Textarea } from '../ui/textarea'
import { requestNextOfKinChangeAction } from '@/models/members/profile-change-actions'
import { toast } from 'sonner'
import { Pencil, ShieldAlert } from 'lucide-react'

type NextOfKinFormValues = z.infer<typeof nextOfKinSchema>

interface EditNextOfKinDialogProps {
  userId: string
  defaultValues?: Partial<NextOfKinFormValues> | null
  onSuccess?: () => void
  isPendingReview?: boolean
}

export const EditNextOfKinDialog = ({
  userId,
  defaultValues,
  onSuccess,
  isPendingReview = false,
}: EditNextOfKinDialogProps) => {
  const [open, setOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const { control, handleSubmit, reset } = useForm<NextOfKinFormValues>({
    resolver: standardSchemaResolver(nextOfKinSchema),
    mode: 'onChange',
    defaultValues: {
      name: defaultValues?.name || '',
      phoneNumber: defaultValues?.phoneNumber || '',
      relationship: defaultValues?.relationship || Relationship.SPOUSE,
      occupation: defaultValues?.occupation || '',
      address: defaultValues?.address || '',
      bankName: defaultValues?.bankName || '',
      accountNumber: defaultValues?.accountNumber || '',
      accountName: defaultValues?.accountName || '',
    },
  })

  const onSubmit = async (data: NextOfKinFormValues) => {
    setIsSubmitting(true)
    const result = await requestNextOfKinChangeAction(userId, data)
    setIsSubmitting(false)

    if (result.success) {
      toast.success(
        'Next of Kin update request submitted. An administrator will review your changes before they take effect.',
      )
      setOpen(false)
      if (onSuccess) onSuccess()
    } else {
      toast.error(result.error || 'Failed to submit update request.')
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant='outline'
          size='sm'
          className='cursor-pointer flex items-center gap-1.5'
        >
          <Pencil className='w-3.5 h-3.5' />
          <span>
            {isPendingReview ? 'Modify Pending Request' : 'Edit Next of Kin'}
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent className='max-w-lg max-h-[90vh] overflow-y-auto rounded-md'>
        <DialogHeader>
          <DialogTitle className='font-semibold text-lg flex items-center gap-2'>
            <span>Update Next of Kin</span>
          </DialogTitle>
          <DialogDescription className='text-muted-foreground text-sm'>
            Enter updated contact details and payout routing options. To protect
            your cooperative assets, changes to Next of Kin require
            administrator approval before becoming active.
          </DialogDescription>
        </DialogHeader>

        {isPendingReview && (
          <div className='bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 p-3 rounded text-xs flex items-center gap-2'>
            <ShieldAlert className='w-4 h-4 shrink-0' />
            <span>
              You currently have an update request under review. Submitting a
              new change will replace your previous pending request.
            </span>
          </div>
        )}

        <form
          onSubmit={handleSubmit(onSubmit)}
          className='flex flex-col gap-4 py-4'
        >
          <div className='grid grid-cols-1 sm:grid-cols-2 gap-4'>
            <Controller
              control={control}
              name='name'
              render={({ field, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor='nok-name'>Full Name</FieldLabel>
                  <Input
                    {...field}
                    id='nok-name'
                    placeholder='e.g. Mary Doe'
                    className='rounded-sm'
                  />
                  {fieldState.invalid && (
                    <FieldError errors={[fieldState.error]} />
                  )}
                </Field>
              )}
            />

            <Controller
              control={control}
              name='phoneNumber'
              render={({ field, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor='nok-phone'>Phone Number</FieldLabel>
                  <Input
                    {...field}
                    id='nok-phone'
                    placeholder='e.g. +2348000000000'
                    className='rounded-sm'
                  />
                  {fieldState.invalid && (
                    <FieldError errors={[fieldState.error]} />
                  )}
                </Field>
              )}
            />

            <Controller
              control={control}
              name='relationship'
              render={({ field, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor='nok-relationship'>
                    Relationship
                  </FieldLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger id='nok-relationship' className='rounded-sm'>
                      <SelectValue placeholder='Select relationship' />
                    </SelectTrigger>
                    <SelectContent className='rounded-sm'>
                      {Object.values(Relationship).map((rel) => (
                        <SelectItem
                          key={rel}
                          value={rel}
                          className='capitalize'
                        >
                          {rel.toLowerCase()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {fieldState.invalid && (
                    <FieldError errors={[fieldState.error]} />
                  )}
                </Field>
              )}
            />

            <Controller
              control={control}
              name='occupation'
              render={({ field, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor='nok-occupation'>Occupation</FieldLabel>
                  <Input
                    {...field}
                    id='nok-occupation'
                    placeholder='e.g. Business Owner'
                    className='rounded-sm'
                  />
                  {fieldState.invalid && (
                    <FieldError errors={[fieldState.error]} />
                  )}
                </Field>
              )}
            />
          </div>

          <Controller
            control={control}
            name='address'
            render={({ field, fieldState }) => (
              <Field>
                <FieldLabel htmlFor='nok-address'>
                  Residential Address
                </FieldLabel>
                <Textarea
                  {...field}
                  id='nok-address'
                  placeholder='Residential Address'
                  className='rounded-sm min-h-15'
                />
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )}
          />

          <div className='border-t border-outline-variant/30 pt-4 flex flex-col gap-3'>
            <h4 className='font-semibold text-sm'>
              Nominated Bank Payout Details
            </h4>

            <div className='grid grid-cols-1 sm:grid-cols-2 gap-4'>
              <Controller
                control={control}
                name='bankName'
                render={({ field, fieldState }) => (
                  <Field>
                    <FieldLabel htmlFor='nok-bank'>Bank Name</FieldLabel>
                    <Input
                      {...field}
                      id='nok-bank'
                      placeholder='e.g. Access Bank'
                      className='rounded-sm'
                    />
                    {fieldState.invalid && (
                      <FieldError errors={[fieldState.error]} />
                    )}
                  </Field>
                )}
              />

              <Controller
                control={control}
                name='accountNumber'
                render={({ field, fieldState }) => (
                  <Field>
                    <FieldLabel htmlFor='nok-account-num'>
                      Account Number
                    </FieldLabel>
                    <Input
                      {...field}
                      id='nok-account-num'
                      placeholder='10-digit number'
                      className='rounded-sm font-mono'
                    />
                    {fieldState.invalid && (
                      <FieldError errors={[fieldState.error]} />
                    )}
                  </Field>
                )}
              />
            </div>

            <Controller
              control={control}
              name='accountName'
              render={({ field, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor='nok-account-name'>
                    Account Name
                  </FieldLabel>
                  <Input
                    {...field}
                    id='nok-account-name'
                    placeholder='e.g. Mary Doe'
                    className='rounded-sm'
                  />
                  {fieldState.invalid && (
                    <FieldError errors={[fieldState.error]} />
                  )}
                </Field>
              )}
            />
          </div>

          <div className='flex gap-2 justify-end mt-4'>
            <Button
              type='button'
              variant='ghost'
              onClick={() => setOpen(false)}
              className='cursor-pointer rounded-sm h-10'
            >
              Cancel
            </Button>
            <Button
              type='submit'
              disabled={isSubmitting}
              className='cursor-pointer rounded-sm text-on-primary h-10'
            >
              {isSubmitting ? 'Submitting...' : 'Submit for Approval'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
