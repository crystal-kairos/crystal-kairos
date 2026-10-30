import Header from '@/components/layout/Header'
import MobileBottomBar from '@/components/layout/MobileBottomBar'
import UserSidebar from '@/components/layout/UserSidebar'
import { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { AuthzError, requireMemberSession } from '@/lib/authz/guards'

interface MemberDashboardLayoutProps {
  children: ReactNode
  params: Promise<{ users: string }>
}

const Layout = async ({ children, params }: MemberDashboardLayoutProps) => {
  const resolvedParams = await params

  try {
    await requireMemberSession(resolvedParams.users)
  } catch (error) {
    if (error instanceof AuthzError && error.code === 'UNAUTHENTICATED') {
      redirect('/login?error=session_expired')
    }
    redirect('/unauthorized')
  }

  return (
    <div className='flex h-screen'>
      <UserSidebar />
      <div className='flex-1 flex flex-col overflow-auto'>
        <Header />
        <div className='flex-1 p-3 mb-20'>{children}</div>
        <MobileBottomBar />
      </div>
    </div>
  )
}

export default Layout
