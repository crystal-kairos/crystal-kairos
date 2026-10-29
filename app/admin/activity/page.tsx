import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { getAdminAuditEventsQuery } from '@/models/admin/query'
import { ActivityLogClient } from '@/components/admin/ActivityLogClient'

export const metadata = {
  title: 'Activity & Audit Log | Crystal Kairos',
}

const AdminActivityLogPage = async () => {
  const session = await auth()
  if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
    redirect('/unauthorized')
  }

  const result = await getAdminAuditEventsQuery({ page: 1, pageSize: 20 })

  const initialData = result.success && result.data ? (result.data as any) : {
    events: [],
    total: 0,
    page: 1,
    pageSize: 20,
    totalPages: 0,
  }

  return (
    <div className="p-6 w-full max-w-7xl mx-auto">
      <ActivityLogClient initialData={initialData} />
    </div>
  )
}

export default AdminActivityLogPage
