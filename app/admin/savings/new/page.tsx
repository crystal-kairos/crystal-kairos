import { Metadata } from 'next'
import { NewSavingsProductClient } from '@/components/admin/NewSavingsProductClient'
import { auth } from '@/auth'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'Create Savings Product | Crystal Kairos Admin',
}

export default async function NewSavingsPage() {
  const session = await auth()
  if (!session) {
    redirect('/login')
  }
  if (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER') {
    redirect('/unauthorized')
  }

  return (
    <div className='p-6 w-full'>
      <NewSavingsProductClient />
    </div>
  )
}
