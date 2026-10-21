import { requireAuthenticatedSession } from '@/lib/authz/guards'
import {
  uploadStoredFile,
  UploadedStoredFileResult,
} from '@/lib/storage/cloudinary'
import { StoredFilePurpose } from '@/lib/storage/file-validation'

export type { StoredFilePurpose, UploadedStoredFileResult }

export interface UploadReceiptOptions {
  purpose?: StoredFilePurpose
  declaredMimeType?: string
  uploadedById?: string
  ownerUserId?: string | null
  associatedType?: string | null
  associatedId?: string | null
}

/**
 * Uploads a file buffer strictly to Cloudinary via `lib/storage/cloudinary.ts`.
 * Enforces server-side size (<= 5 MB) and magic-byte signature validation,
 * stores metadata in `StoredFile`, and returns a controlled authenticated URL (`/api/files/[fileId]`).
 * Never falls back to local disk.
 */
export async function uploadReceipt(
  file: Buffer,
  filename: string,
  options: UploadReceiptOptions = {},
): Promise<{
  fileId: string
  url: string
  publicId: string
  secureUrl: string
  contentType: string
  sizeBytes: number
}> {
  let uploadedById = options.uploadedById
  if (!uploadedById) {
    const actor = await requireAuthenticatedSession()
    uploadedById = actor.id
  }

  const result = await uploadStoredFile({
    buffer: file,
    filename,
    declaredMimeType: options.declaredMimeType,
    purpose: options.purpose ?? 'receipts',
    uploadedById,
    ownerUserId: options.ownerUserId ?? uploadedById,
    associatedType: options.associatedType ?? null,
    associatedId: options.associatedId ?? null,
  })

  return {
    fileId: result.fileId,
    url: result.url,
    publicId: result.publicId,
    secureUrl: result.secureUrl,
    contentType: result.contentType,
    sizeBytes: result.sizeBytes,
  }
}
