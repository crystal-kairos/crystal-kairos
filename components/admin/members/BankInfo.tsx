'use client'

import { MemberDetails } from '@/types/members.interface'
import InfoCard from './InfoCard'
import { useTranslation } from 'react-i18next'
import { Landmark, ShieldAlert } from 'lucide-react'
import InfoItem from './InfoItem'
import Link from 'next/link'

const BankInfo = ({
  data,
  hasPendingChange = false,
}: {
  data: MemberDetails['bankInfo'][]
  hasPendingChange?: boolean
}) => {
  const { t } = useTranslation('admin-members')

  return (
    <InfoCard
      title={t('details.bank_info.title')}
      Icon={Landmark}
      variant='plain'
    >
      <div>
        {hasPendingChange && (
          <div className='mb-4 p-2.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 text-xs flex items-center justify-between'>
            <span className='flex items-center gap-1.5'>
              <ShieldAlert className='w-4 h-4 shrink-0' />
              <span>Primary bank account change requested.</span>
            </span>
            <Link
              href='/admin/profile-changes'
              className='underline font-semibold text-[11px] hover:text-amber-800 shrink-0 ml-2'
            >
              Open Review Queue &rarr;
            </Link>
          </div>
        )}
        {data.map((bank, index) => {
          return (
            <div className='grid gap-5 sm:grid-cols-2' key={index}>
              <InfoItem
                label={t('details.bank_info.bank_name')}
                value={bank.bankName}
              />
              <InfoItem
                label={t('details.bank_info.account_number')}
                value={bank.accountNumber}
              />
              <InfoItem
                label={t('details.bank_info.account_name')}
                value={bank.accountName}
              />
            </div>
          )
        })}
      </div>
    </InfoCard>
  )
}

export default BankInfo
