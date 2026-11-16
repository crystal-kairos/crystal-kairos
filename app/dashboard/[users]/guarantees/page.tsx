import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { ShieldAlert } from 'lucide-react'
import { getMyLoanGuaranteeRequests } from '@/models/loans/query'
import { getMyEAjoGuaranteeRequests } from '@/models/eajo/query'
import { LoanGuaranteesClient } from '@/components/loans/LoanGuaranteesClient'

interface PageProps {
  params: Promise<{ users: string }>
}

/** Loan guarantee requests addressed to the member (accept / decline / withdraw). */
export default async function GuaranteesPage({ params }: PageProps) {
  const session = await auth()
  if (!session) redirect('/login')

  const profileId = (await params).users
  if (session.user.id !== profileId) {
    return (
      <div className='flex flex-col items-center justify-center min-h-[50vh] gap-3'>
        <ShieldAlert className='w-12 h-12 text-error' />
        <h3 className='font-bold text-lg text-primary'>Access Denied</h3>
        <p className='text-muted-foreground text-sm max-w-sm text-center'>
          You can only see guarantee requests addressed to you.
        </p>
      </div>
    )
  }

  const [loanRes, eajoRes] = await Promise.all([
    getMyLoanGuaranteeRequests(profileId),
    getMyEAjoGuaranteeRequests(profileId),
  ])

  if (!loanRes.success) {
    return (
      <div className='p-6 text-center text-muted-foreground font-semibold'>
        {loanRes.error ?? 'Unable to load guarantee requests.'}
      </div>
    )
  }

  const eajoPendingCount = eajoRes.success
    ? eajoRes.data.filter((r) => r.state === 'PENDING').length
    : 0

  return (
    <LoanGuaranteesClient
      rows={loanRes.data}
      canAct={loanRes.viewerIsGuarantor}
      eajoPendingCount={eajoPendingCount}
      eajoHref={`/dashboard/${profileId}/eajo`}
    />
  )
}
