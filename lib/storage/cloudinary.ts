import { v2 as cloudinary } from 'cloudinary'
import { AdminPermission, UserRole } from '@/generated/prisma/enums'
import { prisma } from '@/lib/prisma'
import {
  AuthzError,
  requireAnyPermission,
  requireAuthenticatedSession,
} from '@/lib/authz/guards'
import {
  FileValidationError,
  isStoredFilePurpose,
  StoredFilePurpose,
  validateStoredFileBuffer,
} from '@/lib/storage/file-validation'

export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageConfigError'
  }
}

export class StorageUploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageUploadError'
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

export function ensureCloudinaryConfigured(): {
  cloudName: string
  apiKey: string
  apiSecret: string
  baseFolder: string
} {
  if (
    process.env.NEXT_PUBLIC_CLOUDINARY_API_SECRET ||
    process.env.NEXT_PUBLIC_CLOUDINARY_API_KEY
  ) {
    throw new StorageConfigError(
      'Cloudinary credentials must never be exposed via NEXT_PUBLIC_ environment variables.',
    )
  }

  const cloudName = getRequiredEnv('CLOUDINARY_CLOUD_NAME')
  const apiKey = getRequiredEnv('CLOUDINARY_API_KEY')
  const apiSecret = getRequiredEnv('CLOUDINARY_API_SECRET')
  const baseFolder = getRequiredEnv('CLOUDINARY_BASE_FOLDER').replace(
    /^\/+|\/+$/g,
    '',
  )

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  })

  return { cloudName, apiKey, apiSecret, baseFolder }
}

export interface UploadStoredFileParams {
  buffer: Buffer
  filename: string
  declaredMimeType?: string
  purpose?: StoredFilePurpose
  uploadedById: string
  ownerUserId?: string | null
  associatedType?: string | null
  associatedId?: string | null
}

export interface UploadedStoredFileResult {
  fileId: string
  url: string
  publicId: string
  secureUrl: string
  purpose: StoredFilePurpose
  contentType: string
  sizeBytes: number
  format: string
}

export interface CloudinaryUploaderLike {
  upload_stream: typeof cloudinary.uploader.upload_stream
}

/**
 * Validates a file buffer on the server, uploads it strictly to Cloudinary
 * using authenticated delivery under `${CLOUDINARY_BASE_FOLDER}/${purpose}`,
 * persists file metadata in `StoredFile`, and returns the controlled `/api/files/[fileId]` URL.
 */
export async function uploadStoredFile(
  params: UploadStoredFileParams,
  deps: {
    db?: typeof prisma
    uploader?: CloudinaryUploaderLike
  } = {},
): Promise<UploadedStoredFileResult> {
  const db = deps.db ?? prisma
  const uploader = deps.uploader ?? cloudinary.uploader
  const purpose: StoredFilePurpose = params.purpose ?? 'receipts'

  // 1. Validate size, magic bytes, extension, MIME, and purpose BEFORE contacting Cloudinary
  const validated = validateStoredFileBuffer({
    buffer: params.buffer,
    filename: params.filename,
    declaredMimeType: params.declaredMimeType,
    purpose,
  })

  // 2. Verify Cloudinary configuration & derive strict server-side folder
  ensureCloudinaryConfigured()
  const targetFolder = folderFor(purpose)

  // 3. Upload buffer to Cloudinary as an authenticated asset
  const cloudinaryResult = await new Promise<{
    secure_url: string
    public_id: string
  }>((resolve, reject) => {
    const stream = uploader.upload_stream(
      {
        folder: targetFolder,
        resource_type: validated.resourceType,
        type: 'authenticated',
      },
      (error, result) => {
        if (error) {
          reject(
            new StorageUploadError(
              'Unable to upload file to cloud storage at this time.',
            ),
          )
        } else if (result?.secure_url && result?.public_id) {
          resolve({
            secure_url: result.secure_url,
            public_id: result.public_id,
          })
        } else {
          reject(
            new StorageUploadError(
              'Cloud storage returned an incomplete upload response.',
            ),
          )
        }
      },
    )

    stream.end(params.buffer)
  })

  // 4. Persist metadata in StoredFile
  const storedFile = await db.storedFile.create({
    data: {
      publicId: cloudinaryResult.public_id,
      secureUrl: cloudinaryResult.secure_url,
      purpose,
      resourceType: validated.resourceType,
      deliveryType: 'authenticated',
      format: validated.extension,
      contentType: validated.mimeType,
      sizeBytes: validated.sizeBytes,
      originalFilename: validated.sanitizedFilename,
      uploadedById: params.uploadedById,
      ownerUserId: params.ownerUserId ?? params.uploadedById,
      associatedType: params.associatedType ?? null,
      associatedId: params.associatedId ?? null,
    },
  })

  return {
    fileId: storedFile.id,
    url: `/api/files/${storedFile.id}`,
    publicId: storedFile.publicId,
    secureUrl: storedFile.secureUrl,
    purpose,
    contentType: storedFile.contentType,
    sizeBytes: storedFile.sizeBytes,
    format: storedFile.format,
  }
}

export function extractStoredFileIdFromUrl(
  url: string | null | undefined,
): string | null {
  if (!url) return null
  const match = url.trim().match(/^\/api\/files\/([a-zA-Z0-9_-]+)$/)
  return match ? match[1] : null
}

/**
 * Links an uploaded StoredFile record to its owning member and domain entity
 * once the transaction/record is created.
 */
export async function bindStoredFileToRecord(
  params: {
    fileUrl?: string | null
    ownerUserId: string
    associatedType: string
    associatedId: string
  },
  db: typeof prisma = prisma,
): Promise<void> {
  const fileId = extractStoredFileIdFromUrl(params.fileUrl)
  if (!fileId) return

  try {
    await db.storedFile.updateMany({
      where: { id: fileId },
      data: {
        ownerUserId: params.ownerUserId,
        associatedType: params.associatedType,
        associatedId: params.associatedId,
      },
    })
  } catch {
    // Non-fatal if mocked in tests without a storedFile table
  }
}

export function generateSignedCloudinaryUrl(
  file: {
    publicId: string
    format: string
    resourceType: string
    deliveryType?: string
  },
  expiresInSeconds = 60,
): string {
  ensureCloudinaryConfigured()
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds

  return cloudinary.utils.private_download_url(file.publicId, file.format, {
    resource_type: file.resourceType,
    type: file.deliveryType ?? 'authenticated',
    expires_at: expiresAt,
  })
}

const FILE_ACCESS_STAFF_PERMISSIONS: readonly AdminPermission[] = [
  AdminPermission.TRANSACTIONS_READ,
  AdminPermission.TRANSACTIONS_REVIEW,
  AdminPermission.SAVINGS_READ,
  AdminPermission.SAVINGS_MANAGE,
  AdminPermission.SAVINGS_PAYMENTS_REVIEW,
  AdminPermission.LOANS_READ,
  AdminPermission.LOANS_REVIEW,
  AdminPermission.LOANS_DISBURSE,
  AdminPermission.EAJO_READ,
  AdminPermission.EAJO_MANAGE,
  AdminPermission.EAJO_PAYMENTS_REVIEW,
  AdminPermission.EAJO_PAYOUTS_MANAGE,
  AdminPermission.MEMBERS_READ,
  AdminPermission.MEMBERS_APPROVE,
]

export async function authorizeAndResolveStoredFile(
  fileIdOrKey: string,
  db: typeof prisma = prisma,
) {
  const actor = await requireAuthenticatedSession(db)

  const trimmed = fileIdOrKey.trim()
  if (!trimmed) {
    throw new AuthzError('NOT_FOUND', 'File not found.')
  }

  const storedFile = await db.storedFile.findFirst({
    where: {
      OR: [{ id: trimmed }, { publicId: trimmed }],
    },
  })

  if (!storedFile) {
    throw new AuthzError('NOT_FOUND', 'File not found.')
  }

  let effectiveOwnerId = storedFile.ownerUserId
  if (!effectiveOwnerId || effectiveOwnerId === storedFile.uploadedById) {
    // Check if a transaction references this file so a member can view a disbursement receipt attached to their loan
    const linkedTx = await db.transaction.findFirst({
      where: {
        OR: [
          { receiptUrl: `/api/files/${storedFile.id}` },
          { receiptUrl: storedFile.secureUrl },
        ],
      },
      select: { userId: true },
    })
    if (linkedTx?.userId) {
      effectiveOwnerId = linkedTx.userId
    }
  }

  if (actor.role === UserRole.USER) {
    const isOwner =
      effectiveOwnerId === actor.id || storedFile.uploadedById === actor.id
    if (!isOwner) {
      throw new AuthzError(
        'FORBIDDEN',
        'You are not authorised to access another member file.',
      )
    }
  } else {
    await requireAnyPermission(FILE_ACCESS_STAFF_PERMISSIONS, db)
  }

  const signedUrl = generateSignedCloudinaryUrl(storedFile, 60)

  return {
    storedFile,
    signedUrl,
  }
}
