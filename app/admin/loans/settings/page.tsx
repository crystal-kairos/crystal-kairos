import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { getLoanSettingsAction } from '@/models/admin/loanSettingsActions'
import { AdminLoanSettingsClient } from '@/components/admin/AdminLoanSettingsClient'

export const metadata = {
  title: 'Loan Settings | Crystal Kairos',
}

const AdminLoanSettingsPage = async () => {
  const session = await auth()
  if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER')) {
    redirect('/unauthorized')
  }

  const settingsRes = await getLoanSettingsAction()
  const initialRates = settingsRes.success && settingsRes.data?.rates ? settingsRes.data.rates : []
  const openDraft = settingsRes.success && settingsRes.data?.openDraft ? settingsRes.data.openDraft : null

  return (
    <div className='p-6 w-full'>
      <AdminLoanSettingsClient initialRates={initialRates} openDraft={openDraft} />
    </div>
  )
}

export default AdminLoanSettingsPage
