import { ProfileChangeReviewQueue } from '@/components/admin/ProfileChangeReviewQueue'
import { getProfileChangeRequestsAction } from '@/models/admin/profile-change-actions'
import { auth } from '@/auth'
import { requireAnyPermission } from '@/lib/authz/guards'
import { AdminPermission } from '@/generated/prisma/enums'
import { AlertCircle } from 'lucide-react'

export const dynamic = 'force-dynamic'

const AdminProfileChangesPage = async () => {
  const actor = await requireAnyPermission([
    AdminPermission.PROFILE_CHANGES_REVIEW,
  ])

  const res = await getProfileChangeRequestsAction({ limit: 50 })

  if (!res.success || !res.data) {
    return (
      <div className='p-6 max-w-7xl mx-auto'>
        <div className='bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 p-4 rounded-lg flex items-start gap-2 text-xs'>
          <AlertCircle className='w-4 h-4 shrink-0 mt-0.5' />
          <span>Failed to load profile change review queue: {res.error}</span>
        </div>
      </div>
    )
  }

  return (
    <div className='p-6 max-w-7xl mx-auto'>
      <ProfileChangeReviewQueue
        initialRequests={res.data.requests as any}
        currentAdminId={actor.id}
        initialStats={res.data.stats}
      />
    </div>
  )
}

export default AdminProfileChangesPage
