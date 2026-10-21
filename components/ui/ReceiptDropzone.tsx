'use client'

import React, { useRef, useState } from 'react'
import { UploadCloud, CheckCircle, X, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './button'

interface ReceiptDropzoneProps {
  onFileSelected: (file: File | null) => void
  value?: File | null
  error?: string
  className?: string
  accept?: string[] // e.g. ['image/jpeg', 'image/png', 'application/pdf']
  maxSizeMb?: number
}

const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'pdf'])

export const ReceiptDropzone = ({
  onFileSelected,
  value = null,
  error,
  className,
  accept = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'],
  maxSizeMb = 5,
}: ReceiptDropzoneProps) => {
  const effectiveMaxSizeMb = Math.min(maxSizeMb, 5)
  const [isDragActive, setIsDragActive] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setIsDragActive(true)
    } else if (e.type === 'dragleave') {
      setIsDragActive(false)
    }
  }

  const validateFile = (file: File): boolean => {
    setFileError(null)

    if (file.size <= 0) {
      setFileError('Uploaded file is empty.')
      return false
    }

    // Validate MIME type and extension
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (!accept.includes(file.type) || !ALLOWED_EXTENSIONS.has(ext)) {
      setFileError('Invalid file type. Only JPG, PNG, and PDF are supported.')
      return false
    }

    // Validate size (enforced max 5 MB)
    const maxSizeBytes = effectiveMaxSizeMb * 1024 * 1024
    if (file.size > maxSizeBytes) {
      setFileError(`File size exceeds the ${effectiveMaxSizeMb}MB limit.`)
      return false
    }

    return true
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragActive(false)

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0]
      if (validateFile(file)) {
        onFileSelected(file)
      } else {
        onFileSelected(null)
      }
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault()
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0]
      if (validateFile(file)) {
        onFileSelected(file)
      } else {
        onFileSelected(null)
      }
    }
  }

  const onButtonClick = () => {
    fileInputRef.current?.click()
  }

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation()
    onFileSelected(null)
    setFileError(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const activeError = fileError || error

  return (
    <div className={cn('w-full flex flex-col gap-2', className)}>
      <div
        className={cn(
          'relative w-full rounded-md border-2 border-dashed transition-all duration-200 cursor-pointer flex flex-col items-center justify-center p-6 text-center',
          isDragActive
            ? 'border-primary bg-primary/5'
            : 'border-outline-variant bg-surface-container-low hover:bg-surface-container hover:border-outline',
          value ? 'border-tertiary bg-tertiary/5' : '',
          activeError ? 'border-error bg-error/5' : '',
        )}
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={onButtonClick}
      >
        <input
          ref={fileInputRef}
          type='file'
          className='hidden'
          accept={accept.join(',')}
          onChange={handleFileChange}
        />

        {value ? (
          <div className='flex flex-col items-center gap-3 w-full'>
            <div className='w-12 h-12 rounded-full bg-success-container flex items-center justify-center text-on-success'>
              <CheckCircle className='w-6 h-6' />
            </div>
            <div className='flex flex-col gap-1 w-full max-w-[280px]'>
              <p className='font-semibold text-sm truncate'>{value.name}</p>
              <p className='text-xs text-muted-foreground'>
                {(value.size / (1024 * 1024)).toFixed(2)} MB
              </p>
            </div>
            <Button
              type='button'
              variant='ghost'
              size='sm'
              className='mt-2 text-error hover:text-error hover:bg-error/10 flex items-center gap-1 cursor-pointer'
              onClick={handleRemove}
            >
              <X className='w-4 h-4' /> Remove Receipt
            </Button>
          </div>
        ) : (
          <div className='flex flex-col items-center gap-2'>
            <div className='w-12 h-12 rounded-full bg-surface-container-highest flex items-center justify-center text-on-surface-variant'>
              <UploadCloud className='w-6 h-6' />
            </div>
            <p className='font-semibold text-sm'>
              Drag & Drop your receipt here, or{' '}
              <span className='text-secondary hover:underline'>browse</span>
            </p>
            <p className='text-xs text-muted-foreground'>
              Supports JPG, PNG, and PDF (Max {effectiveMaxSizeMb}MB)
            </p>
          </div>
        )}
      </div>

      {activeError && (
        <div className='flex items-center gap-1.5 text-xs text-error font-medium px-1'>
          <AlertCircle className='w-3.5 h-3.5' />
          <span>{activeError}</span>
        </div>
      )}
    </div>
  )
}
export default ReceiptDropzone
