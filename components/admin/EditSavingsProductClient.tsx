'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Field, FieldLabel, FieldError } from '@/components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { ArrowLeft, Save, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { updateSavingsProductAction } from '@/models/admin/savingsActions'

const SAVINGS_TYPES = ['FIXED', 'REGULAR', 'STAGGERED'] as const;

const schema = z.object({
  type: z.enum(SAVINGS_TYPES, 'Please select a savings type'),
  title: z.string().min(3, 'Title must be at least 3 characters'),
  description: z.string().min(10, 'Description must be at least 10 characters'),
  badge: z.string().min(2, 'Badge is required'),
  icon: z.string().min(2, 'Icon name is required'),
  interestRate1Month: z.coerce.number().min(0, 'Must be 0 or greater').optional(),
  interestRate3Months: z.coerce.number().min(0, 'Must be 0 or greater').optional(),
  interestRate6Months: z.coerce.number().min(0, 'Must be 0 or greater').optional(),
  interestRate12Months: z.coerce.number().min(0, 'Must be 0 or greater').optional(),
})

type FormData = z.infer<typeof schema>

const LUCIDE_ICONS = ['PiggyBank', 'Lock', 'RefreshCw', 'ShieldCheck', 'Wallet', 'Coins', 'TrendingUp']

interface SavingsProduct {
  id: string
  type: string
  title: string
  description: string
  rates: string
  badge: string
  icon: string
  interestRate1Month?: any
  interestRate3Months?: any
  interestRate6Months?: any
  interestRate12Months?: any
}

export const EditSavingsProductClient = ({ product }: { product: SavingsProduct }) => {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const { control, handleSubmit, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema) as any,
    defaultValues: {
      type: product.type as any,
      title: product.title,
      description: product.description,
      badge: product.badge,
      icon: product.icon,
      interestRate1Month: product.interestRate1Month ? Number(product.interestRate1Month) : 0,
      interestRate3Months: product.interestRate3Months ? Number(product.interestRate3Months) : 0,
      interestRate6Months: product.interestRate6Months ? Number(product.interestRate6Months) : 0,
      interestRate12Months: product.interestRate12Months ? Number(product.interestRate12Months) : 0,
    },
  })

  const onSubmit = async (data: FormData) => {
    setIsSubmitting(true)
    const result = await updateSavingsProductAction(product.id, data)
    setIsSubmitting(false)

    if (result.error) {
      toast.error(result.error)
    } else {
      toast.success('Savings product updated successfully')
      router.push('/admin/savings')
      router.refresh()
    }
  }

  return (
    <div className='flex flex-col gap-6 w-full max-w-2xl mx-auto'>
      <div className='flex items-center gap-1.5 text-muted-foreground hover:text-primary cursor-pointer transition-colors w-fit text-sm font-semibold'>
        <ArrowLeft className='w-4 h-4' />
        <Link href='/admin/savings'>Back to Savings Management</Link>
      </div>

      <header>
        <h2 className='text-2xl font-bold font-heading text-primary leading-tight'>
          Edit Savings Product
        </h2>
        <p className='text-muted-foreground text-sm mt-1'>
          Modify an existing savings package.
        </p>
      </header>

      <Card className='border border-outline-variant/30 shadow-none rounded-xl p-6'>
        <form onSubmit={handleSubmit(onSubmit)} className='flex flex-col gap-5'>
          <Controller
            control={control}
            name='type'
            render={({ field }) => (
              <Field>
                <FieldLabel>Savings Type</FieldLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <SelectTrigger className='w-full'>
                    <SelectValue placeholder='Select Type' />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='REGULAR'>Regular Savings (Intervals)</SelectItem>
                    <SelectItem value='FIXED'>Fixed Savings (Upfront)</SelectItem>
                    <SelectItem value='STAGGERED'>Staggered Savings (Flexible)</SelectItem>
                  </SelectContent>
                </Select>
                {errors.type && <FieldError errors={[errors.type]} />}
              </Field>
            )}
          />

          <Controller
            control={control}
            name='title'
            render={({ field }) => (
              <Field>
                <FieldLabel>Product Title</FieldLabel>
                <Input {...field} placeholder='e.g. Target Regular Savings' />
                {errors.title && <FieldError errors={[errors.title]} />}
              </Field>
            )}
          />

          <Controller
            control={control}
            name='description'
            render={({ field }) => (
              <Field>
                <FieldLabel>Description</FieldLabel>
                <Textarea {...field} placeholder='Save a specific recurring amount daily, weekly, or monthly...' className='resize-none h-24' />
                {errors.description && <FieldError errors={[errors.description]} />}
              </Field>
            )}
          />

          <div className='grid grid-cols-1 gap-5'>

            <Controller
              control={control}
              name='badge'
              render={({ field }) => (
                <Field>
                  <FieldLabel>Badge Label</FieldLabel>
                  <Input {...field} placeholder='e.g. Consistent' />
                  {errors.badge && <FieldError errors={[errors.badge]} />}
                </Field>
              )}
            />
          </div>

          <Controller
            control={control}
            name='icon'
            render={({ field }) => (
              <Field>
                <FieldLabel>Icon Style</FieldLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <SelectTrigger className='w-full'>
                    <SelectValue placeholder='Select Icon' />
                  </SelectTrigger>
                  <SelectContent>
                    {LUCIDE_ICONS.map(icon => (
                      <SelectItem key={icon} value={icon}>{icon}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.icon && <FieldError errors={[errors.icon]} />}
              </Field>
            )}
          />

          <div className='grid grid-cols-2 md:grid-cols-4 gap-4 mt-4'>
            <div className='flex flex-col gap-1.5'>
              <Label className='text-xs font-semibold text-primary'>1 Month Rate (%)</Label>
              <Input
                type='number'
                step='0.1'
                {...control.register('interestRate1Month')}
                className='h-10 text-sm'
                placeholder='e.g. 5'
              />
              {errors.interestRate1Month && <p className='text-error text-xs'>{errors.interestRate1Month.message}</p>}
            </div>
            <div className='flex flex-col gap-1.5'>
              <Label className='text-xs font-semibold text-primary'>3 Months Rate (%)</Label>
              <Input
                type='number'
                step='0.1'
                {...control.register('interestRate3Months')}
                className='h-10 text-sm'
                placeholder='e.g. 10'
              />
              {errors.interestRate3Months && <p className='text-error text-xs'>{errors.interestRate3Months.message}</p>}
            </div>
            <div className='flex flex-col gap-1.5'>
              <Label className='text-xs font-semibold text-primary'>6 Months Rate (%)</Label>
              <Input
                type='number'
                step='0.1'
                {...control.register('interestRate6Months')}
                className='h-10 text-sm'
                placeholder='e.g. 15'
              />
              {errors.interestRate6Months && <p className='text-error text-xs'>{errors.interestRate6Months.message}</p>}
            </div>
            <div className='flex flex-col gap-1.5'>
              <Label className='text-xs font-semibold text-primary'>12 Months Rate (%)</Label>
              <Input
                type='number'
                step='0.1'
                {...control.register('interestRate12Months')}
                className='h-10 text-sm'
                placeholder='e.g. 25'
              />
              {errors.interestRate12Months && <p className='text-error text-xs'>{errors.interestRate12Months.message}</p>}
            </div>
          </div>

          <Button type='submit' className='mt-8 w-full h-11' disabled={isSubmitting}>
            {isSubmitting ? (
              <><Loader2 className='w-4 h-4 mr-2 animate-spin' /> Saving Changes...</>
            ) : (
              <><Save className='w-4 h-4 mr-2' /> Save Changes</>
            )}
          </Button>
        </form>
      </Card>
    </div>
  )
}
