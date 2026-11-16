import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { getLoanRecords, getSavingsRecords } from '@/models/members/query'
import { LoansHubClient } from '@/components/loans/LoansHubClient'
import { GuaranteeRequestsNotice } from '@/components/members/GuaranteeRequestsNotice'
import { ShieldAlert } from 'lucide-react'

interface PageProps {
  params: Promise<{ users: string }>
}

const LoansHubPage = async ({ params }: PageProps) => {
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
          You do not have permission to view this borrowing dashboard.
        </p>
      </div>
    )
  }

  // 1. Fetch member savings plans to sum total active savings balance
  const savingsRes = await getSavingsRecords(profileId)
  const activeSavings = savingsRes.success && savingsRes.data
    ? savingsRes.data.filter((s) => s.status === 'ACTIVE')
    : []
  const totalSavings = activeSavings.reduce((sum, s) => sum + Number(s.currentBalance), 0)

  // 2. Fetch loan records (high limit page size to load list)
  const loansRes = await getLoanRecords(profileId, { page: 1, pageSize: 50 })
  const loans = loansRes.success && loansRes.data ? loansRes.data : []

  // Map database structures to plain client formats
  const mappedLoans = loans.map((l) => ({
    id: l.id,
    requestedAmount: Number(l.requestedAmount),
    approvedAmount: l.approvedAmount ? Number(l.approvedAmount) : null,
    interestRate: Number(l.interestRate),
    duration: l.duration,
    purpose: l.purpose,
    outstandingBalance: Number(l.outstandingBalance),
    totalRepaid: Number(l.totalRepaid),
    status: l.status,
    createdAt: l.createdAt,
  }))

  return (
    <>
      {isSelf && (
        <div className="w-[90%] mx-auto max-w-6xl pt-6">
          <GuaranteeRequestsNotice userId={profileId} />
        </div>
      )}
      <LoansHubClient
        userId={profileId}
        loans={mappedLoans}
        totalSavings={totalSavings}
      />
    </>
  )
}

export default LoansHubPage
