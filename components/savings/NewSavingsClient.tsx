'use client'

import React, { useState, useTransition, useEffect } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  PiggyBank,
  ShieldCheck,
  AlertCircle,
  LucideType,
} from 'lucide-react'
import Link from 'next/link'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import {
  SavingsType,
  SavingsFrequency,
  SavingsMaturity,
} from '@/generated/prisma/enums'
import { createSavingsPlanAction } from '@/models/savings/actions'
import { getPeriodsCount } from '@/lib/savings'
import { useRouter } from 'next/navigation'
import { SavingsProduct } from '@/generated/prisma/client'

interface BankAccount {
  id: string
  bankName: string
  accountNumber: string
  accountName: string
  isPrimary: boolean
}

interface NewSavingsClientProps {
  userId: string
  bankAccounts: BankAccount[]
  initialType?: string
  product: SavingsProduct
}

const getIcon = (name: string) => {
  const IconComponent = (LucideType as any)[name]
  return IconComponent ? (
    <IconComponent className='w-5 h-5' />
  ) : (
    <PiggyBank className='w-5 h-5' />
  )
}

export const NewSavingsClient = ({
  userId,
  bankAccounts,
  initialType = 'FIXED',
  product,
}: NewSavingsClientProps) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Form states
  const [targetAmount, setTargetAmount] = useState<number>(50000)
  const [frequency, setFrequency] = useState<SavingsFrequency>(
    initialType === 'REGULAR'
      ? SavingsFrequency.MONTHLY
      : SavingsFrequency.ONCE,
  )
  const [maturity, setMaturity] = useState<SavingsMaturity>(
    SavingsMaturity.SIX_MONTHS,
  )

  // Bank routing
  const [selectedBankAccountId, setSelectedBankAccountId] = useState(
    bankAccounts.find((a) => a.isPrimary)?.id || bankAccounts[0]?.id || '',
  )
  const [customBankName, setCustomBankName] = useState('')
  const [customAccountNumber, setCustomAccountNumber] = useState('')
  const [customAccountName, setCustomAccountName] = useState('')
  const [useCustomBank, setUseCustomBank] = useState(bankAccounts.length === 0)

  // Errors / Success
  const [error, setError] = useState<string | null>(null)

  const savingsType = product.type

  // Sync frequency with savingsType
  useEffect(() => {
    if (savingsType === SavingsType.FIXED) {
      setFrequency(SavingsFrequency.ONCE)
    } else if (
      savingsType === SavingsType.REGULAR &&
      frequency === SavingsFrequency.ONCE
    ) {
      setFrequency(SavingsFrequency.MONTHLY)
    } else if (savingsType === SavingsType.STAGGERED) {
      setFrequency(SavingsFrequency.ONCE)
    }
  }, [savingsType])

  // Calculation helpers
  const getProductInterestRate = (maturityLevel: SavingsMaturity) => {
    if (!product) return 0
    switch (maturityLevel) {
      case SavingsMaturity.ONE_MONTH:
        return Number(product.interestRate1Month || 0)
      case SavingsMaturity.THREE_MONTHS:
        return Number(product.interestRate3Months || 0)
      case SavingsMaturity.SIX_MONTHS:
        return Number(product.interestRate6Months || 0)
      case SavingsMaturity.TWELVE_MONTHS:
        return Number(product.interestRate12Months || 0)
      default:
        return 0
    }
  }

  const interestRate = getProductInterestRate(maturity)

  let totalContribution = targetAmount
  let periodsCount = 1

  if (savingsType === SavingsType.REGULAR) {
    periodsCount = Math.round(getPeriodsCount(frequency, maturity))
    totalContribution = targetAmount * periodsCount
  }

  const interestAmount = (totalContribution * interestRate) / 100
  const expectedMaturityAmount = totalContribution + interestAmount

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 0,
    }).format(val)
  }

  const handleBankSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value
    if (val === 'custom') {
      setUseCustomBank(true)
      setSelectedBankAccountId('')
    } else {
      setUseCustomBank(false)
      setSelectedBankAccountId(val)
    }
  }

  const handleCreatePlan = () => {
    if (targetAmount <= 0) {
      setError('Please specify a target amount greater than zero.')
      return
    }

    let bankName = ''
    let accountNumber = ''
    let accountName = ''

    if (useCustomBank) {
      if (
        !customBankName.trim() ||
        !customAccountNumber.trim() ||
        !customAccountName.trim()
      ) {
        setError('Please complete all custom payout bank account fields.')
        return
      }
      bankName = customBankName
      accountNumber = customAccountNumber
      accountName = customAccountName
    } else {
      const selectedAcct = bankAccounts.find(
        (a) => a.id === selectedBankAccountId,
      )
      if (!selectedAcct) {
        setError('Selected default bank account not found.')
        return
      }
      bankName = selectedAcct.bankName
      accountNumber = selectedAcct.accountNumber
      accountName = selectedAcct.accountName
    }

    setError(null)

    startTransition(async () => {
      const res = await createSavingsPlanAction(userId, {
        savingsType,
        targetAmount,
        frequency,
        maturity,
        bankName,
        accountNumber,
        accountName,
        productId: product?.id,
      })

      if (res.success) {
        router.push(`/dashboard/${userId}/savings`)
      } else {
        setError(
          res.error || 'Failed to create savings plan. Please try again.',
        )
      }
    })
  }

  return (
    <div className='flex flex-col gap-6 w-full max-w-5xl mx-auto py-6'>
      {/* Back button */}
      <div className='flex items-center gap-1.5 text-muted-foreground hover:text-primary cursor-pointer transition-colors w-fit text-xs font-semibold'>
        <ArrowLeft className='w-4 h-4' />
        <Link href={`/dashboard/${userId}/savings`}>Back to Savings Hub</Link>
      </div>

      <header>
        <h2 className='text-2xl font-bold font-heading text-primary leading-tight'>
          Create Savings Plan for{' '}
          <span className='underline'>{product.title}</span> Product
        </h2>
        <p className='text-muted-foreground text-sm mt-1'>
          Configure interest rates, terms, goals, and nominated payout accounts.
        </p>
      </header>

      <div className='flex flex-col lg:flex-row gap-6 items-start'>
        {/* Left Column: Form config */}
        <div className='flex-1 w-full flex flex-col gap-6'>
          {/* Step 1: Choose Savings Type */}
          <div className='bg-surface-container-lowest rounded-xl p-6 border border-outline-variant/10 flex flex-col gap-4'>
            <h3 className='text-sm font-bold text-primary'>
              Chosen Savings Type:
            </h3>
            <div className='border rounded-lg p-4 flex items-center gap-2 relative border-primary/50 bg-surface-container-low'>
              {getIcon(product.icon)}
              <h4 className='font-bold text-primary'>{product.type}</h4>
            </div>
          </div>

          {/* Step 2: Configure parameters */}
          <div className='bg-surface-container-lowest rounded-xl p-6 border border-outline-variant/10 flex flex-col gap-4'>
            <h3 className='text-sm font-bold text-primary'>
              Configure Plan Term Parameters
            </h3>

            <div className='grid grid-cols-1 sm:grid-cols-2 gap-4'>
              <div className='flex flex-col gap-1.5'>
                <Label
                  htmlFor='amount'
                  className='text-xs font-semibold text-muted-foreground'
                >
                  {savingsType === SavingsType.REGULAR
                    ? 'Recurring Contribution Amount'
                    : 'Initial Bulk Deposit Amount'}
                </Label>
                <div className='relative'>
                  <span className='absolute left-3 top-2.5 text-muted-foreground font-mono text-sm'>
                    ₦
                  </span>
                  <Input
                    id='amount'
                    type='number'
                    value={targetAmount}
                    onChange={(e) => setTargetAmount(Number(e.target.value))}
                    className='pl-7 rounded-sm h-10 border-outline-variant/35 font-mono text-sm'
                  />
                </div>
              </div>

              <div className='flex flex-col gap-1.5'>
                <Label
                  htmlFor='maturity'
                  className='text-xs font-semibold text-muted-foreground'
                >
                  Term Maturity Lock Duration
                </Label>
                <select
                  id='maturity'
                  value={maturity}
                  onChange={(e) =>
                    setMaturity(e.target.value as SavingsMaturity)
                  }
                  className='w-full bg-surface border border-outline-variant/35 rounded-sm p-2 text-sm h-10 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary'
                >
                  {product && Number(product.interestRate1Month) > 0 && (
                    <option value={SavingsMaturity.ONE_MONTH}>
                      1 Month Term
                    </option>
                  )}
                  {product && Number(product.interestRate3Months) > 0 && (
                    <option value={SavingsMaturity.THREE_MONTHS}>
                      3 Months Term
                    </option>
                  )}
                  {(!product || Number(product.interestRate6Months) > 0) && (
                    <option value={SavingsMaturity.SIX_MONTHS}>
                      6 Months Term
                    </option>
                  )}
                  {(!product || Number(product.interestRate12Months) > 0) && (
                    <option value={SavingsMaturity.TWELVE_MONTHS}>
                      12 Months (1 Year) Term
                    </option>
                  )}
                </select>
              </div>

              {savingsType === SavingsType.REGULAR && (
                <div className='flex flex-col gap-1.5 sm:col-span-2'>
                  <Label
                    htmlFor='frequency'
                    className='text-xs font-semibold text-muted-foreground'
                  >
                    Recurring Frequency Cadence
                  </Label>
                  <select
                    id='frequency'
                    value={frequency}
                    onChange={(e) =>
                      setFrequency(e.target.value as SavingsFrequency)
                    }
                    className='w-full bg-surface border border-outline-variant/35 rounded-sm p-2 text-sm h-10 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary'
                  >
                    <option value={SavingsFrequency.DAILY}>
                      Daily Contributions
                    </option>
                    <option value={SavingsFrequency.WEEKLY}>
                      Weekly Contributions
                    </option>
                    <option value={SavingsFrequency.MONTHLY}>
                      Monthly Contributions
                    </option>
                  </select>
                </div>
              )}
            </div>
          </div>

          {/* Step 3: Payout bank details */}
          <div className='bg-surface-container-lowest rounded-xl p-6 border border-outline-variant/10 flex flex-col gap-4'>
            <h3 className='text-sm font-bold text-primary'>
              {' '}
              payout Bank Account routing
            </h3>
            <p className='text-[11px] text-muted-foreground -mt-2 leading-relaxed'>
              Nominate where the principal plus accrued interest will be
              disbursed at maturity.
            </p>

            <div className='flex flex-col gap-1.5'>
              <Label
                htmlFor='bankSelect'
                className='text-xs font-semibold text-muted-foreground'
              >
                Select Saved Bank Account
              </Label>
              <select
                id='bankSelect'
                value={useCustomBank ? 'custom' : selectedBankAccountId}
                onChange={handleBankSelectChange}
                className='w-full bg-surface border border-outline-variant/35 rounded-sm p-2 text-sm h-10 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary'
              >
                {bankAccounts.map((acct) => (
                  <option key={acct.id} value={acct.id}>
                    {acct.bankName} - {acct.accountNumber} ({acct.accountName}){' '}
                    {acct.isPrimary ? '[Primary]' : ''}
                  </option>
                ))}
                <option value='custom'>
                  -- Use Custom Bank Routing Account --
                </option>
              </select>
            </div>

            {useCustomBank && (
              <div className='grid grid-cols-1 sm:grid-cols-3 gap-4 border-t border-outline-variant/20 pt-4 animate-in fade-in duration-250'>
                <div className='flex flex-col gap-1.5'>
                  <Label
                    htmlFor='customBank'
                    className='text-xs font-semibold text-muted-foreground'
                  >
                    Bank Name
                  </Label>
                  <Input
                    id='customBank'
                    placeholder='Access Bank, GTBank'
                    value={customBankName}
                    onChange={(e) => setCustomBankName(e.target.value)}
                    className='rounded-sm h-10 border-outline-variant/30 text-xs'
                  />
                </div>
                <div className='flex flex-col gap-1.5'>
                  <Label
                    htmlFor='customAcctNo'
                    className='text-xs font-semibold text-muted-foreground'
                  >
                    Account Number
                  </Label>
                  <Input
                    id='customAcctNo'
                    placeholder='10 Digits'
                    value={customAccountNumber}
                    onChange={(e) => setCustomAccountNumber(e.target.value)}
                    className='rounded-sm h-10 border-outline-variant/30 text-xs'
                  />
                </div>
                <div className='flex flex-col gap-1.5'>
                  <Label
                    htmlFor='customAcctName'
                    className='text-xs font-semibold text-muted-foreground'
                  >
                    Account Name
                  </Label>
                  <Input
                    id='customAcctName'
                    placeholder='Receiving Name'
                    value={customAccountName}
                    onChange={(e) => setCustomAccountName(e.target.value)}
                    className='rounded-sm h-10 border-outline-variant/30 text-xs'
                  />
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className='bg-error-container/10 border border-error-container/30 text-error p-4 rounded-lg flex items-start gap-2 text-xs'>
              <AlertCircle className='w-4 h-4 shrink-0 mt-0.5' />
              <span>{error}</span>
            </div>
          )}

          {/* Action button */}
          <Button
            onClick={handleCreatePlan}
            disabled={isPending || targetAmount <= 0}
            className='cursor-pointer rounded-sm bg-primary text-on-primary hover:bg-primary/95 flex items-center justify-center gap-1.5 w-full h-11 text-sm font-semibold mt-2 shadow-sm'
          >
            {isPending ? 'Creating Plan...' : 'Create Savings Plan'}
            <ArrowRight className='w-4 h-4' />
          </Button>
        </div>

        {/* Right Column: Live Calculator summary */}
        <div className='w-full lg:w-[320px] shrink-0 flex flex-col gap-4'>
          <div className='bg-surface-container-lowest border border-outline-variant/10 rounded-xl p-5 shadow-sm'>
            <div className='flex items-center gap-2 mb-3 pb-2 border-b border-outline-variant/20'>
              <PiggyBank className='w-4 h-4 text-primary' />
              <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
                Live Yield Calculator
              </h3>
            </div>

            <div className='flex flex-col gap-3 text-xs'>
              <div className='flex justify-between border-b border-outline-variant/10 pb-2'>
                <span className='text-muted-foreground'>Savings Product:</span>
                <span className='font-semibold text-primary capitalize'>
                  {savingsType.toLowerCase()} savings
                </span>
              </div>

              {savingsType === SavingsType.REGULAR && (
                <>
                  <div className='flex justify-between border-b border-outline-variant/10 pb-2'>
                    <span className='text-muted-foreground'>
                      Contribution frequency:
                    </span>
                    <span className='font-semibold text-primary capitalize'>
                      {frequency.toLowerCase()}
                    </span>
                  </div>
                  <div className='flex justify-between border-b border-outline-variant/10 pb-2'>
                    <span className='text-muted-foreground'>
                      Number of periods:
                    </span>
                    <span className='font-semibold text-primary font-mono'>
                      {periodsCount} payments
                    </span>
                  </div>
                </>
              )}

              <div className='flex justify-between border-b border-outline-variant/10 pb-2'>
                <span className='text-muted-foreground'>
                  Maturity lock term:
                </span>
                <span className='font-semibold text-primary'>
                  {maturity === SavingsMaturity.SIX_MONTHS
                    ? '6 Months'
                    : '12 Months (1 Year)'}
                </span>
              </div>

              <div className='flex justify-between border-b border-outline-variant/10 pb-2'>
                <span className='text-muted-foreground'>
                  Annualized interest yield:
                </span>
                <span className='font-bold text-success-green font-mono'>
                  {interestRate}%
                </span>
              </div>

              <div className='flex justify-between border-b border-outline-variant/10 pb-2'>
                <span className='text-muted-foreground'>
                  Total principal saved:
                </span>
                <span className='font-semibold text-primary font-mono'>
                  {formatCurrency(totalContribution)}
                </span>
              </div>

              <div className='flex justify-between border-b border-outline-variant/10 pb-2'>
                <span className='text-muted-foreground'>
                  Accrued interest value:
                </span>
                <span className='font-bold text-success-green font-mono'>
                  +{formatCurrency(interestAmount)}
                </span>
              </div>

              <div className='bg-surface-container rounded-lg p-3 border border-outline-variant/15 mt-2'>
                <span className='text-[10px] text-muted-foreground uppercase tracking-wider block font-semibold'>
                  Total expected return
                </span>
                <span className='text-lg font-mono font-extrabold text-success-green block mt-1'>
                  {formatCurrency(expectedMaturityAmount)}
                </span>
              </div>
            </div>
          </div>

          <div className='bg-success-green/10 border border-success-green/20 rounded-xl p-4 flex items-start gap-2.5'>
            <ShieldCheck className='w-5 h-5 text-success-green shrink-0 mt-0.5' />
            <div>
              <h4 className='text-xs font-bold text-primary'>
                Interest Forfeiture Warning
              </h4>
              <p className='text-[10px] text-muted-foreground leading-normal mt-0.5'>
                Note that early withdrawals made before the maturity date will
                trigger a 100% forfeiture of all accrued interest.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
export default NewSavingsClient
