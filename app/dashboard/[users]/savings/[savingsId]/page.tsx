import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { getSavingsPlanById } from '@/models/savings/query'
import { SavingsDetailsClient } from '@/components/savings/SavingsDetailsClient'
import { ShieldAlert } from 'lucide-react'

interface PageProps {
  params: Promise<{
    users: string
    savingsId: string
  }>
}

const SavingsDetailsPage = async ({ params }: PageProps) => {
  const session = await auth()

  if (!session) {
    redirect('/login')
  }

  const { users: profileId, savingsId } = await params
  const isSelf = session.user.id === profileId
  const isAdmin = session.user.role === 'ADMIN' || session.user.role === 'OWNER'

  if (!isSelf && !isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <ShieldAlert className="w-12 h-12 text-error" />
        <h3 className="font-bold text-lg text-primary">Access Denied</h3>
        <p className="text-muted-foreground text-sm max-w-sm text-center">
          You do not have permission to view these savings plan details.
        </p>
      </div>
    )
  }

  const res = await getSavingsPlanById(savingsId)

  if (!res.success || !res.data) {
    return (
      <div className="p-6 text-center text-muted-foreground font-semibold">
        Savings plan not found or error occurred: {res.error}
      </div>
    )
  }

  const plan = res.data
  if (plan.userId !== profileId) {
    return (
      <div className="p-6 text-center text-muted-foreground font-semibold">
        Savings plan not found.
      </div>
    )
  }

  return <SavingsDetailsClient userId={profileId} savingsPlan={plan} canAct={isSelf} />
}

export default SavingsDetailsPage
