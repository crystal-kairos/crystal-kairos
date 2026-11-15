import { getLoanByIdQuery } from '@/models/admin/query'
import { AdminLoanDetailsClient } from '@/components/admin/AdminLoanDetailsClient'
import { notFound } from 'next/navigation'

export const metadata = {
  title: 'Loan Details | Admin Dashboard',
}

interface PageProps {
  params: Promise<{
    loanId: string
  }>
}

export default async function AdminLoanDetailsPage({ params }: PageProps) {
  const { loanId } = await params
  const result = await getLoanByIdQuery(loanId)

  if (!result.success || !result.data) {
    if (result.error === 'Loan not found.') return notFound()
    return (
      <div className="p-6 text-red-500">
        Failed to load loan details: {result.error}
      </div>
    )
  }

  return <AdminLoanDetailsClient loan={result.data} />
}
