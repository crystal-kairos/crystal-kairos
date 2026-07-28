'use client'

import {
  Calendar,
  RefreshCw,
  PlusCircle,
  PiggyBank,
  ArrowRight,
  ShieldCheck,
  ArrowLeft,
  ChevronRight,
} from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import Link from 'next/link'
import { Card } from '../ui/card'
import { Button } from '../ui/button'
import { StatusPill } from '../ui/StatusPill'

interface SavingsPlan {
  id: string
  savingsType: string
  targetAmount: number | null
  frequency: string
  maturity: string
  interestRate: number
  currentBalance: number
  totalDeposited: number
  accruedInterest: number
  status: string
  startDate: any
  maturityDate: any
}

interface SavingsProduct {
  id: string
  type: string
  title: string
  description: string
  rates: string
  badge: string
  icon: string
}

interface SavingsHubClientProps {
  userId: string
  savingsPlans: SavingsPlan[]
  availableProducts: SavingsProduct[]
}

const getIcon = (name: string) => {
  const IconComponent = (LucideIcons as any)[name]
  return IconComponent ? <IconComponent className='w-5 h-5' /> : <PiggyBank className='w-5 h-5' />
}

export const SavingsHubClient = ({
  userId,
  savingsPlans,
  availableProducts,
}: SavingsHubClientProps) => {
  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 0,
    }).format(val)
  }

  const totalBalance = savingsPlans.reduce(
    (sum, p) => sum + p.currentBalance,
    0,
  )
  const totalAccrued = savingsPlans.reduce(
    (sum, p) => sum + p.accruedInterest,
    0,
  )

  return (
    <div className='flex flex-col gap-6 w-full max-w-5xl mx-auto py-6'>
      {/* Back to dashboard */}
      <div className='flex items-center gap-1.5 text-muted-foreground hover:text-primary cursor-pointer transition-colors w-fit text-xs font-semibold'>
        <ArrowLeft className='w-4 h-4' />
        <Link href={`/dashboard/${userId}`}>Back to Dashboard</Link>
      </div>

      {/* Header section */}
      <header className='flex flex-col md:flex-row md:items-center justify-between gap-4'>
        <div>
          <h2 className='text-2xl font-bold font-heading text-primary leading-tight'>
            Savings Hub
          </h2>
          <p className='text-muted-foreground text-sm mt-1'>
            Grow your wealth with competitive interest savings packages.
          </p>
        </div>
        <Button
          asChild
          className='cursor-pointer rounded-sm bg-primary hover:bg-primary/95 text-on-primary font-semibold flex items-center justify-center gap-1.5 h-10 px-5 shadow-sm'
        >
          <Link href={`/dashboard/${userId}/savings/new`}>
            <PlusCircle className='w-4 h-4' />
            <span>Create Savings Plan</span>
          </Link>
        </Button>
      </header>

      {/* Balance stats */}
      <section className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'>
        <Card className='border-0 bg-primary text-on-primary rounded-md shadow-none relative overflow-hidden p-6 min-h-[120px] flex flex-col justify-between'>
          <div className='absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full blur-2xl pointer-events-none' />
          <span className='text-[10px] uppercase tracking-wider font-semibold opacity-85'>
            Total Saved Balance
          </span>
          <span className='text-3xl font-extrabold font-mono mt-2'>
            {formatCurrency(totalBalance)}
          </span>
          <span className='text-[10px] opacity-75 mt-2'>
            Aggregated across all active plans
          </span>
        </Card>

        <Card className='border-0 bg-surface-container rounded-md shadow-none p-6 min-h-[120px] flex flex-col justify-between'>
          <span className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold'>
            Total Accrued Interest
          </span>
          <span className='text-3xl font-extrabold text-success-green font-mono mt-2'>
            {formatCurrency(totalAccrued)}
          </span>
          <span className='text-[10px] text-muted-foreground mt-2'>
            Earned and pending payout at maturity
          </span>
        </Card>

        <Card className='border-0 bg-surface-container rounded-md shadow-none p-6 min-h-[120px] flex flex-col justify-between'>
          <span className='text-[10px] text-muted-foreground uppercase tracking-wider font-semibold'>
            Active Savings Plans
          </span>
          <span className='text-3xl font-extrabold text-primary font-mono mt-2'>
            {savingsPlans.filter((p) => p.status === 'ACTIVE').length} /{' '}
            {savingsPlans.length}
          </span>
          <span className='text-[10px] text-muted-foreground mt-2'>
            Plans currently generating interest
          </span>
        </Card>
      </section>

      {/* Plans list */}
      <section className='flex flex-col gap-3'>
        <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
          My Active Plans
        </h3>
        {savingsPlans.length === 0 ? (
          <div className='border border-dashed border-outline-variant/30 rounded-lg py-12 text-center text-xs text-muted-foreground font-medium bg-surface-container-lowest'>
            No savings plans created yet. Choose a package below to start
            saving!
          </div>
        ) : (
          <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
            {savingsPlans.map((plan) => (
              <Link
                key={plan.id}
                href={`/dashboard/${userId}/savings/${plan.id}`}
              >
                <Card className='border-0 bg-surface-container rounded-md shadow-none hover:ring-1 hover:ring-primary/20 transition-all duration-200 cursor-pointer p-5 flex flex-col justify-between min-h-[160px] group'>
                  <div className='flex justify-between items-start mb-3'>
                    <div>
                      <h4 className='font-bold text-primary text-sm flex items-center gap-1.5'>
                        <span>{plan.savingsType} Savings Plan</span>
                        <ChevronRight className='w-4 h-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all' />
                      </h4>
                      <p className='text-[10px] text-muted-foreground mt-0.5'>
                        ID: #{plan.id.substring(0, 8).toUpperCase()}
                      </p>
                    </div>
                    <StatusPill status={plan.status} />
                  </div>

                  <div className='grid grid-cols-3 gap-2 py-2 border-y border-outline-variant/20 mb-3 text-xs'>
                    <div>
                      <span className='text-[9px] text-muted-foreground uppercase tracking-wider block'>
                        Balance
                      </span>
                      <span className='font-bold text-primary font-mono'>
                        {formatCurrency(plan.currentBalance)}
                      </span>
                    </div>
                    <div>
                      <span className='text-[9px] text-muted-foreground uppercase tracking-wider block'>
                        Interest
                      </span>
                      <span className='font-bold text-success-green font-mono'>
                        {plan.interestRate}%
                      </span>
                    </div>
                    <div>
                      <span className='text-[9px] text-muted-foreground uppercase tracking-wider block'>
                        Term
                      </span>
                      <span className='font-bold text-primary capitalize'>
                        {plan.maturity.replace('_', ' ').toLowerCase()}
                      </span>
                    </div>
                  </div>

                  <div className='flex justify-between items-center text-[10px] text-muted-foreground'>
                    <span>
                      Deposited: {formatCurrency(plan.totalDeposited)}
                    </span>
                    {plan.maturityDate && (
                      <span className='flex items-center gap-1'>
                        <Calendar className='w-3.5 h-3.5' />
                        <span>
                          Matures{' '}
                          {new Date(plan.maturityDate).toLocaleDateString(
                            undefined,
                            { month: 'short', year: 'numeric' },
                          )}
                        </span>
                      </span>
                    )}
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Available Savings Products */}
      <section className='flex flex-col gap-4 mt-4'>
        <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
          Available Savings Products
        </h3>
        <div className='grid grid-cols-1 md:grid-cols-3 gap-6'>
          {availableProducts.length === 0 ? (
            <div className='col-span-full border border-dashed border-outline-variant/30 rounded-lg py-12 text-center text-xs text-muted-foreground font-medium bg-surface-container-lowest'>
              No savings packages are currently available. Check back later.
            </div>
          ) : (
            availableProducts.map((p, index) => {
              return (
                <Card
                  key={index}
                  className='bg-surface-container-lowest rounded-md shadow-none flex flex-col justify-between p-6 border border-outline-variant/15 hover:shadow-md transition-all duration-300'
                >
                  <div className='flex flex-col gap-2'>
                    <div className='flex justify-between items-center'>
                      <div className='w-9 h-9 rounded-sm bg-primary/10 text-primary flex items-center justify-center'>
                        {getIcon(p.icon)}
                      </div>
                      <span className='px-2.5 py-0.5 rounded-full bg-light-blue text-primary text-[9px] font-bold uppercase tracking-wider border border-primary/10'>
                        {p.badge}
                      </span>
                    </div>
                  <h4 className='font-bold text-primary text-base leading-snug mt-2'>
                    {p.title}
                  </h4>
                  <p className='text-muted-foreground text-xs leading-relaxed mt-1'>
                    {p.description}
                  </p>

                  <div className='flex flex-col gap-1.5 mt-4 pt-3 border-t border-outline-variant/20 text-xs'>
                    <div className='flex justify-between'>
                      <span className='text-muted-foreground'>
                        Interest rate:
                      </span>
                      <span className='font-bold text-success-green'>
                        {p.rates}
                      </span>
                    </div>
                    <div className='flex justify-between'>
                      <span className='text-muted-foreground'>
                        Term Options:
                      </span>
                      <span className='font-semibold text-primary'>
                        1, 3, 6, 12 Months
                      </span>
                    </div>
                    <div className='flex justify-between'>
                      <span className='text-muted-foreground'>
                        Loan multiplier:
                      </span>
                      <span className='font-bold text-primary font-mono'>
                        2x saved amount
                      </span>
                    </div>
                  </div>
                </div>

                <Button
                  asChild
                  className='cursor-pointer rounded-sm bg-primary hover:bg-primary/95 text-on-primary font-semibold flex items-center justify-center gap-1.5 w-full mt-6 h-10'
                >
                  <Link
                    href={`/dashboard/${userId}/savings/new?type=${p.type}&productId=${p.id}`}
                  >
                    <span>Configure Plan</span>
                    <ArrowRight className='w-4 h-4' />
                  </Link>
                </Button>
              </Card>
            )
          })
        )}
        </div>
      </section>

      <div className='bg-success-green/10 border border-success-green/20 rounded-xl p-4 flex items-start gap-2.5 mt-4'>
        <ShieldCheck className='w-5 h-5 text-success-green shrink-0 mt-0.5' />
        <div>
          <h4 className='text-xs font-bold text-primary'>
            Secure Cooperative Trust
          </h4>
          <p className='text-[10px] text-muted-foreground leading-normal mt-0.5'>
            All savings deposits are secured by physical asset backing and
            subject to administrative reconciliation checks.
          </p>
        </div>
      </div>
    </div>
  )
}
export default SavingsHubClient
