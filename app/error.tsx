'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ErrorBoundaryProps {
  error: Error & { digest?: string }
  reset?: () => void
  unstable_retry?: () => void
}

export default function ErrorBoundary({
  error,
  reset,
  unstable_retry,
}: ErrorBoundaryProps) {
  useEffect(() => {
    console.error('[AppErrorBoundary]', {
      digest: error.digest,
      name: error.name,
    })
  }, [error])

  const handleRetry = () => {
    if (typeof unstable_retry === 'function') {
      unstable_retry()
    } else if (typeof reset === 'function') {
      reset()
    } else {
      window.location.reload()
    }
  }

  return (
    <div className='min-h-[70vh] flex flex-col items-center justify-center p-6 text-center'>
      <div className='max-w-md w-full rounded-xl border bg-card p-8 shadow-sm flex flex-col items-center gap-4'>
        <div className='w-12 h-12 rounded-full bg-destructive/10 text-destructive flex items-center justify-center'>
          <AlertTriangle className='w-6 h-6' />
        </div>
        <h1 className='text-xl font-bold text-foreground'>
          Unable to load this page
        </h1>
        <p className='text-sm text-muted-foreground'>
          We encountered an unexpected problem while processing your request.
          Your data is safe — please try again or return to the dashboard.
        </p>
        {error.digest && (
          <p className='text-xs font-mono text-muted-foreground bg-muted px-2.5 py-1 rounded'>
            Support Ref: {error.digest}
          </p>
        )}
        <div className='flex items-center gap-3 mt-2'>
          <Button type='button' onClick={handleRetry} className='gap-2'>
            <RotateCcw className='w-4 h-4' />
            Try Again
          </Button>
          <Button type='button' variant='outline' asChild>
            <Link href='/'>Return Home</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
