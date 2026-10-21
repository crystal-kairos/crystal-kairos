'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ShieldCheck, KeyRound, ArrowRight } from 'lucide-react'
import { toast } from 'sonner'
import { verifyMfaChallengeAction } from '@/models/auth/mfaActions'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

export default function MfaChallengePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const userId = searchParams.get('userId') ?? ''
  const sessionId = searchParams.get('sid') ?? undefined
  const callbackUrl = searchParams.get('callbackUrl') ?? '/admin'

  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [useBackupCode, setUseBackupCode] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!code.trim()) {
      toast.error('Please enter your verification code.')
      return
    }

    setLoading(true)
    try {
      const result = await verifyMfaChallengeAction({
        userId,
        code: code.trim(),
        sessionId,
      })

      if (!result.success) {
        toast.error(result.error ?? 'Invalid verification code.')
        setLoading(false)
        return
      }

      toast.success(
        result.data?.method === 'backup_code'
          ? 'Backup code accepted. Please generate new backup codes in Security Settings if needed.'
          : 'Authentication verified.',
      )
      router.replace(callbackUrl)
    } catch {
      toast.error('An error occurred during verification.')
      setLoading(false)
    }
  }

  return (
    <div className='min-h-screen flex items-center justify-center p-6 bg-surface-container-lowest'>
      <div className='w-full max-w-md p-8 rounded-2xl bg-surface border border-outline-variant shadow-lg flex flex-col gap-6'>
        <div className='flex flex-col items-center text-center gap-2'>
          <div className='w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary'>
            <ShieldCheck className='w-6 h-6' />
          </div>
          <h2 className='text-2xl font-bold tracking-tight text-primary'>
            Two-Factor Authentication
          </h2>
          <p className='text-sm text-muted-foreground'>
            {useBackupCode
              ? 'Enter one of your 8-character single-use backup codes.'
              : 'Enter the 6-digit code from your authenticator application.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className='flex flex-col gap-4'>
          <div>
            <label
              htmlFor='mfa-code'
              className='block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1'
            >
              {useBackupCode ? 'Backup Code' : 'Verification Code'}
            </label>
            <input
              id='mfa-code'
              type='text'
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={useBackupCode ? 'XXXX-XXXX' : '123456'}
              maxLength={useBackupCode ? 16 : 8}
              autoFocus
              className='w-full px-4 py-3 text-center text-xl font-mono tracking-widest rounded-xl border border-input focus:outline-none focus:ring-2 focus:ring-primary bg-background'
            />
          </div>

          <Button
            type='submit'
            variant='secondary'
            disabled={loading}
            className='w-full py-6 font-bold text-on-secondary rounded-xl'
          >
            {loading ? <Spinner /> : 'Verify Code'}
            {!loading && <ArrowRight className='w-4 h-4 ml-2' />}
          </Button>

          <Button
            type='button'
            variant='ghost'
            onClick={() => {
              setUseBackupCode(!useBackupCode)
              setCode('')
            }}
            className='text-xs text-muted-foreground hover:text-foreground'
          >
            <KeyRound className='w-3.5 h-3.5 mr-1.5' />
            {useBackupCode
              ? 'Use authenticator app code instead'
              : 'Lost access to authenticator? Use a backup code'}
          </Button>
        </form>
      </div>
    </div>
  )
}
