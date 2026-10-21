import { AdminSettingsClient } from '@/components/admin/AdminSettingsClient'
import { getAdminStaffMembers } from '@/models/admin/query'
import { AlertCircle } from 'lucide-react'

const AdminSettingsPage = async () => {
  const staffRes = await getAdminStaffMembers()

  if (!staffRes.success || !staffRes.data) {
    return (
      <div className='bg-error-container/10 border border-error-container/30 text-error p-4 rounded-lg flex items-start gap-2 text-xs'>
        <AlertCircle className='w-4.5 h-4.5 shrink-0 mt-0.5' />
        <span>Failed to load settings: {staffRes.error}</span>
      </div>
    )
  }

  return (
    <AdminSettingsClient
      staff={staffRes.data}
      actorRole={staffRes.actorRole ?? 'ADMIN'}
    />
  )
}

export default AdminSettingsPage
