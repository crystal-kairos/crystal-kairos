import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { getMemberById } from '@/models/members/query'
import { getSavingsProductById } from '@/models/savings/query'
import { NewSavingsClient } from '@/components/savings/NewSavingsClient'
import { ShieldAlert, AlertCircle } from 'lucide-react'

interface PageProps {
  params: Promise<{ users: string }>
  searchParams: Promise<{
    type?: string
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
  const isAdmin = session.user.role === 'ADMIN' || session.user.role === 'OWNER'

  if (!isSelf && !isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <ShieldAlert className="w-12 h-12 text-error" />
        <h3 className="font-bold text-lg text-primary">Access Denied</h3>
        <p className="text-muted-foreground text-sm max-w-sm text-center">
          You do not have permission to configure new savings plans.
        </p>
      </div>
    )
  }

  const query = await searchParams
  const initialType = query.type || 'FIXED'

  // Fetch member profile details including verified bank accounts
  const memberResult = await getMemberById(profileId)

  if (!memberResult.success || !memberResult.data) {
    return (
      <div className="p-6 text-center text-muted-foreground font-semibold">
        Member profile not found.
      </div>
    )
  }

  const member = memberResult.data
  const bankAccounts = (member.bankAccounts || []).map((acct) => ({
    id: acct.id,
    bankName: acct.bankName,
    accountNumber: acct.accountNumber,
    accountName: acct.accountName,
    isPrimary: acct.isPrimary,
  }))

  const productId = query.productId
  if (!productId) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <AlertCircle className="w-12 h-12 text-error" />
        <h3 className="font-bold text-lg text-primary">Missing Product Context</h3>
        <p className="text-muted-foreground text-sm max-w-sm text-center">
          You must select a specific savings product from the Savings Hub before configuring a plan.
        </p>
      </div>
    )
  }

  const productResult = await getSavingsProductById(productId)
  if (!productResult.success || !productResult.data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <AlertCircle className="w-12 h-12 text-error" />
        <h3 className="font-bold text-lg text-primary">Product Not Found</h3>
        <p className="text-muted-foreground text-sm max-w-sm text-center">
          The savings product you are trying to configure could not be found or is inactive.
        </p>
      </div>
    )
  }

  return (
    <NewSavingsClient
      userId={profileId}
      bankAccounts={bankAccounts}
      initialType={initialType}
      product={productResult.data as any}
    />
  )
}

export default NewSavingsPlanPage
