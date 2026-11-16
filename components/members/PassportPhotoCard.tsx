'use client'

import React, { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Camera, Loader2, UserRound } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { uploadPassportPhotoAction } from '@/models/members/passport-actions'

const MAX_BYTES = 5 * 1024 * 1024

interface PassportPhotoCardProps {
  /** `/api/files/[id]` link (authorised delivery) or null when no photo yet. */
  photoUrl: string | null
  /** True for the member themself; staff see the photo read-only. */
  canEdit: boolean
}

/**
 * Shows the member's passport photograph and, for the member, lets them add or replace it.
 * The photo is one of the four profile sections required before savings, loans and e-ajo.
 */
export const PassportPhotoCard = ({ photoUrl, canEdit }: PassportPhotoCardProps) => {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [imageFailed, setImageFailed] = useState(false)

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      toast.error('Please choose a JPG or PNG photo.')
      return
    }
    if (file.size > MAX_BYTES) {
      toast.error('The photo is larger than 5 MB. Please choose a smaller one.')
      return
    }

    setUploading(true)
    const formData = new FormData()
    formData.append('file', file)
    const res = await uploadPassportPhotoAction(formData)
    setUploading(false)

    if (res.success) {
      toast.success('Passport photo saved.')
      setImageFailed(false)
      startTransition(() => router.refresh())
    } else {
      toast.error(res.error || 'Your photo could not be uploaded.')
    }
  }

  const busy = uploading || isPending

  return (
    <Card className='border-0 bg-surface-container rounded-md shadow-none'>
      <CardContent className='p-5 flex items-center gap-4'>
        <div className='w-20 h-24 rounded-md bg-surface-container-high border border-outline-variant/30 overflow-hidden flex items-center justify-center shrink-0'>
          {photoUrl && !imageFailed ? (
            // eslint-disable-next-line @next/next/no-img-element -- authorised redirect to a short-lived signed URL
            <img
              src={photoUrl}
              alt='Passport photograph'
              className='w-full h-full object-cover'
              onError={() => setImageFailed(true)}
            />
          ) : (
            <UserRound className='w-8 h-8 text-muted-foreground' aria-hidden='true' />
          )}
        </div>
        <div className='flex flex-col gap-1.5 min-w-0'>
          <span className='font-semibold text-sm'>Passport Photo</span>
          <span className='text-xs text-muted-foreground'>
            {photoUrl
              ? 'A clear, recent photo of your face. You can replace it at any time.'
              : canEdit
                ? 'Add a clear, recent photo of your face (JPG or PNG, up to 5 MB). It is needed before you can save, borrow or join e-ajo.'
                : 'No passport photo uploaded yet.'}
          </span>
          {canEdit && (
            <div>
              <input
                ref={inputRef}
                id='passport-photo-input'
                type='file'
                accept='image/jpeg,image/png'
                className='hidden'
                onChange={handleFile}
              />
              <Button
                type='button'
                size='sm'
                variant={photoUrl ? 'outline' : 'default'}
                disabled={busy}
                onClick={() => inputRef.current?.click()}
                className='h-8 text-xs cursor-pointer gap-1.5'
              >
                {busy ? <Loader2 className='w-3.5 h-3.5 animate-spin' /> : <Camera className='w-3.5 h-3.5' />}
                {busy ? 'Uploading...' : photoUrl ? 'Replace photo' : 'Upload photo'}
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
