import { MemberDetails } from '@/types/members.interface'
import PersonalInfo from './PersonalInfo'
import BankInfo from './BankInfo'
import { MembershipTier } from '@/generated/prisma/enums'
import TierInfo from './TierInfo'
import NextOfKinInfo from './NextOfKinInfo'
import Rejection from './Rejection'

const Details = ({
  personalInfo,
  bankInfo,
  tier,
  nextOfKinInfo,
  rejectionReason,
  isRejected,
  hasPendingBankChange = false,
  hasPendingNokChange = false,
}: {
  personalInfo: MemberDetails['personalInfo']
  bankInfo: MemberDetails['bankInfo'][]
  tier: MembershipTier
  nextOfKinInfo: MemberDetails['nextOfKinInfo']
  rejectionReason: string
  isRejected: boolean
  hasPendingBankChange?: boolean
  hasPendingNokChange?: boolean
}) => {
  return (
    <div className='grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]'>
      <div className='flex flex-col gap-8'>
        <PersonalInfo data={personalInfo} />
        <BankInfo data={bankInfo} hasPendingChange={hasPendingBankChange} />
      </div>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:flex lg:flex-col'>
        <TierInfo tier={tier} />
        <NextOfKinInfo
          data={nextOfKinInfo}
          hasPendingChange={hasPendingNokChange}
        />
        {isRejected && rejectionReason.trim() && (
          <Rejection reason={rejectionReason} />
        )}
      </div>
    </div>
  )
}

export default Details
