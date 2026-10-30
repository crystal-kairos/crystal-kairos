'use client'

import { MemberDetails } from '@/types/members.interface'
import InfoCard from './InfoCard'
import { useTranslation } from 'react-i18next'
import { Network, ShieldAlert } from 'lucide-react'
import InfoItem from './InfoItem'
import Link from 'next/link'

const NextOfKinInfo = ({
  data,
  hasPendingChange = false,
}: {
  data: MemberDetails['nextOfKinInfo']
  hasPendingChange?: boolean
}) => {
  const { t } = useTranslation('admin-members')
  return (
    <InfoCard
      title={t('details.next_of_kin_info.title')}
      Icon={Network}
      variant='plain'
    >
      <div className='grid gap-5'>
        {hasPendingChange && (
          <div className='p-2.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 text-xs flex items-center justify-between'>
            <span className='flex items-center gap-1.5'>
              <ShieldAlert className='w-4 h-4 shrink-0' />
              <span>Next of Kin update pending review.</span>
            </span>
            <Link
              href='/admin/profile-changes'
              className='underline font-semibold text-[11px] hover:text-amber-800 shrink-0 ml-2'
            >
              Open Queue &rarr;
            </Link>
          </div>
        )}
        <InfoItem
          label={t('details.next_of_kin_info.name')}
          value={data.name || t('n_a')}
        />
        <InfoItem
          label={t('details.next_of_kin_info.relationship')}
          value={data.relationship || t('n_a')}
        />
        <InfoItem
          label={t('details.next_of_kin_info.phone_number')}
          value={data.phoneNumber || t('n_a')}
        />
      </div>
    </InfoCard>
  )
}

export default NextOfKinInfo
