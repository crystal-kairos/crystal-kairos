import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { getMemberById, getEarningRecords } from '@/models/members/query'
import { getUserLedgerBalances, getUserTransactions } from '@/models/transactions/actions'
import { MemberDashboardBento } from '@/components/members/MemberDashboardBento'
import { ProfileCompletionCard } from '@/components/members/ProfileCompletionCard'
import { SocietyAccountBanner } from '@/components/payments/SocietyAccountBanner'
import { getProfileCompletion } from '@/lib/services/profile.service'
import { getActiveSocietyBankAccountAction } from '@/models/members/actions'
import { ShieldAlert } from 'lucide-react'

interface PageProps {
  params: Promise<{ users: string }>
}

const UserPage = async ({ params }: PageProps) => {
  const session = await auth()

  if (!session) {
    redirect('/login')
  }

  const profileId = (await params).users
  const isSelf = session.user.id === profileId
  const isAdmin = session.user.role === 'ADMIN' || session.user.role === 'OWNER'

  // Access Control: Only self or admin/owner can view the user dashboard
  if (!isSelf && !isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <ShieldAlert className="w-12 h-12 text-error" />
        <h3 className="font-bold text-lg text-primary">Access Denied</h3>
        <p className="text-muted-foreground text-sm max-w-sm text-center">
          You do not have permission to access this member dashboard.
        </p>
      </div>
    )
  }

  // Fetch member info, earnings, ledger balances, transactions, profile completion, and active society bank account concurrently
  const [
    memberResult,
    earningResult,
    balancesResult,
    transactionsResult,
    profileCompletionReport,
    societyAccountResult,
  ] = await Promise.all([
    getMemberById(profileId),
    getEarningRecords(profileId),
    getUserLedgerBalances(profileId),
    getUserTransactions(profileId),
    getProfileCompletion(profileId),
    getActiveSocietyBankAccountAction(),
  ])

  if (!memberResult.success || !memberResult.data) {
    return (
      <div className="p-6 text-center text-muted-foreground font-semibold">
        Member not found.
      </div>
    )
  }

  const member = memberResult.data
  const earningRecords = earningResult.success && earningResult.data ? earningResult.data : []
  
  const defaultBalances = {
    generalWalletBalance: 0,
    subLedgers: {
      ajo: { totalContributed: 0 },
      savings: { totalDeposited: 0, totalWithdrawn: 0, currentSavingsBalance: 0 },
      loans: { totalBorrowed: 0, totalRepaid: 0, outstandingDebt: 0 },
    },
  }

  const balances = balancesResult.success && balancesResult.data ? balancesResult.data : defaultBalances
  const transactions = transactionsResult.success && transactionsResult.data ? transactionsResult.data : []

  // Map earnings to Ajo records structure
  const ajoRecords = earningRecords.map((earning) => ({
    id: earning.id,
    contributionAmount: Number(earning.contributionAmount),
    totalParticipants: earning.totalParticipants,
    duration: earning.duration,
    frequency: earning.frequency,
    payoutPosition: earning.payoutPosition,
    netPayoutAmount: Number(earning.netPayoutAmount),
    status: earning.status,
  }))

  return (
    <div className="w-[95%] sm:w-[90%] mx-auto py-6 max-w-5xl">
      <SocietyAccountBanner
        societyAccount={societyAccountResult.success && societyAccountResult.data ? societyAccountResult.data : null}
        membershipNumber={member.membership?.membershipNumber}
      />
      <ProfileCompletionCard report={profileCompletionReport} userId={profileId} />
      <MemberDashboardBento
        userId={profileId}
        memberName={member.name}
        walletBalance={balances.generalWalletBalance}
        ajoRecords={ajoRecords}
        transactions={transactions}
        hasBankAccounts={(member.bankAccounts || []).length > 0}
        hasNextOfKin={member.nextOfKin !== null}
      />
    </div>
  )
}

export default UserPage
