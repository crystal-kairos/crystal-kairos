'use client'

import { useState } from 'react'
import Link from 'next/link'
import { signOut } from 'next-auth/react'
import { Button } from '@/components/ui/button'
import { ArrowLeft, LogOut, LayoutDashboard } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'

interface UnauthorizedActionsProps {
  user?: {
    id: string
    role?: string
  } | null
}

export const UnauthorizedActions = ({ user }: UnauthorizedActionsProps) => {
  const [signingOut, setSigningOut] = useState(false)

  const handleSwitchAccount = async () => {
    setSigningOut(true)
    try {
      await signOut({ callbackUrl: '/login?switch=true' })
    } catch {
      window.location.href = '/login?switch=true'
    }
  }

  const dashboardHref =
    user?.role === 'ADMIN' || user?.role === 'OWNER'
      ? '/admin'
      : user?.id
      ? `/dashboard/${user.id}`
      : null

  const dashboardLabel =
    user?.role === 'ADMIN' || user?.role === 'OWNER'
      ? 'Admin Dashboard'
      : 'Member Dashboard'

  return (
    <div className='flex flex-col gap-3 w-full mt-2'>
      <div className='flex flex-col sm:flex-row gap-3 w-full'>
        <Button
          onClick={handleSwitchAccount}
          disabled={signingOut}
          className='w-full py-6 font-bold shadow-md hover:-translate-y-0.5 active:scale-[0.98] transition-all cursor-pointer'
          variant='secondary'
        >
          {signingOut ? (
            <>
              <Spinner className='mr-2' /> Signing out...
            </>
          ) : (
            <>
              <LogOut className='w-4 h-4 mr-2' /> Switch Account
            </>
          )}
        </Button>

        {dashboardHref && (
          <Button
            asChild
            className='w-full py-6 font-bold shadow-md hover:-translate-y-0.5 active:scale-[0.98] transition-all'
            variant='default'
          >
            <Link href={dashboardHref}>
              <LayoutDashboard className='w-4 h-4 mr-2' /> {dashboardLabel}
            </Link>
          </Button>
        )}
      </div>

      <Button
        asChild
        className='w-full py-5 font-medium hover:-translate-y-0.5 active:scale-[0.98] transition-all'
        variant='outline'
      >
        <Link href='/'>
          <ArrowLeft className='w-4 h-4 mr-2' /> Back to Home
        </Link>
      </Button>
    </div>
  )
}
