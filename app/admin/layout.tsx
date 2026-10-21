import Header from '@/components/layout/Header'
import MobileBottomBar from '@/components/layout/MobileBottomBar'
import AdminSidebar from '@/components/layout/AdminSidebar'
import { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { requireStaffSession } from '@/lib/authz/guards'

const Layout = async ({ children }: { children: ReactNode }) => {
  let actor
  try {
    actor = await requireStaffSession()
  } catch {
    redirect('/unauthorized')
  }

  return (
    <div className='flex h-screen'>
      <AdminSidebar
        role={actor.role}
        permissions={Array.from(actor.permissions)}
      />
      <div className='flex-1 flex flex-col overflow-auto'>
        <Header />
        <div className='flex-1 p-3 mb-20'>{children}</div>
        <MobileBottomBar
          role={actor.role}
          permissions={Array.from(actor.permissions)}
        />
      </div>
    </div>
  )
}

export default Layout
