'use client'

import { usePathname } from 'next/navigation'
import { adminNavItems, userNavItems } from './data'
import { useTranslation } from 'react-i18next'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import AddPopUp from './AddPopUp'
import { Button } from '../ui/button'
import { LucideIcon, Plus } from 'lucide-react'
import { useMemo } from 'react'
import { useSession } from 'next-auth/react'
import { AdminPermission, UserRole } from '@/generated/prisma/enums'
import { canAccessAdminNavSection } from '@/lib/authz/permissions'

interface MobileBottomBarProps {
  role?: UserRole
  permissions?: readonly AdminPermission[]
}

const MobileBottomBar = ({ role, permissions = [] }: MobileBottomBarProps) => {
  const pathname = usePathname()
  const { t } = useTranslation('admin')
  const session = useSession()

  const values = useMemo(() => {
    const effectiveRole = role ?? (session.data?.user?.role as UserRole | undefined)
    let dashboardLink = ''
    let navItems: {
      id: string
      label: string
      href: string
      icon: LucideIcon
    }[] = userNavItems

    if (effectiveRole === UserRole.USER) {
      dashboardLink = `/dashboard/${session.data?.user?.id ?? ''}`
      navItems = userNavItems
    } else if (effectiveRole === UserRole.ADMIN || effectiveRole === UserRole.OWNER) {
      dashboardLink = '/admin'
      navItems = adminNavItems.filter((item) =>
        canAccessAdminNavSection(effectiveRole, permissions, item.id),
      )
    }

    return {
      dashboardLink,
      navItems,
      isAdmin: effectiveRole === UserRole.ADMIN || effectiveRole === UserRole.OWNER,
    }
  }, [session, role, permissions])

  return (
    <div className='md:hidden bg-sidebar fixed w-full bottom-0 dark:border-t-2'>
      <div
        className='grid'
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, values.navItems.length)}, ${100 / Math.max(1, values.navItems.length)}%)`,
        }}
      >
        {values.navItems.map((item) => {
          const isActive = pathname === `${values.dashboardLink}${item.href}`

          return (
            <Link
              href={`${values.dashboardLink}${item.href}`}
              key={item.id}
              className={cn(
                'flex flex-col gap-2 items-center py-2 text-sidebar-foreground hover:bg-sidebar-accent',
                isActive ? 'bg-secondary' : '',
              )}
            >
              <item.icon size={20} />
              <span className='text-xs'>{t(item.label)}</span>
            </Link>
          )
        })}
      </div>

      {values.isAdmin && (
        <div className='absolute left-0 right-0 mx-auto top-[-70%] aspect-square w-fit'>
          <AddPopUp
            trigger={
              <Button
                size='icon'
                className='bg-tertiary hover:bg-tertiary-dim w-12 h-12 shadow-2xl'
              >
                <Plus size={32} />
              </Button>
            }
          />
        </div>
      )}
    </div>
  )
}

export default MobileBottomBar
