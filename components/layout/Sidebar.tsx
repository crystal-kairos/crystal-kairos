'use client'

import { cn } from '@/lib/utils'
import { RootState } from '@/store'
import { useDispatch, useSelector } from 'react-redux'
import { Button } from '../ui/button'
import { setSidebarIsCollapsed } from '@/store/nav.store'
import {
  ChevronLeft,
  ChevronRight,
  LucideIcon,
  Plus,
  Settings,
} from 'lucide-react'
import Logo from '../common/Logo'
import { UserRole } from '@/generated/prisma/enums'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { useTranslation } from 'react-i18next'
import { useMemo } from 'react'
import AddPopUp from './AddPopUp'
import UserAvatar from '../common/UserAvatar'
import { Separator } from '../ui/separator'
import Logout from '../common/logout'

interface Data {
  id: string
  label: string
  href: string
  icon: LucideIcon
}

const Sidebar = ({ role, data }: { role: UserRole; data: Data[] }) => {
  const session = useSession()
  const { t } = useTranslation('admin')
  const pathname = usePathname()
  const { sidebarIsCollapsed } = useSelector((store: RootState) => store.nav)
  const dispatch = useDispatch()

  const values = useMemo(() => {
    let dashboardLink = ''
    if (role === UserRole.USER) {
      dashboardLink = session.data?.user.id
        ? `/dashboard/${session.data.user.id}`
        : ''
    } else {
      dashboardLink = '/admin'
    }

    return { dashboardLink, isAdmin: role !== UserRole.USER }
  }, [role, session])

  return (
    <div
      className={cn(
        'hidden md:flex md:flex-col bg-sidebar relative dark:border-r-2',
        sidebarIsCollapsed ? 'w-20' : 'w-60',
      )}
    >
      <Button
        size='icon'
        className='absolute right-0 translate-x-[50%] top-2 bg-sidebar-primary text-on-primary dark:bg-background dark:text-on-surface hover:bg-primary border-surface-container-low'
        onClick={() => dispatch(setSidebarIsCollapsed(!sidebarIsCollapsed))}
      >
        {sidebarIsCollapsed ? <ChevronRight /> : <ChevronLeft />}
      </Button>

      <div
        className={cn(
          'p-3 flex border-b-2 border-outline-variant/30',
          sidebarIsCollapsed ? 'justify-center' : 'justify-start',
        )}
      >
        <Logo showText={!sidebarIsCollapsed} />
      </div>

      <div className='p-3 border-t border-outline-variant/15'>
        <Link
          href={`${values.dashboardLink}/profile`}
          className='p-3 bg-sidebar-accent flex gap-2 rounded-md'
          title={session.data?.user?.name ?? ''}
        >
          <UserAvatar />
          <div
            className={cn(
              'text-sidebar-foreground',
              sidebarIsCollapsed ? 'hidden' : 'block',
            )}
          >
            <h3>{values.isAdmin ? 'System Admin' : session.data?.user.name}</h3>
            <p className='text-xs'>
              {values.isAdmin
                ? session.data?.user.name
                : session.data?.user.email}
            </p>
          </div>
        </Link>
      </div>

      <div className='p-3 flex flex-col gap-1 flex-1'>
        {data.map((item) => {
          const isActive = pathname === `${values.dashboardLink}${item.href}`

          return (
            <Link
              href={`${values.dashboardLink}${item.href}`}
              key={item.id}
              className={cn(
                'flex gap-2 items-center p-3 text-sidebar-foreground rounded-md hover:bg-sidebar-accent',
                isActive ? 'bg-secondary' : '',
                sidebarIsCollapsed ? 'justify-center' : 'justify-start',
              )}
              title={t(item.label)}
            >
              <item.icon />
              <span className={cn(sidebarIsCollapsed ? 'hidden' : 'block')}>
                {t(item.label)}
              </span>
            </Link>
          )
        })}
      </div>

      {values.isAdmin && (
        <div className='p-3'>
          <AddPopUp
            trigger={
              <Button
                variant='secondary'
                className='w-full rounded-sm text-on-secondary'
                title={t('layout.mobile-bottom-bar.add.add')}
              >
                <Plus />
                <span className={cn(sidebarIsCollapsed ? 'hidden' : 'block')}>
                  {t('layout.mobile-bottom-bar.add.add')}
                </span>
              </Button>
            }
          />
        </div>
      )}

      <Separator className='bg-tertiary' />

      <div className='p-3 flex flex-col gap-2'>
        <Button
          asChild
          variant='ghost'
          className={cn(
            'w-full py-2 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground rounded-md',
            sidebarIsCollapsed ? 'justify-center' : 'justify-start',
          )}
          title={t('layout.sidebar.menu-items.settings')}
        >
          <Link href={`${values.dashboardLink}/settings`}>
            <Settings />
            <span className={cn(sidebarIsCollapsed ? 'hidden' : 'block')}>
              {t('layout.sidebar.menu-items.settings')}
            </span>
          </Link>
        </Button>
        <Logout showText={!sidebarIsCollapsed} />
      </div>
    </div>
  )
}

export default Sidebar
