'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { signOut } from 'next-auth/react'
import { toast } from 'sonner'
import { ShieldCheck } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getStepUpMethodAction, submitStepUpAction } from '@/models/auth/mfaActions'

type StepUpMethod = 'MFA' | 'PASSWORD'

interface StepUpDialogProps {
  open: boolean
  onDone: (confirmed: boolean) => void
}

/**
 * Asks the signed-in user to confirm it is them (P1-07 step-up): an MFA code when MFA
 * is enabled, otherwise their password. Valid for 10 minutes on this session.
 */
export function StepUpDialog({ open, onDone }: StepUpDialogProps) {
  const [method, setMethod] = useState<StepUpMethod | null>(null)
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    getStepUpMethodAction().then((res) => {
      if (cancelled) return
      if (res.success && res.data) setMethod(res.data.method)
      else {
        toast.error(res.error ?? 'Unable to start verification.')
        onDone(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [open, onDone])

  const finish = (confirmed: boolean) => {
    setValue('')
    onDone(confirmed)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!value.trim()) return
    setSubmitting(true)
    const res = await submitStepUpAction(
      method === 'MFA' ? { mfaCode: value.trim() } : { password: value },
    )
    setSubmitting(false)

    if (res.success) {
      finish(true)
      return
    }
    toast.error(res.error ?? 'Verification failed.')
    if (res.code === 'SESSION_REVOKED' || res.code === 'UNAUTHENTICATED') {
      await signOut({ callbackUrl: '/login' })
    }
    setValue('')
  }

  return (
    <Dialog open={open} onOpenChange={(val) => !val && finish(false)}>
      <DialogContent className='sm:max-w-sm'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <ShieldCheck className='w-5 h-5 text-primary' /> Confirm it&apos;s you
          </DialogTitle>
          <DialogDescription>
            {method === 'MFA'
              ? 'Enter a code from your authenticator app (or a backup code) to continue.'
              : 'Enter your password to continue.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className='flex flex-col gap-3'>
          <Label htmlFor='step-up-input' className='text-xs font-semibold'>
            {method === 'MFA' ? 'Verification code' : 'Password'}
          </Label>
          <Input
            id='step-up-input'
            type={method === 'PASSWORD' ? 'password' : 'text'}
            inputMode={method === 'MFA' ? 'numeric' : undefined}
            autoComplete={method === 'MFA' ? 'one-time-code' : 'current-password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={!method || submitting}
            autoFocus
          />
          <DialogFooter className='gap-2 sm:gap-0'>
            <Button type='button' variant='ghost' size='sm' onClick={() => finish(false)}>
              Cancel
            </Button>
            <Button type='submit' size='sm' disabled={!method || submitting || !value.trim()}>
              {submitting ? 'Verifying...' : 'Confirm'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Runs a server action; if it answers `STEP_UP_REQUIRED`, prompts for step-up and retries once.
 *
 *   const { withStepUp, stepUpDialog } = useStepUp()
 *   const res = await withStepUp(() => someSensitiveAction(args))
 *   ...render {stepUpDialog} somewhere in the component
 */
export function useStepUp() {
  const [open, setOpen] = useState(false)
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null)

  const onDone = useCallback((confirmed: boolean) => {
    setOpen(false)
    resolverRef.current?.(confirmed)
    resolverRef.current = null
  }, [])

  const withStepUp = useCallback(
    async <T extends { success: boolean; code?: string }>(action: () => Promise<T>): Promise<T> => {
      const first = await action()
      if (first.success || first.code !== 'STEP_UP_REQUIRED') return first

      const confirmed = await new Promise<boolean>((resolve) => {
        resolverRef.current = resolve
        setOpen(true)
      })
      return confirmed ? action() : first
    },
    [],
  )

  const stepUpDialog = <StepUpDialog open={open} onDone={onDone} />
  return { withStepUp, stepUpDialog }
}
