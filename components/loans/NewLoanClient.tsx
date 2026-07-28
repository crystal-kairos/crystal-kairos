'use client'

import React, { useState, useTransition, useEffect } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Info,
  ShieldCheck,
  AlertCircle,
  HelpCircle,
  Percent,
  Search,
  CheckCircle,
} from 'lucide-react'
import Link from 'next/link'
import { Card, CardContent } from '../ui/card'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'
import {
  applyForLoanAction,
  searchMemberByEmailAction,
} from '@/models/loans/actions'
import { useRouter } from 'next/navigation'

interface BankAccount {
  id: string
  bankName: string
  accountNumber: string
  accountName: string
  isPrimary: boolean
}

interface NewLoanClientProps {
  userId: string
  bankAccounts: BankAccount[]
  totalSavings: number
}

export const NewLoanClient = ({
  userId,
  bankAccounts,
  totalSavings,
}: NewLoanClientProps) => {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [isSearching, startSearchTransition] = useTransition()

  // Form states
  const [requestedAmount, setRequestedAmount] = useState<number>(50000)
  const [duration, setDuration] = useState<number>(2)
  const [purpose, setPurpose] = useState<string>('')

  // Guarantor / Collateral
  const [guarantorEmail, setGuarantorEmail] = useState('')
  const [verifiedGuarantor, setVerifiedGuarantor] = useState<{
    id: string
    name: string
  } | null>(null)
  const [guarantorError, setGuarantorError] = useState<string | null>(null)
  const [collateralDetails, setCollateralDetails] = useState('')

  // Bank routing
  const [selectedBankAccountId, setSelectedBankAccountId] = useState(
    bankAccounts.find((a) => a.isPrimary)?.id || bankAccounts[0]?.id || '',
  )
  const [customBankName, setCustomBankName] = useState('')
  const [customAccountNumber, setCustomAccountNumber] = useState('')
  const [customAccountName, setCustomAccountName] = useState('')
  const [useCustomBank, setUseCustomBank] = useState(bankAccounts.length === 0)

  // General Error
  const [error, setError] = useState<string | null>(null)

  const maxBorrowLimit = totalSavings * 2

  // Dynamic Tier calculations matching backend
  let tierName = 'Tier 3: Mid-Tier Member'
  let interestRate = 5
  let applicationFee = 2000

  if (totalSavings > 0) {
    if (requestedAmount < 20000 && duration === 1) {
      tierName = 'Tier 2: Interest-Free'
      interestRate = 0
      applicationFee = 500
    } else if (
      requestedAmount >= 20000 &&
      requestedAmount <= 100000 &&
      duration <= 2
    ) {
      tierName = 'Tier 3: Mid-Tier Member'
      interestRate = 5
      applicationFee = 2000
    } else if (requestedAmount > 100000) {
      tierName = 'Tier 4: Capital Member'
      interestRate = 3.5
      applicationFee = 2000
    }
  } else {
    tierName = 'Tier 1: Member without Savings'
    interestRate = 5
    applicationFee = 0
  }

  if (collateralDetails && totalSavings === 0) {
    tierName = 'Tier 5: Non-member Flex'
    interestRate = 10
    applicationFee = 2000
  }

  // Monthly installment calculation (simple interest)
  const monthlyPrincipal = requestedAmount / duration
  const monthlyInterest = (requestedAmount * interestRate) / 100
  const monthlyInstallment = monthlyPrincipal + monthlyInterest
  const totalRepayment = requestedAmount + monthlyInterest * duration

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

  const handleVerifyGuarantor = () => {
    if (!guarantorEmail.trim()) {
      setGuarantorError('Please enter a guarantor email address.')
      return
    }

    setGuarantorError(null)
    setVerifiedGuarantor(null)

    startSearchTransition(async () => {
      const res = await searchMemberByEmailAction(guarantorEmail)
      if (res.success && res.member) {
        setVerifiedGuarantor(res.member)
      } else {
        setGuarantorError(res.error || 'Failed to verify guarantor.')
      }
    })
  }

  const handleApply = () => {
    if (requestedAmount <= 0) {
      setError('Please specify a valid requested amount.')
      return
    }
    if (!purpose.trim()) {
      setError('Please describe the purpose of the loan.')
      return
    }
    if (totalSavings > 0 && requestedAmount > maxBorrowLimit) {
      setError(
        `Requested amount exceeds your borrowing limit of ${formatCurrency(maxBorrowLimit)} (2x savings).`,
      )
      return
    }
    if (!verifiedGuarantor && totalSavings > 0) {
      setError('Guarantor verification is required for member loans.')
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
        setError('Please complete all custom bank account fields.')
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
        setError('Selected payout bank account details not found.')
        return
      }
      bankName = selectedAcct.bankName
      accountNumber = selectedAcct.accountNumber
      accountName = selectedAcct.accountName
    }

    setError(null)

    startTransition(async () => {
      const res = await applyForLoanAction(userId, {
        requestedAmount,
        duration,
        purpose,
        guarantorEmail: verifiedGuarantor ? guarantorEmail : undefined,
        collateralDetails: collateralDetails || undefined,
      })

      if (res.success) {
        router.push(`/dashboard/${userId}/loans`)
      } else {
        setError(res.error || 'Failed to submit loan application.')
      }
    })
  }

  return (
    <div className='flex flex-col gap-6 w-full max-w-5xl mx-auto py-6'>
      {/* Back button */}
      <div className='flex items-center gap-1.5 text-muted-foreground hover:text-primary cursor-pointer transition-colors w-fit text-xs font-semibold'>
        <ArrowLeft className='w-4 h-4' />
        <Link href={`/dashboard/${userId}/loans`}>Back to Borrowing Hub</Link>
      </div>

      <header>
        <h2 className='text-2xl font-bold font-heading text-primary leading-tight'>
          Apply for Loan
        </h2>
        <p className='text-muted-foreground text-sm mt-1'>
          Configure requested capital, verify cooperative guarantors, and check
          repayment options.
        </p>
      </header>

      <div className='flex flex-col lg:flex-row gap-6 items-start'>
        {/* Left Column: Form Configuration */}
        <div className='flex-1 w-full flex flex-col gap-6'>
          {/* Step 1: Loan configurations */}
          <div className='bg-surface-container-lowest rounded-xl p-6 border border-outline-variant/10 flex flex-col gap-4'>
            <h3 className='text-sm font-bold text-primary'>Loan Details</h3>

            <div className='grid grid-cols-1 sm:grid-cols-2 gap-4'>
              <div className='flex flex-col gap-1.5'>
                <Label
                  htmlFor='reqAmt'
                  className='text-xs font-semibold text-muted-foreground'
                >
                  Requested Loan Capital (₦)
                </Label>
                <div className='relative'>
                  <span className='absolute left-3 top-2.5 text-muted-foreground font-mono text-sm'>
                    ₦
                  </span>
                  <Input
                    id='reqAmt'
                    type='number'
                    value={requestedAmount}
                    onChange={(e) => setRequestedAmount(Number(e.target.value))}
                    className='pl-7 rounded-sm h-10 border-outline-variant/35 font-mono text-sm'
                  />
                </div>
                {totalSavings > 0 && (
                  <p className='text-[10px] text-muted-foreground leading-normal'>
                    * Limit: {formatCurrency(maxBorrowLimit)} (2x your savings
                    of {formatCurrency(totalSavings)})
                  </p>
                )}
              </div>

              <div className='flex flex-col gap-1.5'>
                <Label
                  htmlFor='duration'
                  className='text-xs font-semibold text-muted-foreground'
                >
                  Repayment Duration Limit
                </Label>
                <select
                  id='duration'
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  className='w-full bg-surface border border-outline-variant/35 rounded-sm p-2 text-sm h-10 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary'
                >
                  <option value={1}>1 Month Term</option>
                  <option value={2}>2 Months Term</option>
                  <option value={3}>3 Months Term</option>
                  <option value={4}>4 Months Term</option>
                  <option value={5}>5 Months Term</option>
                  <option value={6}>6 Months (Max) Term</option>
                </select>
              </div>

              <div className='flex flex-col gap-1.5 sm:col-span-2'>
                <Label
                  htmlFor='purpose'
                  className='text-xs font-semibold text-muted-foreground'
                >
                  Purpose of Loan
                </Label>
                <Textarea
                  id='purpose'
                  placeholder='State how the loan capital will be deployed...'
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  rows={2}
                  className='rounded-sm border-outline-variant/35 text-xs'
                />
              </div>
            </div>
          </div>

          {/* Step 2: Nominate Guarantor / Collateral */}
          <div className='bg-surface-container-lowest rounded-xl p-6 border border-outline-variant/10 flex flex-col gap-4'>
            <h3 className='text-sm font-bold text-primary'>
              Guarantor & Collateral Nomination
            </h3>

            {totalSavings > 0 ? (
              // Members with savings need a cooperative guarantor
              <div className='flex flex-col gap-3'>
                <p className='text-[11px] text-muted-foreground leading-relaxed -mt-2'>
                  Please nominate an active member of Crystal Kairos to
                  guarantee your loan.
                </p>
                <div className='flex gap-2'>
                  <div className='flex-1'>
                    <Input
                      placeholder='Guarantor cooperative email address'
                      type='email'
                      value={guarantorEmail}
                      onChange={(e) => setGuarantorEmail(e.target.value)}
                      className='rounded-sm h-10 border-outline-variant/35 text-xs'
                    />
                  </div>
                  <Button
                    type='button'
                    onClick={handleVerifyGuarantor}
                    disabled={isSearching || !guarantorEmail.trim()}
                    className='cursor-pointer bg-primary text-on-primary hover:bg-primary/95 text-xs font-semibold h-10 px-4 flex items-center gap-1.5 rounded-sm'
                  >
                    <Search className='w-4 h-4' />
                    <span>{isSearching ? 'Verifying...' : 'Verify'}</span>
                  </Button>
                </div>

                {verifiedGuarantor && (
                  <div className='bg-success-green/10 border border-success-green/20 rounded-md p-3 flex items-center gap-2 text-xs text-success-green animate-in fade-in duration-200'>
                    <CheckCircle className='w-4 h-4' />
                    <span>
                      Verified Guarantor member found:{' '}
                      <strong className='text-primary'>
                        {verifiedGuarantor.name}
                      </strong>
                    </span>
                  </div>
                )}

                {guarantorError && (
                  <div className='bg-error-container/10 border border-error-container/30 rounded-md p-3 flex items-center gap-2 text-xs text-error animate-in fade-in duration-200'>
                    <AlertCircle className='w-4 h-4' />
                    <span>{guarantorError}</span>
                  </div>
                )}
              </div>
            ) : (
              // Members without savings need collateral details
              <div className='flex flex-col gap-1.5'>
                <Label
                  htmlFor='collateral'
                  className='text-xs font-semibold text-muted-foreground'
                >
                  Collateral Details (Mandatory)
                </Label>
                <Textarea
                  id='collateral'
                  placeholder='Provide description of assets/collaterals offered to secure this loan...'
                  value={collateralDetails}
                  onChange={(e) => setCollateralDetails(e.target.value)}
                  rows={2}
                  className='rounded-sm border-outline-variant/35 text-xs'
                />
              </div>
            )}
          </div>

          {/* Step 3: Payout bank routing */}
          <div className='bg-surface-container-lowest rounded-xl p-6 border border-outline-variant/10 flex flex-col gap-4'>
            <h3 className='text-sm font-bold text-primary'>
              {' '}
              payout bank Account routing
            </h3>
            <p className='text-[11px] text-muted-foreground -mt-2 leading-relaxed font-medium'>
              Select where the approved loan disbursement will be credited.
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
              <div className='grid grid-cols-1 sm:grid-cols-3 gap-4 border-t border-outline-variant/20 pt-4 animate-in fade-in duration-200'>
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

          <Button
            onClick={handleApply}
            disabled={
              isPending ||
              requestedAmount <= 0 ||
              (totalSavings > 0 && !verifiedGuarantor)
            }
            className='cursor-pointer rounded-sm bg-primary text-on-primary hover:bg-primary/95 flex items-center justify-center gap-1.5 w-full h-11 text-sm font-semibold mt-2 shadow-sm'
          >
            {isPending
              ? 'Submitting Application...'
              : 'Submit Loan Application'}
            <ArrowRight className='w-4 h-4' />
          </Button>
        </div>

        {/* Right Column: Dynamic amortization breakdown */}
        <div className='w-full lg:w-[320px] shrink-0 flex flex-col gap-4'>
          <div className='bg-surface-container-lowest border border-outline-variant/10 rounded-xl p-5 shadow-sm'>
            <div className='flex items-center gap-2 mb-3 pb-2 border-b border-outline-variant/20'>
              <Percent className='w-4 h-4 text-primary' />
              <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
                Repayment Estimator
              </h3>
            </div>

            <div className='flex flex-col gap-3 text-xs'>
              <div className='flex justify-between border-b border-outline-variant/10 pb-2'>
                <span className='text-muted-foreground'>Condition Tier:</span>
                <span
                  className='font-bold text-primary text-[10px] text-right truncate max-w-40'
                  title={tierName}
                >
                  {tierName}
                </span>
              </div>

              <div className='flex justify-between border-b border-outline-variant/10 pb-2'>
                <span className='text-muted-foreground'>
                  Monthly Interest Rate:
                </span>
                <span className='font-bold text-success-green font-mono'>
                  {interestRate}% / month
                </span>
              </div>

              <div className='flex justify-between border-b border-outline-variant/10 pb-2'>
                <span className='text-muted-foreground'>Plan Duration:</span>
                <span className='font-semibold text-primary'>
                  {duration} Months
                </span>
              </div>

              <div className='flex justify-between border-b border-outline-variant/10 pb-2'>
                <span className='text-muted-foreground'>
                  Application Form Fee:
                </span>
                <span className='font-semibold text-primary font-mono'>
                  {formatCurrency(applicationFee)}
                </span>
              </div>

              <div className='flex justify-between border-b border-outline-variant/10 pb-2'>
                <span className='text-muted-foreground'>
                  Monthly Installment:
                </span>
                <span className='font-bold text-primary font-mono'>
                  {formatCurrency(monthlyInstallment)}
                </span>
              </div>

              <div className='flex justify-between border-b border-outline-variant/10 pb-2'>
                <span className='text-muted-foreground'>
                  Total Repayment Amount:
                </span>
                <span className='font-extrabold text-secondary font-mono'>
                  {formatCurrency(totalRepayment)}
                </span>
              </div>

              <div className='bg-surface-container rounded-lg p-3 border border-outline-variant/15 mt-2 font-mono'>
                <span className='text-[10px] text-muted-foreground uppercase tracking-wider block font-sans font-semibold'>
                  Monthly Breakdown
                </span>
                <span className='text-primary font-bold text-xs block mt-1'>
                  Principal: {formatCurrency(monthlyPrincipal)}
                </span>
                <span className='text-success-green font-bold text-xs block mt-0.5'>
                  Interest: +{formatCurrency(monthlyInterest)}
                </span>
              </div>
            </div>
          </div>

          <div className='bg-success-green/10 border border-success-green/20 rounded-xl p-4 flex items-start gap-2.5'>
            <ShieldCheck className='w-5 h-5 text-success-green shrink-0 mt-0.5' />
            <div>
              <h4 className='text-xs font-bold text-primary'>
                Grace Period Guarantee
              </h4>
              <p className='text-[10px] text-muted-foreground leading-normal mt-0.5'>
                Every repayment cycle has a 7-day grace period. Late payments
                beyond this grace period will trigger a 10% default penalty.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
export default NewLoanClient
