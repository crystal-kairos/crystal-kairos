'use client'

import { SetPasswordFormSchema, setPasswordSchema } from '@/schema/auth.schema'
import { standardSchemaResolver } from '@hookform/resolvers/standard-schema'
import { Controller, useForm } from 'react-hook-form'
import { Field, FieldError, FieldLabel } from '../ui/field'
import { useTranslation } from 'react-i18next'
import { Input } from '../ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group'
import { useState } from 'react'
import { Button } from '../ui/button'
import { Eye, EyeOff } from 'lucide-react'
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../ui/card'
import Link from 'next/link'
import { setPassword } from '@/models/auth/query'
import { toast } from 'sonner'
import { REDIRECT_DELAY } from '@/lib/constants'
import { signOut } from 'next-auth/react'

const SetPasswordForm = ({
  email,
  token,
}: {
  email: string
  token: string
}) => {
  const { t } = useTranslation('auth')
  const [isLoading, setIsLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  const { control, handleSubmit } = useForm<SetPasswordFormSchema>({
    mode: 'onChange',
    resolver: standardSchemaResolver(setPasswordSchema),
    defaultValues: {
      email,
      password: '',
      confirmPassword: '',
    },
  })

  const onSubmit = async (formData: SetPasswordFormSchema) => {
    setIsLoading(true)
    const response = await setPassword(formData, token)
    setIsLoading(false)

    if (response.error) {
      toast.error(
        typeof response.error === 'string'
          ? response.error
          : 'This setup link is no longer valid.',
      )
      return
    }

    if (response.success) {
      toast.success(
        t('set_password.success', { seconds: REDIRECT_DELAY / 1000 }),
      )
      setTimeout(() => {
        signOut({ callbackUrl: '/login' })
      }, REDIRECT_DELAY)
    }
  }

  return (
    <div className='w-full max-w-110 mx-auto'>
      <div className='rounded-2xl shadow-none bg-transparent'>
        <CardHeader className='px-0 pb-6'>
          <CardTitle className='font-heading font-bold text-2xl text-primary tracking-tight'>
            {t('set_password.page_title')}
          </CardTitle>
          <CardDescription className='text-muted-foreground text-sm mt-1'>
            {t('set_password.page_description')}
          </CardDescription>
        </CardHeader>

        <CardContent className='px-0'>
          <form
            onSubmit={handleSubmit(onSubmit)}
            className='flex flex-col gap-5'
          >
            <Controller
              control={control}
              name='email'
              render={({ field, fieldState }) => {
                return (
                  <Field className='mb-5'>
                    <FieldLabel>{t('set_password.form.email')}</FieldLabel>
                    <Input
                      {...field}
                      placeholder={t('set_password.form.email')}
                      disabled
                      className='rounded-sm cursor-not-allowed disabled:opacity-30'
                    />
                    {fieldState.invalid && (
                      <FieldError errors={[fieldState.error]} />
                    )}
                  </Field>
                )
              }}
            />

            <Controller
              control={control}
              name='password'
              render={({ field, fieldState }) => {
                return (
                  <Field className='mb-5'>
                    <FieldLabel>{t('set_password.form.password')}</FieldLabel>
                    <InputGroup>
                      <InputGroupInput
                        {...field}
                        placeholder={t('set_password.form.password')}
                        className='rounded-sm'
                        type={showPassword ? 'text' : 'password'}
                      />
                      <InputGroupAddon align='inline-end'>
                        <Button
                          variant='ghost'
                          size='icon'
                          type='button'
                          onClick={() => setShowPassword(!showPassword)}
                        >
                          {showPassword ? <EyeOff /> : <Eye />}
                        </Button>
                      </InputGroupAddon>
                    </InputGroup>
                    {fieldState.invalid && (
                      <FieldError errors={[fieldState.error]} />
                    )}
                  </Field>
                )
              }}
            />

            <Controller
              control={control}
              name='confirmPassword'
              render={({ field, fieldState }) => {
                return (
                  <Field className='mb-5'>
                    <FieldLabel>
                      {t('set_password.form.confirm_password')}
                    </FieldLabel>
                    <InputGroup>
                      <InputGroupInput
                        {...field}
                        placeholder={t('set_password.form.confirm_password')}
                        className='rounded-sm'
                        type={showConfirmPassword ? 'text' : 'password'}
                      />
                      <InputGroupAddon align='inline-end'>
                        <Button
                          variant='ghost'
                          size='icon'
                          type='button'
                          onClick={() =>
                            setShowConfirmPassword(!showConfirmPassword)
                          }
                        >
                          {showConfirmPassword ? <EyeOff /> : <Eye />}
                        </Button>
                      </InputGroupAddon>
                    </InputGroup>
                    {fieldState.invalid && (
                      <FieldError errors={[fieldState.error]} />
                    )}
                  </Field>
                )
              }}
            />

            <Button
              className='w-full mt-6 cursor-pointer text-on-secondary rounded-xl py-6 font-bold shadow-md hover:shadow-lg hover:-translate-y-0.5 active:scale-[0.98] transition-all'
              variant='secondary'
              disabled={isLoading}
            >
              {isLoading
                ? t('set_password.form.buttons.loading')
                : t('set_password.form.buttons.submit')}
            </Button>
          </form>
        </CardContent>
        <CardFooter className='flex justify-center text-primary underline'>
          <Link href='/login'>{t('set_password.login')}</Link>
        </CardFooter>
      </div>
    </div>
  )
}

export default SetPasswordForm
