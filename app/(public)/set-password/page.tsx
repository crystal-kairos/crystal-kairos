import SetPasswordForm from '@/components/auth/SetPasswordForm'
import { AuthShowcase } from '@/components/auth/AuthShowcase'
import { verifyPasswordSetToken } from '@/models/auth/query'
import { redirect } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { auth } from '@/auth'
import { signUser } from '@/models/auth/query'
const SetPasswordPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) => {
  const token = (await searchParams).token

  const renderError = (message: string) => (
    <div className='min-h-screen md:grid md:grid-cols-[1fr_1.1fr] lg:grid-cols-[1.2fr_1fr] flex flex-col bg-surface-container-lowest'>
      <AuthShowcase />
      <div className='flex items-center justify-center p-6 sm:p-12'>
        <div className='flex flex-col items-center justify-center p-8 bg-surface-container rounded-2xl max-w-sm w-full border border-outline-variant/20 shadow-sm'>
          <AlertTriangle className='w-12 h-12 text-red-500 mb-4' />
          <h2 className='text-lg font-bold font-heading text-primary text-center mb-2'>
            Invalid Request
          </h2>
          <p className='text-sm text-muted-foreground text-center'>{message}</p>
        </div>
      </div>
    </div>
  )

  const session = await auth()

  if (!token || Array.isArray(token)) {
    if (session?.user && !(session.user as any).hasSetPassword) {
      const response = await signUser(session.user.id as string, session.user.email as string)
      if (response.success && response.token) {
        redirect(`/set-password?token=${response.token}`)
      }
    }
    return renderError('Missing or malformed reset token.')
  }

  // Double check they shouldn't just be redirected away
  if (session?.user && (session.user as any).hasSetPassword) {
    const role = (session.user as any).role
    redirect(role === 'USER' ? `/dashboard/${session.user.id}` : '/admin')
  }

  const data = await verifyPasswordSetToken(token)

  if (data.redirect) {
    redirect(data.redirect)
  }

  if (data.error || !data.data) {
    return renderError('The password reset link is invalid or has expired.')
  }

  return (
    <div className='min-h-screen md:grid md:grid-cols-[1fr_1.1fr] lg:grid-cols-[1fr_1.5fr] flex flex-col bg-surface-container-lowest'>
      <AuthShowcase />
      <div className='w-full flex items-center justify-center p-6 sm:p-12'>
        <SetPasswordForm email={data.data.userEmail} token={token} />
      </div>
    </div>
  )
}

export default SetPasswordPage
