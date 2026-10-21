'use client'

import { useEffect } from 'react'

interface GlobalErrorProps {
  error: Error & { digest?: string }
  reset?: () => void
  unstable_retry?: () => void
}

export default function GlobalError({
  error,
  reset,
  unstable_retry,
}: GlobalErrorProps) {
  useEffect(() => {
    console.error('[GlobalErrorBoundary]', {
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
    <html lang='en'>
      <body className='min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-6'>
        <title>Crystal Kairos — Application Error</title>
        <div className='max-w-md w-full rounded-xl border border-slate-200 bg-white p-8 shadow-sm text-center space-y-4'>
          <h1 className='text-xl font-bold'>Something went wrong</h1>
          <p className='text-sm text-slate-600'>
            Crystal Kairos encountered an unexpected error. Please try again or
            contact cooperative support if the issue persists.
          </p>
          {error.digest && (
            <p className='text-xs font-mono text-slate-500 bg-slate-100 px-2.5 py-1 rounded inline-block'>
              Support Ref: {error.digest}
            </p>
          )}
          <div className='pt-2 flex items-center justify-center gap-3'>
            <button
              type='button'
              onClick={handleRetry}
              className='px-4 py-2 rounded-md bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 cursor-pointer'
            >
              Try Again
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
