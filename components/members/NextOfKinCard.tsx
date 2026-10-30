import { User, Phone, Home, Heart, Briefcase, Landmark, Clock } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Badge } from '../ui/badge'

interface NextOfKinCardProps {
  name: string
  phoneNumber: string
  relationship: string
  occupation: string
  address: string
  bankName?: string | null
  accountNumber?: string | null
  accountName?: string | null
  isPendingReview?: boolean
}

export const NextOfKinCard = ({
  name,
  phoneNumber,
  relationship,
  occupation,
  address,
  bankName,
  accountNumber,
  accountName,
  isPendingReview = false,
}: NextOfKinCardProps) => {
  return (
    <Card className='border-0 bg-surface-container rounded-md shadow-none overflow-hidden'>
      <CardHeader className='pb-3 border-b border-outline-variant/30 flex flex-row items-center justify-between'>
        <CardTitle className='text-sm font-semibold flex items-center gap-2'>
          <Heart className='w-4 h-4 text-secondary' />
          <span>Next of Kin details</span>
        </CardTitle>
        {isPendingReview && (
          <Badge
            variant='outline'
            className='bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30 text-[11px] font-normal flex items-center gap-1'
          >
            <Clock className='w-3 h-3' /> Update Pending Approval
          </Badge>
        )}
      </CardHeader>

      <CardContent className='p-5 flex flex-col gap-4 text-sm'>
        {/* Basic profile details */}
        <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
          <div className='flex items-start gap-2.5'>
            <User className='w-4 h-4 text-muted-foreground mt-0.5' />
            <div className='flex flex-col gap-0.5'>
              <span className='text-xs text-muted-foreground'>Full Name</span>
              <span className='font-medium'>{name}</span>
            </div>
          </div>

          <div className='flex items-start gap-2.5'>
            <Phone className='w-4 h-4 text-muted-foreground mt-0.5' />
            <div className='flex flex-col gap-0.5'>
              <span className='text-xs text-muted-foreground'>
                Phone Number
              </span>
              <span className='font-medium font-mono'>{phoneNumber}</span>
            </div>
          </div>

          <div className='flex items-start gap-2.5'>
            <Heart className='w-4 h-4 text-muted-foreground mt-0.5' />
            <div className='flex flex-col gap-0.5'>
              <span className='text-xs text-muted-foreground'>
                Relationship
              </span>
              <span className='font-medium capitalize'>
                {relationship.toLowerCase()}
              </span>
            </div>
          </div>

          <div className='flex items-start gap-2.5'>
            <Briefcase className='w-4 h-4 text-muted-foreground mt-0.5' />
            <div className='flex flex-col gap-0.5'>
              <span className='text-xs text-muted-foreground'>Occupation</span>
              <span className='font-medium'>{occupation}</span>
            </div>
          </div>
        </div>

        <div className='flex items-start gap-2.5 border-t border-outline-variant/20 pt-3'>
          <Home className='w-4 h-4 text-muted-foreground mt-0.5' />
          <div className='flex flex-col gap-0.5'>
            <span className='text-xs text-muted-foreground'>
              Residential Address
            </span>
            <span className='font-medium'>{address}</span>
          </div>
        </div>

        {/* Bank details if provided */}
        {bankName && accountNumber && (
          <div className='flex flex-col gap-2.5 border-t border-outline-variant/20 pt-3'>
            <div className='flex items-start gap-2.5'>
              <Landmark className='w-4 h-4 text-muted-foreground mt-0.5' />
              <div className='flex flex-col gap-1 w-full'>
                <span className='text-xs text-muted-foreground'>
                  Nominated Bank Payout
                </span>
                <div className='bg-surface-container-low p-3 rounded-sm flex flex-col gap-0.5'>
                  <span className='font-semibold text-xs'>{bankName}</span>
                  <span className='font-mono text-sm font-medium tracking-wide'>
                    {accountNumber}
                  </span>
                  {accountName && (
                    <span className='text-[10px] text-muted-foreground uppercase'>
                      {accountName}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
export default NextOfKinCard
