'use client'

import { useState, useEffect, Suspense } from 'react'
import Image from 'next/image'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import {
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  KeyRound,
  Trash2,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  initiateMfaSetupAction,
  confirmMfaEnrollmentAction,
} from '@/models/auth/mfaActions'
import {
  getActiveSessionsAction,
  revokeSessionAction,
  revokeAllSessionsAction,
} from '@/models/auth/sessionActions'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

interface SessionItem {
  id: string
  createdAt: Date
  lastSeenAt: Date
  expiresAt: Date
  idleExpiresAt: Date
  userAgentLabel: string | null
  mfaVerifiedAt: Date | null
  isCurrent: boolean
}

function SecuritySettingsContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { data: session, update } = useSession()

  const [loadingSetup, setLoadingSetup] = useState(false)
  const [setupData, setSetupData] = useState<{
    secret: string
    uri: string
    qrCodeDataUrl: string
  } | null>(null)
  const [verificationCode, setVerificationCode] = useState('')
  const [enrolling, setEnrolling] = useState(false)
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)

  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)

  const loadSessions = async () => {
    setLoadingSessions(true)
    const res = await getActiveSessionsAction()
    if (res.success && res.data) {
      setSessions(res.data as unknown as SessionItem[])
    }
    setLoadingSessions(false)
  }

  useEffect(() => {
    let ignore = false
    async function init() {
      setLoadingSessions(true)
      const res = await getActiveSessionsAction()
      if (!ignore) {
        if (res.success && res.data) {
          setSessions(res.data as unknown as SessionItem[])
        }
        setLoadingSessions(false)
      }
    }
    void init()
    return () => {
      ignore = true
    }
  }, [])

  const handleStartSetup = async () => {
    setLoadingSetup(true)
    const res = await initiateMfaSetupAction()
    if (res.success && res.data) {
      setSetupData(res.data)
    } else {
      toast.error(res.error ?? 'Failed to start MFA setup.')
    }
    setLoadingSetup(false)
  }

  const handleConfirmEnrollment = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!setupData || !verificationCode.trim()) {
      toast.error('Please enter the 6-digit code from your authenticator app.')
      return
    }

    setEnrolling(true)
    const res = await confirmMfaEnrollmentAction({
      secret: setupData.secret,
      token: verificationCode.trim(),
    })

    if (res.success && res.data) {
      toast.success('MFA successfully enabled!')
      setBackupCodes(res.data.backupCodes)
      setSetupData(null)
      loadSessions()
      void update({ mfaEnabled: true })
    } else {
      toast.error(res.error ?? 'Failed to verify authenticator code.')
    }
    setEnrolling(false)
  }

  const handleAcknowledgeBackupCodes = async () => {
    setBackupCodes(null)
    await update({ mfaEnabled: true })
    const callbackUrl = searchParams.get('callbackUrl')
    const role = session?.user?.role
    const uid = session?.user?.id

    if (callbackUrl && !callbackUrl.startsWith('/security')) {
      router.replace(callbackUrl)
    } else if (role === 'ADMIN' || role === 'OWNER') {
      router.replace('/admin')
    } else if (role === 'USER' && uid) {
      router.replace(`/dashboard/${uid}`)
    } else {
      router.replace('/dashboard')
    }
  }

  const handleRevokeSession = async (sid: string) => {
    const res = await revokeSessionAction(sid)
    if (res.success) {
      toast.success('Session revoked.')
      loadSessions()
    } else {
      toast.error(res.error ?? 'Failed to revoke session.')
    }
  }

  const handleRevokeAllSessions = async () => {
    if (!confirm('This will invalidate all other logged-in sessions. Continue?')) {
      return
    }
    const res = await revokeAllSessionsAction()
    if (res.success) {
      toast.success('All other sessions revoked.')
      loadSessions()
    } else {
      toast.error(res.error ?? 'Failed to revoke all sessions.')
    }
  }

  return (
    <div className='max-w-4xl mx-auto p-6 flex flex-col gap-8'>
      <div>
        <h1 className='text-3xl font-bold tracking-tight text-foreground'>
          Account Security & MFA
        </h1>
        <p className='text-muted-foreground text-sm mt-1'>
          Manage two-factor authentication, backup codes, and active sessions.
        </p>
      </div>

      {/* MFA Enrolment Card */}
      <div className='p-6 rounded-2xl bg-surface border border-outline-variant shadow-sm flex flex-col gap-6'>
        <div className='flex items-start justify-between'>
          <div className='flex items-center gap-3'>
            <div className='w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary'>
              <Smartphone className='w-5 h-5' />
            </div>
            <div>
              <h2 className='text-lg font-bold'>Two-Factor Authentication (TOTP)</h2>
              <p className='text-xs text-muted-foreground'>
                Requires Google Authenticator, 1Password, or compatible TOTP app.
              </p>
            </div>
          </div>
          {!setupData && !backupCodes && (
            <Button
              onClick={handleStartSetup}
              disabled={loadingSetup}
              variant='secondary'
            >
              {loadingSetup ? <Spinner /> : 'Configure MFA'}
            </Button>
          )}
        </div>

        {setupData && (
          <div className='p-6 rounded-xl bg-surface-container-low border border-outline-variant flex flex-col md:flex-row gap-6 items-center'>
            <div className='p-2 bg-white rounded-lg shadow-sm'>
              <Image
                src={setupData.qrCodeDataUrl}
                alt='TOTP QR Code'
                width={192}
                height={192}
                className='w-48 h-48'
                unoptimized
              />
            </div>
            <div className='flex flex-col gap-4 flex-1'>
              <div>
                <h3 className='font-bold text-sm'>1. Scan QR Code</h3>
                <p className='text-xs text-muted-foreground mt-0.5'>
                  Open your authenticator app and scan this QR code, or manually enter the key below:
                </p>
                <code className='block mt-2 p-2 rounded bg-background border text-xs font-mono select-all'>
                  {setupData.secret}
                </code>
              </div>

              <form onSubmit={handleConfirmEnrollment} className='flex flex-col gap-2'>
                <h3 className='font-bold text-sm'>2. Enter 6-digit Code</h3>
                <div className='flex gap-2'>
                  <input
                    type='text'
                    value={verificationCode}
                    onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder='123456'
                    inputMode='numeric'
                    autoComplete='one-time-code'
                    maxLength={6}
                    autoFocus
                    className='w-32 px-3 py-2 text-center font-mono text-lg rounded-lg border border-input bg-background'
                  />
                  <Button type='submit' variant='secondary' disabled={enrolling}>
                    {enrolling ? <Spinner /> : 'Activate MFA'}
                  </Button>
                  <Button
                    type='button'
                    variant='ghost'
                    onClick={() => setSetupData(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {backupCodes && (
          <div className='p-6 rounded-xl bg-amber-500/10 border border-amber-500/30 flex flex-col gap-4'>
            <div className='flex items-center gap-2 text-amber-600 dark:text-amber-400 font-bold'>
              <AlertTriangle className='w-5 h-5' />
              <span>Save Your Emergency Backup Codes</span>
            </div>
            <p className='text-xs text-muted-foreground'>
              Store these codes in a safe place. Each code can be used once if you lose access to your authenticator app.
            </p>
            <div className='grid grid-cols-2 sm:grid-cols-5 gap-2 font-mono text-sm bg-background p-4 rounded-lg border'>
              {backupCodes.map((code, idx) => (
                <div key={idx} className='p-1.5 text-center bg-muted/40 rounded select-all'>
                  {code}
                </div>
              ))}
            </div>
            <div>
              <Button
                variant='outline'
                size='sm'
                onClick={handleAcknowledgeBackupCodes}
              >
                I have saved these codes
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Active Sessions Card */}
      <div className='p-6 rounded-2xl bg-surface border border-outline-variant shadow-sm flex flex-col gap-6'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-3'>
            <div className='w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary'>
              <KeyRound className='w-5 h-5' />
            </div>
            <div>
              <h2 className='text-lg font-bold'>Active Sessions</h2>
              <p className='text-xs text-muted-foreground'>
                Revocable database-backed sessions with idle and absolute timeouts.
              </p>
            </div>
          </div>
          <div className='flex gap-2'>
            <Button
              variant='outline'
              size='sm'
              onClick={loadSessions}
              disabled={loadingSessions}
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loadingSessions ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button
              variant='destructive'
              size='sm'
              onClick={handleRevokeAllSessions}
            >
              <ShieldAlert className='w-3.5 h-3.5 mr-1.5' />
              Revoke All
            </Button>
          </div>
        </div>

        <div className='divide-y border rounded-xl overflow-hidden'>
          {sessions.length === 0 && !loadingSessions && (
            <div className='p-6 text-center text-sm text-muted-foreground'>
              No active sessions found.
            </div>
          )}

          {sessions.map((s) => (
            <div
              key={s.id}
              className='p-4 flex items-center justify-between bg-surface-container-lowest'
            >
              <div className='flex flex-col gap-1'>
                <div className='flex items-center gap-2'>
                  <span className='font-medium text-sm'>
                    {s.userAgentLabel || 'Web Browser Session'}
                  </span>
                  {s.isCurrent && (
                    <span className='text-xs bg-emerald-500/10 text-emerald-600 px-2 py-0.5 rounded-full font-semibold'>
                      Current Session
                    </span>
                  )}
                  {s.mfaVerifiedAt && (
                    <span className='text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-semibold flex items-center gap-1'>
                      <ShieldCheck className='w-3 h-3' /> MFA Verified
                    </span>
                  )}
                </div>
                <div className='text-xs text-muted-foreground flex gap-4'>
                  <span>Started: {new Date(s.createdAt).toLocaleString()}</span>
                  <span>Last active: {new Date(s.lastSeenAt).toLocaleString()}</span>
                </div>
              </div>

              {!s.isCurrent && (
                <Button
                  size='sm'
                  variant='ghost'
                  onClick={() => handleRevokeSession(s.id)}
                  className='text-destructive hover:bg-destructive/10'
                >
                  <Trash2 className='w-4 h-4 mr-1' /> Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function SecuritySettingsPage() {
  return (
    <Suspense fallback={null}>
      <SecuritySettingsContent />
    </Suspense>
  )
}

