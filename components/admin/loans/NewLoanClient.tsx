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
import { createLoanForMemberAction } from '@/models/admin/loanActions'
import { getAllMembers } from '@/models/admin/query'
import { toast } from 'sonner'
import { ArrowLeft, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LoanStatus } from '@/generated/prisma/enums'
import { Textarea } from '@/components/ui/textarea'

const formSchema = z.object({
  userId: z.string().min(1, 'Please select a member'),
  purpose: z.string().min(5, 'Purpose must be at least 5 characters'),
  requestedAmount: z.coerce.number().min(1000, 'Minimum amount is 1000'),
  approvedAmount: z.coerce.number().optional(),
  duration: z.coerce.number().min(1, 'Duration must be at least 1 month').max(36, 'Duration must be at most 36 months'),
  status: z.nativeEnum(LoanStatus),
})

const NewLoanClient = () => {
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
      purpose: '',
      requestedAmount: 0,
      approvedAmount: 0,
      duration: 6,
      status: LoanStatus.ACTIVE,
    },
  })

  const onSubmit = async (values: any) => {
    setIsSubmitting(true)
    try {
      const result = await createLoanForMemberAction(values)

      if (result.success) {
        toast.success('Loan record created successfully.')
        router.push('/admin/loans')
      } else {
        toast.error(result.error || 'Failed to create loan record')
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
          href='/admin/loans'
          className='flex items-center text-sm text-muted-foreground hover:text-primary transition-colors'
        >
          <ArrowLeft className='w-4 h-4 mr-2' />
          Back to Loans
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Record Loan</CardTitle>
          <CardDescription>
            Record a loan for a member. You can skip the normal workflow by selecting the final status (e.g. Active or Disbursed).
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
                name='purpose'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Loan Purpose</FormLabel>
                    <FormControl>
                      <Textarea placeholder='E.g. Business expansion, emergency...' {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name='requestedAmount'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Requested Amount (₦)</FormLabel>
                      <FormControl>
                        <Input type='number' placeholder='0' {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name='approvedAmount'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Approved Amount (₦)</FormLabel>
                      <FormControl>
                        <Input type='number' placeholder='0' {...field} />
                      </FormControl>
                      <FormDescription className="text-[10px]">If different from requested.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name='duration'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Duration (Months)</FormLabel>
                      <FormControl>
                        <Input type='number' min={1} max={36} placeholder='6' {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name='status'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Status</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select status" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value={LoanStatus.PENDING}>Pending</SelectItem>
                          <SelectItem value={LoanStatus.APPROVED}>Approved</SelectItem>
                          <SelectItem value={LoanStatus.ACCEPTED}>Accepted (Awaiting Disbursement)</SelectItem>
                          <SelectItem value={LoanStatus.ACTIVE}>Active</SelectItem>
                          <SelectItem value={LoanStatus.DISBURSED}>Disbursed (Active)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <Button type='submit' className='w-full' disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    Recording Loan...
                  </>
                ) : (
                  'Record Loan'
                )}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  )
}

export default NewLoanClient
