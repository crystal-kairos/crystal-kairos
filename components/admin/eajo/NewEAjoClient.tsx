'use client'

import { useState, useEffect, useMemo } from 'react'
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
import { addMemberToEAjoGroupAction } from '@/models/admin/eajoActions'
import { getAllMembers } from '@/models/admin/query'
import { toast } from 'sonner'
import { ArrowLeft, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EAjoMemberStatus } from '@/generated/prisma/enums'

const formSchema = z.object({
  userId: z.string().min(1, 'Please select a member'),
  groupId: z.string().min(1, 'Please select an eAjo group'),
  payoutPosition: z.coerce.number().min(1, 'Position must be at least 1'),
  guarantorName: z.string().optional(),
  guarantorPhoneNumber: z.string().optional(),
  status: z.nativeEnum(EAjoMemberStatus),
  receiptUrl: z.string().optional(),
})

const NewEAjoClient = ({ groups }: { groups: any[] }) => {
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
      groupId: '',
      payoutPosition: 1,
      guarantorName: '',
      guarantorPhoneNumber: '',
      status: EAjoMemberStatus.ACTIVE,
      receiptUrl: '',
    },
  })

  const selectedGroupId = form.watch('groupId')
  
  const selectedGroup = useMemo(() => {
    return groups.find(g => g.id === selectedGroupId)
  }, [selectedGroupId, groups])

  const onSubmit = async (values: any) => {
    setIsSubmitting(true)
    try {
      const result = await addMemberToEAjoGroupAction(values)

      if (result.success) {
        toast.success('Member added to eAjo group successfully.')
        router.push('/admin/eajo')
      } else {
        toast.error(result.error || 'Failed to add member')
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
          href='/admin/eajo'
          className='flex items-center text-sm text-muted-foreground hover:text-primary transition-colors'
        >
          <ArrowLeft className='w-4 h-4 mr-2' />
          Back to eAjo Groups
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add Member to eAjo Group</CardTitle>
          <CardDescription>
            Register a member into an existing eAjo group. You can specify their status and optional initial contribution.
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
                name='groupId'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>eAjo Group</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a group" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {groups.map(group => (
                          <SelectItem key={group.id} value={group.id}>
                            Group #{group.id.substring(0, 8)} - ₦{Number(group.contributionAmount)}/{group.frequency.toLowerCase()}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      {selectedGroup && `Total Participants: ${selectedGroup.totalSlots}`}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name='payoutPosition'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Payout Position</FormLabel>
                      <FormControl>
                        <Input type='number' min={1} max={selectedGroup?.totalSlots || 12} placeholder='1' {...field} />
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
                      <FormLabel>Membership Status</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select status" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value={EAjoMemberStatus.PENDING}>Pending</SelectItem>
                          <SelectItem value={EAjoMemberStatus.APPROVED}>Approved</SelectItem>
                          <SelectItem value={EAjoMemberStatus.ACTIVE}>Active</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name='guarantorName'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Guarantor Name (Optional)</FormLabel>
                      <FormControl>
                        <Input placeholder='Jane Doe' {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name='guarantorPhoneNumber'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Guarantor Phone (Optional)</FormLabel>
                      <FormControl>
                        <Input placeholder='+234...' {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name='receiptUrl'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Initial Contribution Receipt URL (Optional)</FormLabel>
                    <FormControl>
                      <Input placeholder='https://...' {...field} />
                    </FormControl>
                    <FormDescription>If provided, an initial contribution will be recorded automatically.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button type='submit' className='w-full' disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    Adding Member...
                  </>
                ) : (
                  'Add Member'
                )}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  )
}

export default NewEAjoClient
