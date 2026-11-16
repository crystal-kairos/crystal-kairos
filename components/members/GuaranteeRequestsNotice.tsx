import Link from 'next/link'
import { ShieldCheck } from 'lucide-react'
import { getMyLoanGuaranteeRequests } from '@/models/loans/query'
import { getMyEAjoGuaranteeRequests } from '@/models/eajo/query'

/**
 * Tells a member that other members are waiting for them to accept or decline a
 * guarantee (loan or e-ajo). Renders nothing when there is nothing to answer.
 */
export async function GuaranteeRequestsNotice({ userId }: { userId: string }) {
  const [loanRes, eajoRes] = await Promise.all([
    getMyLoanGuaranteeRequests(userId),
    getMyEAjoGuaranteeRequests(userId),
  ])
  if (!loanRes.viewerIsGuarantor) return null

  const loanCount = loanRes.success
    ? loanRes.data.filter((r) => r.state === 'PENDING' || r.state === 'AWAITING_RECONSENT').length
    : 0
  const eajoCount = eajoRes.success ? eajoRes.data.filter((r) => r.state === 'PENDING').length : 0
  if (loanCount + eajoCount === 0) return null

  return (
    <div className='mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300/60 bg-amber-50/60 dark:bg-amber-500/10 p-4 text-sm'>
      <ShieldCheck className='w-5 h-5 text-amber-700 dark:text-amber-400 shrink-0' />
      <span className='flex-1 min-w-0'>
        {loanCount + eajoCount === 1
          ? 'A member has asked you to be their guarantor.'
          : `${loanCount + eajoCount} members have asked you to be their guarantor.`}
      </span>
      <span className='flex gap-3 text-xs font-semibold'>
        {loanCount > 0 && (
          <Link href={`/dashboard/${userId}/guarantees`} className='underline'>
            Answer loan request{loanCount === 1 ? '' : 's'}
          </Link>
        )}
        {eajoCount > 0 && (
          <Link href={`/dashboard/${userId}/eajo`} className='underline'>
            Answer e-ajo request{eajoCount === 1 ? '' : 's'}
          </Link>
        )}
      </span>
    </div>
  )
}
