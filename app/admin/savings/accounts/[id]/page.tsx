import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { getSavingsPlanById } from '@/models/savings/query'
import { AdminSavingsDetailsClient } from '@/components/admin/AdminSavingsDetailsClient'

interface PageProps {
  params: Promise<{
    id: string
  }>
}

const AdminSavingsDetailsPage = async ({ params }: PageProps) => {
  const session = await auth()
  if (!session) {
    redirect('/login')
  }
  if (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER') {
    redirect('/unauthorized')
  }

  const { id } = await params
  const res = await getSavingsPlanById(id)

  if (!res.success || !res.data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <h3 className="font-bold text-lg text-primary">Savings Plan Not Found</h3>
        <p className="text-muted-foreground text-sm max-w-sm text-center">
          The requested savings plan could not be located.
        </p>
      </div>
    )
  }

  return (
    <div className='p-6 w-full'>
      <AdminSavingsDetailsClient savingsPlan={res.data as any} />
    </div>
  )
}

export default AdminSavingsDetailsPage
