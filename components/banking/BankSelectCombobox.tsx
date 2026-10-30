'use client'

import React, { useState, useMemo } from 'react'
import { Bank } from '@/lib/banking/provider'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface BankSelectComboboxProps {
  banks: Bank[]
  selectedBankCode?: string
  selectedBankName?: string
  onSelectBank: (bank: Bank) => void
  placeholder?: string
  disabled?: boolean
  id?: string
  className?: string
}

export const BankSelectCombobox: React.FC<BankSelectComboboxProps> = ({
  banks,
  selectedBankCode,
  selectedBankName,
  onSelectBank,
  placeholder = 'Select or search bank...',
  disabled = false,
  id,
  className,
}) => {
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Find currently selected bank (matching by code and optionally name)
  const selectedBank = useMemo(() => {
    if (!selectedBankCode && !selectedBankName) return null
    if (selectedBankName) {
      const byName = banks.find(
        (b) => b.name.toLowerCase() === selectedBankName.toLowerCase(),
      )
      if (byName) return byName
    }
    if (selectedBankCode) {
      const byCode = banks.find((b) => b.code === selectedBankCode)
      if (byCode) return byCode
    }
    return null
  }, [banks, selectedBankCode, selectedBankName])

  // Filter banks client-side by name or bank code
  const filteredBanks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return banks

    return banks.filter((b) => {
      const nameMatch = (b.name || '').toLowerCase().includes(query)
      const codeMatch = (b.code || '').toLowerCase().includes(query)
      return nameMatch || codeMatch
    })
  }, [banks, searchQuery])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'w-full justify-between rounded-sm h-11 text-xs font-normal border-outline-variant/35 bg-surface-container-low hover:bg-surface-container hover:text-foreground text-left px-3',
            !selectedBank && 'text-muted-foreground',
            className,
          )}
        >
          <div className="flex items-center gap-2 truncate">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            {selectedBank ? (
              <span className="truncate font-medium text-foreground">
                {selectedBank.name}
              </span>
            ) : (
              <span className="truncate">{placeholder}</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0 ml-2">
            {selectedBank && (
              <span className="font-mono text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {selectedBank.code}
              </span>
            )}
            <ChevronDown className="w-4 h-4 text-muted-foreground opacity-60" />
          </div>
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[320px] max-w-md p-2 rounded-md shadow-xl border border-outline-variant/30 z-[70]"
      >
        <div className="relative mb-2">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Type bank name or code..."
            autoFocus
            className="h-9 pl-8 pr-8 text-xs rounded-sm bg-surface-container-low"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="max-h-60 overflow-y-auto divide-y divide-outline-variant/10 pr-1">
          {filteredBanks.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              No bank found matching &ldquo;{searchQuery}&rdquo;
            </div>
          ) : (
            filteredBanks.map((bank, index) => {
              const isSelected =
                (selectedBankCode && bank.code === selectedBankCode) ||
                (selectedBankName &&
                  bank.name.toLowerCase() === selectedBankName.toLowerCase())

              return (
                <button
                  key={`${bank.id ?? ''}-${bank.slug ?? ''}-${bank.code}-${index}`}
                  type="button"
                  onClick={() => {
                    onSelectBank(bank)
                    setOpen(false)
                    setSearchQuery('')
                  }}
                  className={cn(
                    'w-full flex items-center justify-between px-2.5 py-2 text-xs rounded-sm transition-colors text-left cursor-pointer hover:bg-surface-container',
                    isSelected && 'bg-primary/10 text-primary font-medium',
                  )}
                >
                  <div className="flex items-center gap-2 truncate pr-2">
                    {isSelected && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                    <span className="truncate">{bank.name}</span>
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground shrink-0 bg-muted px-1.5 py-0.5 rounded">
                    {bank.code}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
