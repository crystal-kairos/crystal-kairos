'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { createSavingsForMemberAction } from '@/models/admin/savingsActions'
import { getAllMembers } from '@/models/admin/query'
import { toast } from 'sonner'
import { ArrowLeft, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SavingsFrequency, SavingsMaturity } from '@/generated/prisma/enums'

const formSchema = z.object({
  userId: z.string().min(1, 'Please select a member'),
  productId: z.string().min(1, 'Please select a savings product'),
  targetAmount: z.coerce.number().min(1000, 'Minimum amount is 1000'),
  frequency: z.nativeEnum(SavingsFrequency),
  maturity: z.nativeEnum(SavingsMaturity),
  receiptUrl: z.string().optional(),
})

const NewSavingsClient = ({ products }: { products: any[] }) => {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [members, setMembers] = useState<any[]>([])
  const [isLoadingMembers, setIsLoadingMembers] = useState(true)

  useEffect(() => {
    const fetchMembers = async () => {
      try {
        const res = await getAllMembers()
        if (res.success && res.data) {
          setMembers(res.data)
        }
      } catch (e) {
        console.error(e)
      } finally {
        setIsLoadingMembers(false)
      }
    }
    fetchMembers()
  }, [])

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema) as any,
    defaultValues: {
      userId: '',
      productId: '',
      targetAmount: 0,
      frequency: SavingsFrequency.MONTHLY,
      maturity: SavingsMaturity.SIX_MONTHS,
      receiptUrl: '',
    },
  })

  const onSubmit = async (values: any) => {
    setIsSubmitting(true)
    try {
      const result = await createSavingsForMemberAction(values)

      if (result.success) {
        toast.success('Savings record created successfully.')
        router.push('/admin/savings')
      } else {
        toast.error(result.error || 'Failed to create savings record')
      }
    } catch (error) {
      toast.error('An unexpected error occurred.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className='p-4 md:p-6 lg:p-8 w-full max-w-2xl mx-auto'>
      <div className='mb-6'>
        <Link
          href='/admin/savings'
          className='flex items-center text-sm text-muted-foreground hover:text-primary transition-colors'
        >
          <ArrowLeft className='w-4 h-4 mr-2' />
          Back to Savings
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Create Savings Record</CardTitle>
          <CardDescription>
            Register a member for a savings plan and optionally upload their initial deposit receipt.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className='space-y-6'>
              
              <FormField
                control={form.control}
                name='userId'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Select Member</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={isLoadingMembers ? "Loading members..." : "Select a member"} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {members.map(member => (
                          <SelectItem key={member.id} value={member.id}>
                            {member.name} ({member.email})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name='productId'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Savings Product</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a savings product" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {products.map(product => (
                          <SelectItem key={product.id} value={product.id}>
                            {product.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name='targetAmount'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Contribution Amount (₦)</FormLabel>
                      <FormControl>
                        <Input type='number' placeholder='Amount' {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name='frequency'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Frequency</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select frequency" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value={SavingsFrequency.DAILY}>Daily</SelectItem>
                          <SelectItem value={SavingsFrequency.WEEKLY}>Weekly</SelectItem>
                          <SelectItem value={SavingsFrequency.MONTHLY}>Monthly</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name='maturity'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Maturity Duration</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select maturity" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={SavingsMaturity.ONE_MONTH}>1 Month</SelectItem>
                        <SelectItem value={SavingsMaturity.THREE_MONTHS}>3 Months</SelectItem>
                        <SelectItem value={SavingsMaturity.SIX_MONTHS}>6 Months</SelectItem>
                        <SelectItem value={SavingsMaturity.TWELVE_MONTHS}>12 Months</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name='receiptUrl'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Initial Deposit Receipt URL (Optional)</FormLabel>
                    <FormControl>
                      <Input placeholder='https://...' {...field} />
                    </FormControl>
                    <FormDescription>Provide a valid URL to the receipt to automatically record the first deposit.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button type='submit' className='w-full' disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    Creating Record...
                  </>
                ) : (
                  'Create Savings Record'
                )}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  )
}

export default NewSavingsClient
