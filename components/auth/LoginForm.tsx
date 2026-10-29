'use client'

import { useTranslation } from 'react-i18next'
import { Field, FieldError, FieldGroup, FieldLabel } from '../ui/field'
import { Controller, useForm } from 'react-hook-form'
import * as z from 'zod'
import { loginSchema } from '@/schema/auth.schema'
import { standardSchemaResolver } from '@hookform/resolvers/standard-schema'
import { Mail, LockKeyhole, Eye, EyeOff, ArrowRight } from 'lucide-react'
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group'
import { Button } from '../ui/button'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BankIcon, LoginFoot, ShieldIcon } from './login-icons'
import { signIn, signOut, useSession } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { Spinner } from '../ui/spinner'

const ERROR_MESSAGES: Record<string, string> = {
  user_not_found: 'login.errors.user_not_found',
  password_not_set: 'login.errors.password_not_set',
  invalid_credentials: 'login.errors.invalid_credentials',
  account_not_activated: 'login.errors.account_not_activated',
  default: 'login.errors.default',
}

const LoginForm = () => {
  const { t } = useTranslation('auth')
  const [showPassword, setShowPassword] = useState(false)
  const session = useSession()
  const router = useRouter()
  const searchParams = useSearchParams()
  const isSwitching = searchParams.get('switch') === 'true'
  const sessionError = searchParams.get('error')
  const [loading, setLoading] = useState(false)
  const [justLoggedIn, setJustLoggedIn] = useState(false)

  useEffect(() => {
    if (isSwitching && session.data) {
      signOut({ redirect: false })
    }
  }, [isSwitching, session.data])

  useEffect(() => {
    if (sessionError === 'session_expired') {
      toast.error(
        t('login.errors.session_expired', {
          defaultValue: 'Your session has expired. Please sign in again.',
        }),
      )
    }
  }, [sessionError, t])

  const { control, handleSubmit } = useForm<z.infer<typeof loginSchema>>({
    resolver: standardSchemaResolver(loginSchema),
    mode: 'onChange',
    defaultValues: {
      email: '',
      password: '',
    },
  })

  const onSubmit = async (formData: z.infer<typeof loginSchema>) => {
    setLoading(true)
    const result = await signIn('credentials', {
      email: formData.email,
      password: formData.password,
      redirect: false,
    })

    if (result.error) {
      toast.error(
        t(ERROR_MESSAGES[result.code ?? ''] ?? ERROR_MESSAGES.default),
      )
      setLoading(false)
      return
    }

    setJustLoggedIn(true)
    window.location.href = '/'
  }

  useEffect(() => {
    if (isSwitching) return
    if ((justLoggedIn || session.status === 'authenticated') && session.data?.user) {
      if (session.data.user.role === 'USER') {
        router.replace(`/dashboard/${session.data.user.id}`)
      } else {
        router.replace('/admin')
      }
    }
  }, [justLoggedIn, session, isSwitching, router])

  return (
    <div className='w-full max-w-110 mx-auto flex justify-center items-center'>
      <div className='flex flex-col gap-6 w-full'>
        <section className='flex flex-col items-start'>
          <h3 className='font-heading font-bold text-2xl text-primary tracking-tight'>
            {t('login.welcome_back')}
          </h3>
          <p className='text-muted-foreground text-sm mt-1'>
            {t('login.access_your_portal')}
          </p>
        </section>

        <form className='flex flex-col gap-5' onSubmit={handleSubmit(onSubmit)}>
          <FieldGroup>
            <Controller
              name='email'
              control={control}
              render={({ field, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor='login-email'>
                    {t('login.form.email')}
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <Mail />
                    </InputGroupAddon>
                    <InputGroupInput
                      {...field}
                      placeholder='e.g. johndoe@example.com'
                      id='login-email'
                    />
                  </InputGroup>
                  {fieldState.invalid && (
                    <FieldError errors={[fieldState.error]} />
                  )}
                </Field>
              )}
            />

            <Controller
              name='password'
              control={control}
              render={({ field, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor='login-password'>
                    {t('login.form.password')}{' '}
                    <Link
                      href='/forgot-password'
                      className='ml-auto text-primary underline'
                    >
                      {t('login.form.forgot_password')}
                    </Link>
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <LockKeyhole />
                    </InputGroupAddon>
                    <InputGroupInput
                      {...field}
                      placeholder='********'
                      id='login-password'
                      type={showPassword ? 'text' : 'password'}
                    />
                    <InputGroupAddon align='inline-end'>
                      <Button
                        size='icon'
                        variant='ghost'
                        className='cursor-pointer'
                        onClick={() => setShowPassword(!showPassword)}
                        type='button'
                      >
                        {showPassword ? <EyeOff /> : <Eye />}
                      </Button>
                    </InputGroupAddon>
                  </InputGroup>
                  {fieldState.invalid && (
                    <FieldError errors={[fieldState.error]} />
                  )}
                </Field>
              )}
            />
          </FieldGroup>

          <Button
            className='w-full cursor-pointer text-on-secondary rounded-xl py-6 font-bold shadow-md hover:shadow-lg hover:-translate-y-0.5 active:scale-[0.98] transition-all'
            variant='secondary'
            disabled={loading}
          >
            {loading && <Spinner />}{' '}
            {loading ? t('login.form.loading') : t('login.form.login')}{' '}
            {!loading && <ArrowRight className='w-5 h-5 ml-1' />}
          </Button>
        </form>

        <div>
          <p className='text-center'>
            {t('login.form.dont_have_account')}{' '}
            <Link href='/register' className='text-secondary hover:underline'>
              {t('login.form.sign_up')}
            </Link>
          </p>

          <section className='flex justify-center gap-4 items-center mt-8'>
            <LoginFoot
              Icon={<ShieldIcon />}
              label={t('login.footer.secure_ssl')}
            />
            <LoginFoot
              Icon={<BankIcon />}
              label={t('login.footer.regulated')}
            />
          </section>
        </div>
      </div>
    </div>
  )
}

export default LoginForm
