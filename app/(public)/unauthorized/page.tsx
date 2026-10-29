import { ShieldAlert } from 'lucide-react'
import { auth } from '@/auth'
import { UnauthorizedActions } from '@/components/auth/UnauthorizedActions'

const UnauthorizedPage = async () => {
  const session = await auth()

  return (
    <div className='min-h-screen flex items-center justify-center bg-surface-container-lowest p-6 relative overflow-hidden'>
      {/* Background Decorative Gradients */}
      <div className='absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-red-500/10 rounded-full blur-3xl pointer-events-none' />
      <div className='absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/10 rounded-full blur-3xl pointer-events-none' />
      
      <div className='w-full max-w-md relative z-10'>
        <div className='bg-surface-container p-8 md:p-12 rounded-3xl border border-outline-variant/20 shadow-xl flex flex-col items-center text-center'>
          <div className='w-20 h-20 bg-red-50 rounded-full flex items-center justify-center mb-6 shadow-sm border border-red-100'>
            <ShieldAlert className='w-10 h-10 text-red-500' />
          </div>
          
          <h1 className='font-heading font-bold text-2xl md:text-3xl text-primary mb-3'>
            Access Denied
          </h1>
          <p className='text-muted-foreground text-sm md:text-base mb-6'>
            You don't have the required permissions to view this page. Please log in with an authorized account or return to the dashboard.
          </p>
          
          <UnauthorizedActions
            user={
              session?.user
                ? {
                    id: session.user.id as string,
                    role: session.user.role as string,
                  }
                : null
            }
          />
        </div>
      </div>
    </div>
  )
}

export default UnauthorizedPage
