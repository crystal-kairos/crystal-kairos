import { Landmark, Trash2, ShieldCheck, Clock } from 'lucide-react'
import { Card, CardContent } from '../ui/card'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'

interface BankAccountCardProps {
  bankName: string
  accountNumber: string
  accountName: string
  isPrimary?: boolean
  isVerified?: boolean
  isPendingPrimary?: boolean
  onMakePrimary?: () => void
  onDelete?: () => void
}

export const BankAccountCard = ({
  bankName,
  accountNumber,
  accountName,
  isPrimary = false,
  isVerified = true,
  isPendingPrimary = false,
  onMakePrimary,
  onDelete,
}: BankAccountCardProps) => {
  return (
    <Card className='overflow-hidden border-0 bg-surface-container hover:bg-surface-container-high transition-colors duration-200 rounded-md shadow-none'>
      <CardContent className='p-5 flex items-start gap-4'>
        <div className='w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0'>
          <Landmark className='w-5 h-5' />
        </div>

        <div className='flex-1 flex flex-col gap-1 min-w-0'>
          <div className='flex items-center gap-2 flex-wrap'>
            <h4 className='font-semibold text-sm truncate'>{bankName}</h4>
            {isVerified && (
              <Badge variant='outline' className='text-[10px] text-success border-success/30 px-1.5 py-0 h-4.5 flex items-center gap-0.5 rounded-full'>
                <ShieldCheck className='w-3 h-3' /> Verified
              </Badge>
            )}
            {isPrimary && (
              <Badge className='bg-success-container/30 text-on-success border-0 px-2 py-0 h-5 text-[10px] font-semibold rounded-full select-none'>
                Primary
              </Badge>
            )}
            {isPendingPrimary && (
              <Badge variant='outline' className='text-[10px] text-amber-600 dark:text-amber-400 border-amber-500/30 px-1.5 py-0 h-4.5 flex items-center gap-1 rounded-full'>
                <Clock className='w-3 h-3' /> Primary Switch Pending
              </Badge>
            )}
          </div>

          <p className='font-mono text-base font-medium tracking-wider text-on-surface-variant'>
            {accountNumber}
          </p>

          <p className='text-xs text-muted-foreground truncate uppercase tracking-wide'>
            {accountName}
          </p>
        </div>

        <div className='flex flex-col gap-2 shrink-0'>
          {!isPrimary && !isPendingPrimary && onMakePrimary && (
            <Button
              type='button'
              variant='ghost'
              size='sm'
              onClick={onMakePrimary}
              className='text-xs text-secondary hover:text-secondary hover:bg-secondary/10 cursor-pointer h-8 px-2'
            >
              Make Default
            </Button>
          )}
          {isPendingPrimary && (
            <span className='text-[11px] text-muted-foreground italic px-2 py-1'>
              In Review
            </span>
          )}
          {onDelete && (
            <Button
              type='button'
              variant='ghost'
              size='icon'
              onClick={onDelete}
              disabled={isPrimary || isPendingPrimary}
              className='text-muted-foreground hover:text-error hover:bg-error/10 cursor-pointer w-8 h-8 rounded-full disabled:opacity-30 disabled:pointer-events-none'
            >
              <Trash2 className='w-4 h-4' />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
export default BankAccountCard
