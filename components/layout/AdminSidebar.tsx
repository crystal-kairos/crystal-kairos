'use client'

import { adminNavItems } from './data'
import Sidebar from './Sidebar'
import { AdminPermission, UserRole } from '@/generated/prisma/enums'
import { canAccessAdminNavSection } from '@/lib/authz/permissions'
import { useMemo } from 'react'

interface AdminSidebarProps {
  role?: UserRole
  permissions?: readonly AdminPermission[]
}

const AdminSidebar = ({
  role = UserRole.ADMIN,
  permissions = [],
}: AdminSidebarProps) => {
  const filteredNavItems = useMemo(() => {
    return adminNavItems.filter((item) =>
      canAccessAdminNavSection(role, permissions, item.id),
    )
  }, [role, permissions])

  const canAccessSettings = useMemo(
    () => canAccessAdminNavSection(role, permissions, 'settings'),
    [role, permissions],
  )

  return (
    <Sidebar
      role={role}
      data={filteredNavItems}
      showSettings={canAccessSettings}
    />
  )
}

export default AdminSidebar
