'use client'

import React, { useState } from 'react'
import { AdminPermission } from '@/generated/prisma/enums'
import {
  ALL_ADMIN_PERMISSIONS,
  PERMISSION_GROUPS,
} from '@/lib/authz/permissions'
import { setAdminPermissionsAction } from '@/models/admin/actions'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ShieldCheck, Save, CheckSquare, Square } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

export interface StaffMemberWithPermissions {
  id: string
  name: string
  email: string
  role: string
  lastLoginAt: Date | null
  createdAt: Date
  permissions?: AdminPermission[]
}

interface AdminPermissionsEditorProps {
  staffMember: StaffMemberWithPermissions
  canEdit: boolean
  onSaved?: (updatedPermissions: AdminPermission[]) => void
}

export const AdminPermissionsEditor = ({
  staffMember,
  canEdit,
  onSaved,
}: AdminPermissionsEditorProps) => {
  const router = useRouter()
  const isOwnerTarget = staffMember.role === 'OWNER'
  const [selected, setSelected] = useState<Set<AdminPermission>>(
    () =>
      new Set(
        isOwnerTarget
          ? ALL_ADMIN_PERMISSIONS
          : (staffMember.permissions ?? []),
      ),
  )
  const [saving, setSaving] = useState(false)

  const togglePermission = (permission: AdminPermission) => {
    if (!canEdit || isOwnerTarget) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(permission)) {
        next.delete(permission)
      } else {
        next.add(permission)
      }
      return next
    })
  }

  const handleSelectAll = () => {
    if (!canEdit || isOwnerTarget) return
    setSelected(new Set(ALL_ADMIN_PERMISSIONS))
  }

  const handleClearAll = () => {
    if (!canEdit || isOwnerTarget) return
    setSelected(new Set())
  }

  const handleSave = async () => {
    if (!canEdit || isOwnerTarget) return
    setSaving(true)
    try {
      const nextList = Array.from(selected)
      const res = await setAdminPermissionsAction(staffMember.id, nextList)
      if (res.success && res.data) {
        toast.success(`Updated permissions for ${staffMember.name}.`)
        onSaved?.(res.data.permissions)
        router.refresh()
      } else {
        toast.error(res.error || 'Failed to update permissions.')
      }
    } catch {
      toast.error('Something went wrong while updating permissions.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant/20 pb-3'>
        <div>
          <h4 className='text-sm font-bold text-primary flex items-center gap-1.5'>
            <ShieldCheck className='w-4 h-4 text-primary' />
            <span>
              Permissions for {staffMember.name} ({staffMember.email})
            </span>
          </h4>
          <p className='text-xs text-muted-foreground mt-0.5'>
            {isOwnerTarget
              ? 'OWNER accounts hold every administrative permission automatically.'
              : canEdit
                ? 'Grant only the operations this administrator needs. Changes take effect on their next request.'
                : 'Read-only view. Only the cooperative OWNER can modify staff permissions.'}
          </p>
        </div>

        {canEdit && !isOwnerTarget && (
          <div className='flex items-center gap-2'>
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={handleSelectAll}
              className='text-xs h-8'
            >
              <CheckSquare className='w-3.5 h-3.5 mr-1' />
              Select All
            </Button>
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={handleClearAll}
              className='text-xs h-8'
            >
              <Square className='w-3.5 h-3.5 mr-1' />
              Clear All
            </Button>
            <Button
              type='button'
              size='sm'
              disabled={saving}
              onClick={handleSave}
              className='bg-primary text-on-primary text-xs font-bold h-8 px-3'
            >
              <Save className='w-3.5 h-3.5 mr-1' />
              {saving ? 'Saving...' : 'Save Grants'}
            </Button>
          </div>
        )}
      </div>

      <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
        {PERMISSION_GROUPS.map((group) => (
          <Card
            key={group.id}
            className='p-4 bg-surface-container-lowest border border-outline-variant/15 rounded-xl space-y-3'
          >
            <h5 className='text-xs font-bold uppercase tracking-wider text-primary border-b border-outline-variant/15 pb-1.5'>
              {group.title}
            </h5>
            <div className='space-y-2.5'>
              {group.permissions.map((item) => {
                const checked = isOwnerTarget || selected.has(item.permission)
                const disabled = !canEdit || isOwnerTarget

                return (
                  <label
                    key={item.permission}
                    className={`flex items-start gap-2.5 text-xs ${
                      disabled ? 'opacity-70 cursor-not-allowed' : 'cursor-pointer'
                    }`}
                  >
                    <input
                      type='checkbox'
                      checked={checked}
                      disabled={disabled}
                      onChange={() => togglePermission(item.permission)}
                      className='mt-0.5 rounded border-outline text-primary focus:ring-primary'
                    />
                    <div>
                      <div className='font-semibold text-primary'>
                        {item.label}{' '}
                        <span className='text-[10px] font-mono text-muted-foreground'>
                          ({item.permission})
                        </span>
                      </div>
                      <div className='text-[11px] text-muted-foreground'>
                        {item.description}
                      </div>
                    </div>
                  </label>
                )
              })}
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}

export default AdminPermissionsEditor
