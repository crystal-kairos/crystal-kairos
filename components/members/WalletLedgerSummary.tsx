'use client'

import { Card, CardContent } from '../ui/card'
import { Wallet, Landmark, Handshake, Banknote, HelpCircle } from 'lucide-react'

interface LedgerBalances {
  generalWalletBalance: number
  availableWallet?: number
  heldBalance?: number
  subLedgers: {
    ajo: {
      totalContributed: number
    }
    savings: {
      totalDeposited: number
      totalWithdrawn: number
      currentSavingsBalance: number
    }
    loans: {
      totalBorrowed: number
      totalRepaid: number
      outstandingDebt: number
    }
  }
}

interface WalletLedgerSummaryProps {
  balances: LedgerBalances
}

export const WalletLedgerSummary = ({ balances }: WalletLedgerSummaryProps) => {
  const format = (val: number) => {
    // Format naira currency
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 2,
    }).format(val)
  }

  return (
    <div className='grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-4 w-full'>
      {/* 1. Main General Wallet Balance Card */}
      <Card
        className='border-0 rounded-md text-on-primary overflow-hidden relative shadow-none'
        style={{
          background: `
            radial-gradient(ellipse at top left, var(--color-primary-container) 0%, transparent 60%),
            radial-gradient(ellipse at bottom right, var(--color-secondary) 0%, transparent 65%),
            #1e293b
          `,
        }}
      >
        <CardContent className='p-6 h-full flex flex-col justify-between min-h-[170px]'>
          <div className='flex justify-between items-start'>
            <span className='text-[10px] font-bold uppercase tracking-wider text-white/70'>
              Cooperative Wallet
            </span>
            <div className='w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white'>
              <Wallet className='w-4 h-4' />
            </div>
          </div>
          <div className='flex flex-col gap-1 mt-4'>
            <span className='text-[10px] text-white/60 font-semibold uppercase tracking-wider'>
              Available Balance
            </span>
            <h2 className='text-3xl font-extrabold font-mono tracking-tight text-white leading-none'>
              {format(balances.availableWallet ?? balances.generalWalletBalance)}
            </h2>
            {balances.heldBalance !== undefined && balances.heldBalance > 0 && (
              <span className='text-[10px] text-amber-300 font-medium mt-1'>
                (Held on withdrawal: {format(balances.heldBalance)} | Total: {format(balances.generalWalletBalance)})
              </span>
            )}
          </div>
          <p className='text-[10px] text-white/50 mt-2'>
            Operational double-entry ledger balance for general deposits & withdrawals
          </p>
        </CardContent>
      </Card>

      {/* 2. Sub-Ledger Cards Grid */}
      <div className='grid grid-cols-1 sm:grid-cols-3 gap-4'>
        {/* A. Ajo Savings Sub-ledger */}
        <Card className='border-0 bg-surface-container rounded-md shadow-none flex flex-col justify-between p-5 min-h-[140px]'>
          <div className='flex justify-between items-start w-full'>
            <span className='text-[9px] font-bold uppercase tracking-wider text-muted-foreground'>
              Ajo Contributions
            </span>
            <div className='w-7 h-7 rounded-sm bg-secondary/15 flex items-center justify-center text-secondary'>
              <Handshake className='w-3.5 h-3.5' />
            </div>
          </div>
          <div className='flex flex-col gap-0.5 mt-auto'>
            <span className='text-[9px] text-muted-foreground font-semibold uppercase tracking-wider'>
              Total Contributed
            </span>
            <h3 className='text-lg font-bold font-mono tracking-tight text-primary'>
              {format(balances.subLedgers.ajo.totalContributed)}
            </h3>
          </div>
        </Card>

        {/* B. Fixed & Target Savings Sub-ledger */}
        <Card className='border-0 bg-surface-container rounded-md shadow-none flex flex-col justify-between p-5 min-h-[140px]'>
          <div className='flex justify-between items-start w-full'>
            <span className='text-[9px] font-bold uppercase tracking-wider text-muted-foreground'>
              Active Savings
            </span>
            <div className='w-7 h-7 rounded-sm bg-secondary/15 flex items-center justify-center text-secondary'>
              <Landmark className='w-3.5 h-3.5' />
            </div>
          </div>
          <div className='flex flex-col gap-0.5 mt-auto'>
            <span className='text-[9px] text-muted-foreground font-semibold uppercase tracking-wider'>
              Total Locked
            </span>
            <h3 className='text-lg font-bold font-mono tracking-tight text-primary'>
              {format(balances.subLedgers.savings.currentSavingsBalance)}
            </h3>
          </div>
        </Card>

        {/* C. Loan Sub-ledger */}
        <Card className='border-0 bg-surface-container rounded-md shadow-none flex flex-col justify-between p-5 min-h-[140px]'>
          <div className='flex justify-between items-start w-full'>
            <span className='text-[9px] font-bold uppercase tracking-wider text-muted-foreground'>
              Outstanding Debt
            </span>
            <div className='w-7 h-7 rounded-sm bg-error/10 flex items-center justify-center text-error'>
              <Banknote className='w-3.5 h-3.5' />
            </div>
          </div>
          <div className='flex flex-col gap-0.5 mt-auto'>
            <span className='text-[9px] text-error font-semibold uppercase tracking-wider'>
              Remaining Balance
            </span>
            <h3 className='text-lg font-bold font-mono tracking-tight text-error'>
              {format(balances.subLedgers.loans.outstandingDebt)}
            </h3>
          </div>
        </Card>
      </div>
    </div>
  )
}
