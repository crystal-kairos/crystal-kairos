import { NewSavingsProductClient } from '@/components/admin/NewSavingsProductClient'
import { redirect } from 'next/navigation'
import { auth } from '@/auth'

const NewSavingsPage = async () => {
  const session = await auth()
  if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
    redirect('/unauthorized')
  }

  return (
    <div className='p-6 w-full'>
      <NewSavingsProductClient />
    </div>
  )
}

export default NewSavingsPage
