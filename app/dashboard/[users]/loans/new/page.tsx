import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { NewLoanClient } from '@/components/loans/NewLoanClient'
import { ShieldAlert } from 'lucide-react'

interface PageProps {
  params: Promise<{ users: string }>
}

const NewLoanPage = async ({ params }: PageProps) => {
  const session = await auth()

  if (!session) {
    redirect('/login')
  }

  const profileId = (await params).users

  // Only the member applies for their own loan; staff never hold loans (D-15).
  if (session.user.id !== profileId || session.user.role !== 'USER') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3">
        <ShieldAlert className="w-12 h-12 text-error" />
        <h3 className="font-bold text-lg text-primary">Access Denied</h3>
        <p className="text-muted-foreground text-sm max-w-sm text-center">
          Only the member can submit their own loan application.
        </p>
      </div>
    )
  }

  return <NewLoanClient userId={profileId} />
}

export default NewLoanPage
