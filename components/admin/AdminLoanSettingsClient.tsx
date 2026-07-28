'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { ArrowLeft, Loader2, Save, Percent } from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { updateLoanSettingsAction } from '@/models/admin/loanSettingsActions'

export const AdminLoanSettingsClient = ({ initialRate }: { initialRate: number }) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [interestRate, setInterestRate] = useState(initialRate.toString())

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    const rateNum = parseFloat(interestRate)
    
    if (isNaN(rateNum) || rateNum < 0 || rateNum > 100) {
      toast.error('Please enter a valid interest rate between 0 and 100.')
      return
    }

    startTransition(async () => {
      const res = await updateLoanSettingsAction(rateNum)
      if (res.success) {
        toast.success('Loan settings updated successfully!')
        router.refresh()
      } else {
        toast.error(res.error || 'Failed to update loan settings.')
      }
    })
  }

  return (
    <div className='flex flex-col gap-6 w-full max-w-2xl mx-auto'>
      <div className='flex items-center gap-1.5 text-muted-foreground hover:text-primary cursor-pointer transition-colors w-fit text-sm font-semibold'>
        <ArrowLeft className='w-4 h-4' />
        <Link href='/admin/loans'>Back to Loan Management</Link>
      </div>

      <header className="flex flex-col gap-1">
        <h2 className='text-2xl font-bold font-heading text-primary leading-tight'>
          Loan Configuration
        </h2>
        <p className='text-muted-foreground text-sm'>
          Configure the global interest rate applied to all new loan requests.
        </p>
      </header>

      <Card className="p-6 border border-outline-variant/30 shadow-none rounded-xl bg-surface-container-lowest mt-2">
        <form onSubmit={handleSave} className="flex flex-col gap-6">
          
          <div className="flex flex-col gap-2 max-w-md">
            <Label htmlFor="interestRate" className="font-semibold text-primary">
              Global Monthly Interest Rate
            </Label>
            <div className="relative">
              <Input
                id="interestRate"
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={interestRate}
                onChange={(e) => setInterestRate(e.target.value)}
                className="pl-4 pr-10 font-mono"
                required
              />
              <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-muted-foreground">
                <Percent className="w-4 h-4" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground leading-normal mt-1">
              This interest rate will be applied per month to all new loan requests. Changes will not affect existing active loans.
            </p>
          </div>

          <div className="pt-4 border-t border-outline-variant/20 flex justify-end">
            <Button 
              type="submit" 
              className="bg-primary text-on-primary hover:bg-primary/90 h-10 px-6 font-semibold"
              disabled={isPending}
            >
              {isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save Configuration
            </Button>
          </div>
        </form>
      </Card>
    </div>
  )
}
