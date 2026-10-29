import { getAllSavingsProducts, getAllUserSavings } from '@/models/admin/query'
import { AdminSavingsClient } from '@/components/admin/AdminSavingsClient'
import { redirect } from 'next/navigation'
import { auth } from '@/auth'

const SavingsPage = async () => {
  const session = await auth()
  if (!session) {
    redirect('/login')
  }
  if (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER') {
    redirect('/unauthorized')
  }

  const [productsRes, userSavingsRes] = await Promise.all([
    getAllSavingsProducts(),
    getAllUserSavings()
  ])

  const products = productsRes.success && productsRes.data ? productsRes.data : []
  const userSavings = userSavingsRes.success && userSavingsRes.data ? userSavingsRes.data : []

  return (
    <div className='p-6 w-full'>
      <AdminSavingsClient products={products} userSavings={userSavings as any} />
    </div>
  )
}

export default SavingsPage
