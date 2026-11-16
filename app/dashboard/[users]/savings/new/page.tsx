import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { getSocietySetting } from '@/lib/services/society-settings.service'
import { getSavingsProductById } from '@/models/savings/query'
import { NewSavingsClient } from '@/components/savings/NewSavingsClient'
import { ShieldAlert, AlertCircle } from 'lucide-react'

interface PageProps {
  params: Promise<{ users: string }>
  searchParams: Promise<{
    productId?: string
  }>
}

const NewSavingsPlanPage = async ({ params, searchParams }: PageProps) => {
  const session = await auth()

  if (!session) {
    redirect('/login')
  }

  const profileId = (await params).users
  const isSelf = session.user.id === profileId
  // Only the member subscribes for themselves; staff use the admin flow (D-15).
  if (!isSelf) {
    return (
      <div className='flex flex-col items-center justify-center min-h-[50vh] gap-3'>
        <ShieldAlert className='w-12 h-12 text-error' />
        <h3 className='font-bold text-lg text-primary'>Access Denied</h3>
        <p className='text-muted-foreground text-sm max-w-sm text-center'>
          You do not have permission to configure new savings plans.
        </p>
      </div>
    )
  }

  const query = await searchParams

  const productId = query.productId
  if (!productId) {
    return (
      <div className='flex flex-col items-center justify-center min-h-[50vh] gap-3'>
        <AlertCircle className='w-12 h-12 text-error' />
        <h3 className='font-bold text-lg text-primary'>
          Missing Product Context
        </h3>
        <p className='text-muted-foreground text-sm max-w-sm text-center'>
          You must select a specific savings product from the Savings Hub before
          configuring a plan.
        </p>
      </div>
    )
  }

  const productResult = await getSavingsProductById(productId)
  if (!productResult.success || !productResult.data) {
    return (
      <div className='flex flex-col items-center justify-center min-h-[50vh] gap-3'>
        <AlertCircle className='w-12 h-12 text-error' />
        <h3 className='font-bold text-lg text-primary'>Product Not Found</h3>
        <p className='text-muted-foreground text-sm max-w-sm text-center'>
          The savings product you are trying to configure could not be found or
          is inactive.
        </p>
      </div>
    )
  }

  if (!productResult.data.isActive) {
    return (
      <div className='p-6 text-center text-muted-foreground font-semibold'>
        This savings plan is no longer available.
      </div>
    )
  }

  const firstDepositWindowDays = await getSocietySetting('savingsFirstDepositWindowDays')

  return (
    <NewSavingsClient
      userId={profileId}
      product={productResult.data}
      firstDepositWindowDays={firstDepositWindowDays}
    />
  )
}

export default NewSavingsPlanPage
