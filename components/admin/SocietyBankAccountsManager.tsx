'use client'

import React, { useState, useEffect } from 'react'
import {
  Landmark,
  Plus,
  CheckCircle2,
  Trash2,
  Loader2,
  Copy,
  Check,
  AlertCircle,
  ShieldCheck,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { BankSelectCombobox } from '@/components/banking/BankSelectCombobox'
import { toast } from 'sonner'
import {
  createSocietyBankAccountAction,
  deleteSocietyBankAccountAction,
  getBankListAction,
  getSocietyBankAccountsAction,
  resolveAccountNameAction,
  setActiveSocietyBankAccountAction,
} from '@/models/members/actions'
import { Bank } from '@/lib/banking/provider'

interface SocietyAccount {
  id: string
  bankCode: string | null
  bankName: string
  accountNumber: string
  accountName: string
  isActive: boolean
  createdAt: Date
}

export const SocietyBankAccountsManager = () => {
  const [accounts, setAccounts] = useState<SocietyAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [banks, setBanks] = useState<Bank[]>([])
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Form State
  const [selectedBankCode, setSelectedBankCode] = useState('')
  const [selectedBankName, setSelectedBankName] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [accountName, setAccountName] = useState('')
  const [isActiveNew, setIsActiveNew] = useState(true)
  const [isResolving, setIsResolving] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const loadData = async () => {
    setLoading(true)
    const [accRes, bankRes] = await Promise.all([
      getSocietyBankAccountsAction(),
      getBankListAction(),
    ])

    if (accRes.success && accRes.data) {
      setAccounts(accRes.data as SocietyAccount[])
    } else {
      toast.error('Failed to load society bank accounts.')
    }

    if (bankRes.success && bankRes.data) {
      setBanks(bankRes.data)
    }

    setLoading(false)
  }

  useEffect(() => {
    loadData()
  }, [])

  // Auto-resolve account name when bank code and 10 digits are provided
  useEffect(() => {
    const resolve = async () => {
      if (selectedBankCode && accountNumber.trim().length === 10) {
        setIsResolving(true)
        setAccountName('')
        const res = await resolveAccountNameAction(selectedBankCode, accountNumber.trim())
        setIsResolving(false)

        if (res.success && res.accountName) {
          setAccountName(res.accountName)
          toast.success(`Account resolved: ${res.accountName}`)
        } else {
          toast.error(res.error || 'Could not resolve account name. Check details.')
        }
      }
    }

    resolve()
  }, [selectedBankCode, accountNumber])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedBankCode || accountNumber.length !== 10 || !accountName) {
      toast.error('Please complete bank selection and account verification.')
      return
    }

    const selectedBank = banks.find((b) => b.code === selectedBankCode)
    const bankName = selectedBank?.name || selectedBankName || 'Bank'

    setIsSubmitting(true)
    const result = await createSocietyBankAccountAction({
      bankCode: selectedBankCode,
      bankName,
      accountNumber: accountNumber.trim(),
      accountName: accountName.trim(),
      isActive: isActiveNew,
    })
    setIsSubmitting(false)

    if (result.success) {
      toast.success('Society bank account created successfully.')
      setIsAddOpen(false)
      setSelectedBankCode('')
      setSelectedBankName('')
      setAccountNumber('')
      setAccountName('')
      loadData()
    } else {
      toast.error(result.error || 'Failed to create society bank account.')
    }
  }

  const handleSetActive = async (id: string) => {
    const res = await setActiveSocietyBankAccountAction(id)
    if (res.success) {
      toast.success('Active receiving account updated.')
      loadData()
    } else {
      toast.error(res.error || 'Failed to update active account.')
    }
  }

  const handleDelete = async (id: string) => {
    const res = await deleteSocietyBankAccountAction(id)
    if (res.success) {
      toast.success('Society bank account deleted.')
      loadData()
    } else {
      toast.error(res.error || 'Failed to delete account.')
    }
  }

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
      toast.success('Account number copied.')
    } catch {
      toast.error('Failed to copy account number.')
    }
  }

  return (
    <Card className='border border-outline-variant/30 shadow-sm rounded-xl'>
      <CardHeader className='flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4'>
        <div>
          <CardTitle className='text-base sm:text-lg flex items-center gap-2'>
            <Landmark className='w-5 h-5 text-primary' />
            Cooperative Receiving Accounts
          </CardTitle>
          <CardDescription className='text-xs sm:text-sm mt-1'>
            Manage verified bank accounts where cooperative members submit offline deposits for savings, loans, and e-ajo.
          </CardDescription>
        </div>

        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button size='sm' className='gap-1.5 rounded-lg cursor-pointer text-xs'>
              <Plus className='w-4 h-4' /> Add Receiving Account
            </Button>
          </DialogTrigger>
          <DialogContent className='sm:max-w-md'>
            <form onSubmit={handleCreate}>
              <DialogHeader>
                <DialogTitle>Add Society Receiving Account</DialogTitle>
                <DialogDescription>
                  Select a registered commercial bank and enter the 10-digit NUBAN account number.
                </DialogDescription>
              </DialogHeader>

              <div className='flex flex-col gap-4 py-4'>
                <div className='flex flex-col gap-1.5'>
                  <Label htmlFor='bankSelect' className='text-xs font-semibold'>
                    Select Bank
                  </Label>
                  <BankSelectCombobox
                    id='bankSelect'
                    banks={banks}
                    selectedBankCode={selectedBankCode}
                    selectedBankName={selectedBankName}
                    onSelectBank={(b) => {
                      setSelectedBankCode(b.code)
                      setSelectedBankName(b.name)
                    }}
                    placeholder='Search bank name or code...'
                  />
                </div>

                <div className='flex flex-col gap-1.5'>
                  <Label htmlFor='accountNumber' className='text-xs font-semibold'>
                    Account Number (10 digits)
                  </Label>
                  <div className='relative'>
                    <Input
                      id='accountNumber'
                      value={accountNumber}
                      onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 10))}
                      placeholder='0123456789'
                      maxLength={10}
                      className='font-mono text-xs'
                    />
                    {isResolving && (
                      <Loader2 className='w-4 h-4 text-primary animate-spin absolute right-3 top-2.5' />
                    )}
                  </div>
                </div>

                <div className='flex flex-col gap-1.5'>
                  <Label htmlFor='accountName' className='text-xs font-semibold'>
                    Resolved Account Name
                  </Label>
                  <Input
                    id='accountName'
                    value={accountName}
                    readOnly
                    placeholder='Account name will resolve automatically...'
                    className='bg-surface-container-low font-semibold text-xs text-foreground uppercase'
                  />
                  {accountName && (
                    <span className='text-[11px] text-success flex items-center gap-1 font-medium'>
                      <ShieldCheck className='w-3.5 h-3.5' /> Account verified via provider API
                    </span>
                  )}
                </div>

                <div className='flex items-center gap-2 mt-1'>
                  <input
                    type='checkbox'
                    id='isActiveCheck'
                    checked={isActiveNew}
                    onChange={(e) => setIsActiveNew(e.target.checked)}
                    className='rounded border-outline cursor-pointer'
                  />
                  <Label htmlFor='isActiveCheck' className='text-xs font-normal cursor-pointer'>
                    Set as active receiving account (shown on member dashboard)
                  </Label>
                </div>
              </div>

              <DialogFooter className='gap-2 sm:gap-0'>
                <Button
                  type='button'
                  variant='ghost'
                  onClick={() => setIsAddOpen(false)}
                  disabled={isSubmitting}
                  className='text-xs'
                >
                  Cancel
                </Button>
                <Button
                  type='submit'
                  disabled={isSubmitting || !accountName || accountNumber.length !== 10}
                  className='text-xs'
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className='w-3.5 h-3.5 animate-spin mr-1' /> Saving...
                    </>
                  ) : (
                    'Save Account'
                  )}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className='py-8 flex justify-center text-muted-foreground'>
            <Loader2 className='w-6 h-6 animate-spin text-primary' />
          </div>
        ) : accounts.length === 0 ? (
          <div className='py-8 text-center text-xs text-muted-foreground border border-dashed border-outline-variant/50 rounded-xl'>
            No society bank accounts configured yet. Click &quot;Add Receiving Account&quot; to configure one.
          </div>
        ) : (
          <div className='grid gap-3 sm:grid-cols-2'>
            {accounts.map((acc) => (
              <div
                key={acc.id}
                className={`p-4 rounded-xl border flex flex-col justify-between gap-3 transition-colors ${
                  acc.isActive
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-outline-variant/30 bg-surface-container-low'
                }`}
              >
                <div>
                  <div className='flex items-center justify-between gap-2 flex-wrap mb-2'>
                    <span className='font-bold text-sm text-foreground'>{acc.bankName}</span>
                    {acc.isActive ? (
                      <Badge className='bg-primary text-on-primary text-[10px] px-2 py-0.5 rounded-full'>
                        Active Receiving Account
                      </Badge>
                    ) : (
                      <Badge variant='outline' className='text-[10px] text-muted-foreground px-2 py-0.5 rounded-full'>
                        Inactive
                      </Badge>
                    )}
                  </div>

                  <div className='flex items-center justify-between bg-background/60 p-2.5 rounded-lg border border-outline-variant/20'>
                    <span className='font-mono font-bold text-base tracking-wider text-primary'>
                      {acc.accountNumber}
                    </span>
                    <button
                      type='button'
                      onClick={() => copyToClipboard(acc.accountNumber, acc.id)}
                      className='text-muted-foreground hover:text-foreground text-xs flex items-center gap-1 cursor-pointer'
                    >
                      {copiedId === acc.id ? (
                        <>
                          <Check className='w-3.5 h-3.5 text-success' /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className='w-3.5 h-3.5' /> Copy
                        </>
                      )}
                    </button>
                  </div>

                  <p className='text-xs font-semibold text-muted-foreground mt-2 uppercase tracking-wide truncate'>
                    {acc.accountName}
                  </p>
                </div>

                <div className='flex items-center justify-between pt-2 border-t border-outline-variant/20'>
                  {!acc.isActive ? (
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      onClick={() => handleSetActive(acc.id)}
                      className='h-7 text-xs px-2.5 cursor-pointer text-primary hover:bg-primary/10'
                    >
                      Set as Active
                    </Button>
                  ) : (
                    <span className='text-[11px] text-success font-medium flex items-center gap-1'>
                      <CheckCircle2 className='w-3.5 h-3.5' /> Primary target for payments
                    </span>
                  )}

                  {!acc.isActive && (
                    <Button
                      type='button'
                      variant='ghost'
                      size='icon'
                      onClick={() => handleDelete(acc.id)}
                      className='h-7 w-7 text-muted-foreground hover:text-error hover:bg-error/10 rounded-full cursor-pointer'
                    >
                      <Trash2 className='w-3.5 h-3.5' />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
