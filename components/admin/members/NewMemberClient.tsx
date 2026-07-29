'use client'

import { useState } from 'react'
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
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { createMemberAction } from '@/models/admin/actions'
import { toast } from 'sonner'
import { ArrowLeft, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { FieldError } from '@/components/ui/field'

const formSchema = z
  .object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Invalid email address'),
    confirmEmail: z.string().email('Invalid email address'),
  })
  .refine((data) => data.email === data.confirmEmail, {
    message: "Emails don't match",
    path: ['confirmEmail'],
  })

const NewMemberClient = () => {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const form = useForm<z.infer<typeof formSchema>>({
    mode: 'onChange',
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      email: '',
      confirmEmail: '',
    },
  })

  const onSubmit = async (values: any) => {
    setIsSubmitting(true)
    try {
      const result = await createMemberAction(values)

      if (result.success) {
        toast.success(
          'Member created successfully. An email has been sent to them.',
        )
        router.push('/admin/members')
      } else {
        toast.error(result.error || 'Failed to create member')
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
          href='/admin/members'
          className='flex items-center text-sm text-muted-foreground hover:text-primary transition-colors'
        >
          <ArrowLeft className='w-4 h-4 mr-2' />
          Back to Members
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add New Member</CardTitle>
          <CardDescription>
            Register a new cooperative member. They will receive an email with a
            temporary password and will be required to change it and complete
            their profile upon first login.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className='space-y-6'>
              <FormField
                control={form.control}
                name='name'
                render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Full Name</FormLabel>
                    <FormControl>
                      <Input placeholder='Enter member full name' {...field} />
                    </FormControl>
                    {fieldState.invalid && (
                      <FieldError errors={[fieldState.error]} />
                    )}
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name='email'
                render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Email Address</FormLabel>
                    <FormControl>
                      <Input
                        placeholder='Enter member email'
                        type='email'
                        {...field}
                      />
                    </FormControl>
                    {fieldState.invalid && (
                      <FieldError errors={[fieldState.error]} />
                    )}
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name='confirmEmail'
                render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Confirm Email Address</FormLabel>
                    <FormControl>
                      <Input
                        placeholder='Confirm member email'
                        type='email'
                        {...field}
                      />
                    </FormControl>
                    {fieldState.invalid && (
                      <FieldError errors={[fieldState.error]} />
                    )}
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

export default NewMemberClient
