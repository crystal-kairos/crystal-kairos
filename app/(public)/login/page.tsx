import { Suspense } from 'react'
import { AuthShowcase } from '@/components/auth/AuthShowcase'
import LoginForm from '@/components/auth/LoginForm'

const LoginPage = () => {
  return (
    <div className='min-h-screen md:grid md:grid-cols-[1fr_1.1fr] lg:grid-cols-[1.2fr_1fr] flex flex-col bg-surface-container-lowest'>
      <AuthShowcase />

      <div className='flex items-center justify-center p-6 sm:p-12'>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  )
}

export default LoginPage
