import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { ShieldAlert } from 'lucide-react'
import { getEAjoGroupForJoin } from '@/models/eajo/query'
import { NewAjoClient } from '@/components/eajo/NewAjoClient'

interface PageProps {
  params: Promise<{ users: string }>
  searchParams: Promise<{ groupId?: string }>
}

const NewEAjoPage = async ({ params, searchParams }: PageProps) => {
  const session = await auth()
  if (!session) redirect('/login')

  const profileId = (await params).users
  const isSelf = session.user.id === profileId
  const isAdmin = session.user.role === 'ADMIN' || session.user.role === 'OWNER'

  if (!isSelf && !isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <ShieldAlert className="w-12 h-12 text-error" />
        <h3 className="font-bold text-lg text-primary">Access Denied</h3>
        <p className="text-muted-foreground text-sm max-w-sm text-center">
          You do not have permission to join Ajo groups.
        </p>
      </div>
    )
  }

  const { groupId } = await searchParams
  if (!groupId) redirect(`/dashboard/${profileId}/eajo`)

  const groupResult = await getEAjoGroupForJoin(groupId)
  if (!groupResult.success || !groupResult.data) {
    return (
      <div className="p-6 text-center text-muted-foreground font-semibold">
        Ajo group not found or is no longer accepting applications.
      </div>
    )
  }

  return <NewAjoClient userId={profileId} group={groupResult.data} />
}

export default NewEAjoPage
