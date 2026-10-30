import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { getMemberById } from '@/models/members/query'
import BanksClient from './BanksClient'
import { getMemberPendingProfileChangesAction } from '@/models/members/profile-change-actions'
import { ProfileChangeType } from '@/generated/prisma/enums'
import { ShieldAlert } from 'lucide-react'

interface PageProps {
  params: Promise<{ users: string }>
}

export default async function BanksPage({ params }: PageProps) {
  const session = await auth()
  if (!session) {
    redirect('/login')
  }

  const profileId = (await params).users
  const isSelf = session.user.id === profileId
  const isAdmin = session.user.role === 'ADMIN' || session.user.role === 'OWNER'

  // Access Control: Only self or admin/owner can view
  if (!isSelf && !isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <ShieldAlert className="w-12 h-12 text-error" />
        <h3 className="font-bold text-lg text-primary">Access Denied</h3>
        <p className="text-muted-foreground text-sm max-w-sm text-center">
          You do not have permission to view or manage these bank configurations.
        </p>
      </div>
    )
  }

  const memberResult = await getMemberById(profileId)
  if (!memberResult.success || !memberResult.data) {
    return (
      <div className="p-6 text-center text-muted-foreground font-semibold">
        Member not found.
      </div>
    )
  }

  const member = memberResult.data
  const bankAccounts = member.bankAccounts || []

  const pendingRes = await getMemberPendingProfileChangesAction(profileId)
  const pendingPrimaryAccountId =
    pendingRes.success && pendingRes.data
      ? (
          pendingRes.data.find(
            (r) => r.changeType === ProfileChangeType.PRIMARY_BANK,
          )?.proposedValue as any
        )?.targetBankAccountId || null
      : null

  return (
    <BanksClient
      userId={profileId}
      bankAccounts={bankAccounts}
      pendingPrimaryAccountId={pendingPrimaryAccountId}
    />
  )
}
