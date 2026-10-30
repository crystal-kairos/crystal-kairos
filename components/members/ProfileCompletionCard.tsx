import Link from 'next/link'
import {
  CheckCircle2,
  Clock,
  AlertCircle,
  ArrowRight,
  UserCheck,
  ShieldAlert,
} from 'lucide-react'
import { ProfileCompletionReport } from '@/lib/services/profile.service'
import { Button } from '@/components/ui/button'

interface ProfileCompletionCardProps {
  report: ProfileCompletionReport
  userId: string
}

export const ProfileCompletionCard = ({
  report,
  userId,
}: ProfileCompletionCardProps) => {
  const {
    membershipStatus,
    completionPercentage,
    missingSections,
    isApproved,
    isComplete,
  } = report

  // If approved and 100% complete, don't overwhelm the dashboard
  if (isApproved && isComplete) {
    return null
  }

  return (
    <div className='mb-6 bg-surface-container border border-outline-variant/30 rounded-2xl p-5 shadow-sm'>
      {/* Membership Review Status Notice */}
      {!isApproved && (
        <div className='flex items-start gap-3 p-3.5 mb-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-900 dark:text-amber-200'>
          <Clock className='w-5 h-5 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0' />
          <div className='text-xs sm:text-sm'>
            <span className='font-bold block'>
              Membership Review Pending
            </span>
            Your membership application is currently undergoing administrative review. You can complete your profile sections below in the meantime.
          </div>
        </div>
      )}

      {/* Progress & Missing Requirements */}
      <div className='flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-3'>
        <div>
          <h4 className='font-heading font-semibold text-base text-primary flex items-center gap-2'>
            <UserCheck className='w-4 h-4 text-secondary' />
            Profile Completion Status
          </h4>
          <p className='text-xs text-muted-foreground mt-0.5'>
            Complete all profile sections to unlock savings, loans, and digital ajo.
          </p>
        </div>
        <div className='flex items-center gap-2 self-end sm:self-auto'>
          <span className='font-bold text-sm text-primary'>
            {completionPercentage}%
          </span>
          <Button asChild size='sm' variant='outline' className='h-8 text-xs font-semibold'>
            <Link href={`/dashboard/${userId}/profile`}>
              Complete Profile <ArrowRight className='w-3 h-3 ml-1' />
            </Link>
          </Button>
        </div>
      </div>

      {/* Progress Bar */}
      <div className='w-full bg-outline-variant/20 rounded-full h-2 mb-4 overflow-hidden'>
        <div
          className='bg-secondary h-2 rounded-full transition-all duration-500'
          style={{ width: `${completionPercentage}%` }}
        />
      </div>

      {/* Checklist items */}
      <div className='grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs'>
        <div className='flex items-center gap-1.5 p-2 rounded-lg bg-surface-container-low border border-outline-variant/10'>
          {report.sections.personalInfo.isComplete ? (
            <CheckCircle2 className='w-3.5 h-3.5 text-emerald-600' />
          ) : (
            <AlertCircle className='w-3.5 h-3.5 text-amber-500' />
          )}
          <span className={report.sections.personalInfo.isComplete ? 'text-muted-foreground' : 'font-semibold text-primary'}>
            Personal Details
          </span>
        </div>

        <div className='flex items-center gap-1.5 p-2 rounded-lg bg-surface-container-low border border-outline-variant/10'>
          {report.sections.bankAccount.isComplete ? (
            <CheckCircle2 className='w-3.5 h-3.5 text-emerald-600' />
          ) : (
            <AlertCircle className='w-3.5 h-3.5 text-amber-500' />
          )}
          <span className={report.sections.bankAccount.isComplete ? 'text-muted-foreground' : 'font-semibold text-primary'}>
            Bank Account
          </span>
        </div>

        <div className='flex items-center gap-1.5 p-2 rounded-lg bg-surface-container-low border border-outline-variant/10'>
          {report.sections.nextOfKin.isComplete ? (
            <CheckCircle2 className='w-3.5 h-3.5 text-emerald-600' />
          ) : (
            <AlertCircle className='w-3.5 h-3.5 text-amber-500' />
          )}
          <span className={report.sections.nextOfKin.isComplete ? 'text-muted-foreground' : 'font-semibold text-primary'}>
            Next of Kin
          </span>
        </div>

        <div className='flex items-center gap-1.5 p-2 rounded-lg bg-surface-container-low border border-outline-variant/10'>
          {report.sections.passportPhoto.isComplete ? (
            <CheckCircle2 className='w-3.5 h-3.5 text-emerald-600' />
          ) : (
            <AlertCircle className='w-3.5 h-3.5 text-amber-500' />
          )}
          <span className={report.sections.passportPhoto.isComplete ? 'text-muted-foreground' : 'font-semibold text-primary'}>
            Passport Photo
          </span>
        </div>
      </div>
    </div>
  )
}
