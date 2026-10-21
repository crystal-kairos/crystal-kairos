import { getAdminStaffMembers } from '@/models/admin/query'
import { AdminPermissionsEditor } from '@/components/admin/AdminPermissionsEditor'
import { AlertCircle, Shield } from 'lucide-react'
import Link from 'next/link'

const AdminPermissionsPage = async () => {
  const staffRes = await getAdminStaffMembers()

  if (!staffRes.success || !staffRes.data) {
    return (
      <div className='bg-error-container/10 border border-error-container/30 text-error p-4 rounded-lg flex items-start gap-2 text-xs'>
        <AlertCircle className='w-4 h-4 shrink-0 mt-0.5' />
        <span>
          {staffRes.error || 'You do not have permission to view staff permissions.'}
        </span>
      </div>
    )
  }

  const staffList = staffRes.data
  const canEdit = staffRes.actorRole === 'OWNER'

  return (
    <div className='flex flex-col gap-6 w-full py-2'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div>
          <h2 className='text-2xl font-bold font-heading text-primary leading-tight flex items-center gap-2'>
            <Shield className='w-6 h-6 text-primary' />
            <span>Staff Permissions Matrix</span>
          </h2>
          <p className='text-muted-foreground text-xs mt-1'>
            Configure granular administrative permissions for each staff member.
          </p>
        </div>
        <Link
          href='/admin/settings'
          className='text-xs font-bold text-primary underline'
        >
          Back to System Settings
        </Link>
      </div>

      <div className='space-y-8'>
        {staffList.map((member) => (
          <div
            key={member.id}
            className='p-5 rounded-xl border border-outline-variant/20 bg-surface-container-low/40'
          >
            <AdminPermissionsEditor staffMember={member} canEdit={canEdit} />
          </div>
        ))}
      </div>
    </div>
  )
}

export default AdminPermissionsPage
