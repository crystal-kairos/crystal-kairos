import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { getSavingsRecords } from '@/models/members/query'
import { getSavingsProducts } from '@/models/savings/query'
import { SavingsHubClient } from '@/components/savings/SavingsHubClient'
import { ShieldAlert } from 'lucide-react'

interface PageProps {
  params: Promise<{ users: string }>
}

const SavingsHubPage = async ({ params }: PageProps) => {
  const session = await auth()

  if (!session) {
    redirect('/login')
  }

  const profileId = (await params).users
  const isSelf = session.user.id === profileId
  const isAdmin = session.user.role === 'ADMIN' || session.user.role === 'OWNER'

  if (!isSelf && !isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <ShieldAlert className="w-12 h-12 text-error" />
        <h3 className="font-bold text-lg text-primary">Access Denied</h3>
        <p className="text-muted-foreground text-sm max-w-sm text-center">
          You do not have permission to view this savings dashboard.
        </p>
      </div>
    )
  }

  const [recordsResult, productsResult] = await Promise.all([
    getSavingsRecords(profileId),
    getSavingsProducts(),
  ])
  
  const savingsPlans = recordsResult.success && recordsResult.data ? recordsResult.data : []
  const availableProducts = productsResult.success && productsResult.data ? productsResult.data : []

  // Map database savings plan structures to plain client component structures
  const mappedPlans = savingsPlans.map((p) => ({
    id: p.id,
    savingsType: p.savingsType,
    targetAmount: p.targetAmount ? Number(p.targetAmount) : null,
    frequency: p.frequency,
    maturity: p.maturity,
    interestRate: Number(p.interestRate),
    currentBalance: Number(p.currentBalance),
    totalDeposited: Number(p.totalDeposited),
    accruedInterest: Number(p.accruedInterest),
    status: p.status,
    startDate: p.startDate,
    maturityDate: p.maturityDate,
  }))

  return <SavingsHubClient userId={profileId} savingsPlans={mappedPlans} availableProducts={availableProducts} />
}

export default SavingsHubPage
