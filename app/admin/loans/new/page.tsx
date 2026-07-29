import NewLoanClient from '@/components/admin/loans/NewLoanClient'
import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Record Loan | Crystal Kairos Admin',
}

export default function NewLoanPage() {
  return <NewLoanClient />
}
