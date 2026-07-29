import { Metadata } from 'next'
import { AdminCreateEAjoGroupClient } from '@/components/admin/AdminCreateEAjoGroupClient'
import { auth } from '@/auth'
import { redirect } from 'next/navigation'

export const metadata: Metadata = {
  title: 'Create EAjo Group | Crystal Kairos Admin',
}

export default async function NewEAjoPage() {
  const session = await auth()
  if (!session?.user) redirect('/login')
  if (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')
    redirect('/dashboard')

  return <AdminCreateEAjoGroupClient />
}
