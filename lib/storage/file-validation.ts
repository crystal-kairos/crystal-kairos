export const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB

export const STORED_FILE_PURPOSES = [
  'receipts',
  'passport-photos',
  'guarantor-evidence',
] as const

export type StoredFilePurpose = (typeof STORED_FILE_PURPOSES)[number]

export type AllowedMimeType = 'image/jpeg' | 'image/png' | 'application/pdf'
export type AllowedFileExtension = 'jpg' | 'png' | 'pdf'

export type FileValidationErrorCode =
  | 'INVALID_PURPOSE'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'
  | 'SIGNATURE_MISMATCH'
  | 'PURPOSE_FORMAT_NOT_ALLOWED'

export class FileValidationError extends Error {
  readonly code: FileValidationErrorCode

  constructor(code: FileValidationErrorCode, message: string) {
    super(message)
    this.name = 'FileValidationError'
    this.code = code
  }
}

export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageConfigError'
  }
}

const cleanEnvValue = (val: string | undefined): string => {
  if (!val) return ''
  return val.replace(/^["']|["']$/g, '').trim()
}

export function getRequiredEnv(name: string): string {
  if (name.startsWith('NEXT_PUBLIC_') && name.includes('CLOUDINARY')) {
    throw new StorageConfigError(
      `Cloudinary configuration variable ${name} must not use a NEXT_PUBLIC_ prefix.`,
    )
  }

  const value = cleanEnvValue(process.env[name])
  if (!value) {
    throw new StorageConfigError(
      `Missing required Cloudinary environment variable: ${name}.`,
    )
  }
  return value
}

export function folderFor(purpose: StoredFilePurpose): string {
  if (!isStoredFilePurpose(purpose)) {
    throw new FileValidationError(
      'INVALID_PURPOSE',
      'Invalid file storage purpose.',
    )
  }

  const base = getRequiredEnv('CLOUDINARY_BASE_FOLDER').replace(
    /^\/+|\/+$/g,
    '',
  )
  if (!base) {
    throw new StorageConfigError(
      'CLOUDINARY_BASE_FOLDER must not be empty or root.',
    )
  }

  return `${base}/${purpose}`
}

export interface DetectedFileSignature {
  mimeType: AllowedMimeType
  extension: AllowedFileExtension
  resourceType: 'image' | 'raw'
}

export interface ValidatedFileMetadata extends DetectedFileSignature {
  sizeBytes: number
  purpose: StoredFilePurpose
  sanitizedFilename: string
}

const PURPOSE_ALLOWED_MIMES: Record<
  StoredFilePurpose,
  readonly AllowedMimeType[]
> = {
  receipts: ['image/jpeg', 'image/png', 'application/pdf'],
  'guarantor-evidence': ['image/jpeg', 'image/png', 'application/pdf'],
  'passport-photos': ['image/jpeg', 'image/png'],
}

export function isStoredFilePurpose(
  value: unknown,
): value is StoredFilePurpose {
  return (
    typeof value === 'string' &&
    (STORED_FILE_PURPOSES as readonly string[]).includes(value)
  )
}

/**
 * Inspects magic bytes at the start of a file buffer to determine the actual file format.
 * Never trusts the client-supplied filename or MIME string alone.
 */
export function detectFileSignature(
  buffer: Buffer,
): DetectedFileSignature | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return {
      mimeType: 'image/jpeg',
      extension: 'jpg',
      resourceType: 'image',
    }
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return {
      mimeType: 'image/png',
      extension: 'png',
      resourceType: 'image',
    }
  }

  // PDF: 25 50 44 46 2D ("%PDF-")
  if (
    buffer.length >= 5 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  ) {
    return {
      mimeType: 'application/pdf',
      extension: 'pdf',
      resourceType: 'raw',
    }
  }

  return null
}

function normalizeDeclaredMime(mime?: string | null): string | null {
  if (!mime) return null
  const lower = mime.trim().toLowerCase()
  if (!lower || lower === 'application/octet-stream') return null
  if (lower === 'image/jpg') return 'image/jpeg'
  return lower
}

function extractNormalizedExtension(filename?: string | null): string | null {
  if (!filename) return null
  const trimmed = filename.trim()
  const lastDot = trimmed.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === trimmed.length - 1) return null
  const ext = trimmed.slice(lastDot + 1).toLowerCase()
  if (ext === 'jpeg') return 'jpg'
  return ext
}

export function sanitizeOriginalFilename(
  filename: string | undefined,
  fallbackExtension: AllowedFileExtension,
): string {
  const base = (filename ?? 'upload')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 64)

  const cleanBase = base && base.length > 0 ? base : 'upload'
  return `${cleanBase}.${fallbackExtension}`
}

export function validateStoredFileBuffer(params: {
  buffer: Buffer
  filename?: string
  declaredMimeType?: string
  purpose?: StoredFilePurpose
  maxSizeBytes?: number
}): ValidatedFileMetadata {
  const purpose = params.purpose ?? 'receipts'
  if (!isStoredFilePurpose(purpose)) {
    throw new FileValidationError(
      'INVALID_PURPOSE',
      'Invalid file storage purpose.',
    )
  }

  const maxSizeBytes = params.maxSizeBytes ?? MAX_UPLOAD_SIZE_BYTES

  if (!Buffer.isBuffer(params.buffer) || params.buffer.length === 0) {
    throw new FileValidationError('EMPTY_FILE', 'Uploaded file is empty.')
  }

  if (params.buffer.length > maxSizeBytes) {
    const maxMb = (maxSizeBytes / (1024 * 1024)).toFixed(0)
    throw new FileValidationError(
      'FILE_TOO_LARGE',
      `File size exceeds the ${maxMb}MB maximum limit.`,
    )
  }

  const detected = detectFileSignature(params.buffer)
  if (!detected) {
    throw new FileValidationError(
      'UNSUPPORTED_FORMAT',
      'Unsupported file format. Only valid JPG, PNG, and PDF files are accepted.',
    )
  }

  const normalizedMime = normalizeDeclaredMime(params.declaredMimeType)
  if (normalizedMime && normalizedMime !== detected.mimeType) {
    throw new FileValidationError(
      'SIGNATURE_MISMATCH',
      'File content signature does not match the declared file type.',
    )
  }

  const ext = extractNormalizedExtension(params.filename)
  if (ext && ext !== detected.extension) {
    throw new FileValidationError(
      'SIGNATURE_MISMATCH',
      'File content signature does not match the file extension.',
    )
  }

  const allowedForPurpose = PURPOSE_ALLOWED_MIMES[purpose]
  if (!allowedForPurpose.includes(detected.mimeType)) {
    throw new FileValidationError(
      'PURPOSE_FORMAT_NOT_ALLOWED',
      `File format ${detected.extension.toUpperCase()} is not permitted for ${purpose}.`,
    )
  }

  return {
    ...detected,
    sizeBytes: params.buffer.length,
    purpose,
    sanitizedFilename: sanitizeOriginalFilename(
      params.filename,
      detected.extension,
    ),
  }
}
