'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import {
  assertTargetUserIsMember,
  requireMemberSession,
} from '@/lib/authz/guards'
import { AppError } from '@/lib/errors/app-error'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import { uploadStoredFile } from '@/lib/storage/cloudinary'
import { recordAuditEvent, AuditAction } from '@/lib/services/audit.service'

/**
 * Member uploads (or replaces) their passport photograph (P3-01 profile completion).
 *
 * - JPG or PNG up to 5 MB, validated on the server (size, file signature) by `uploadStoredFile`.
 * - Stored privately in Cloudinary under the `passport-photos` purpose and owned by the member;
 *   it is only ever delivered through the authorised `/api/files/[fileId]` route.
 * - `User.photoUrl` points at that route. Earlier photos are kept (history), not deleted.
 */
export const uploadPassportPhotoAction = async (formData: FormData) => {
  try {
    const actor = await requireMemberSession()
    await assertTargetUserIsMember(actor.id)

    const file = formData.get('file')
    if (!file || typeof file === 'string' || typeof (file as File).arrayBuffer !== 'function') {
      throw new AppError('VALIDATION_ERROR', 'Choose a photo to upload.')
    }
    const photo = file as File
    const buffer = Buffer.from(await photo.arrayBuffer())

    const uploaded = await uploadStoredFile({
      buffer,
      filename: photo.name || 'passport-photo',
      declaredMimeType: photo.type,
      purpose: 'passport-photos',
      uploadedById: actor.id,
      ownerUserId: actor.id,
      associatedType: 'User',
      associatedId: actor.id,
    })

    await prisma.$transaction(async (tx) => {
      const previous = await tx.user.findUnique({
        where: { id: actor.id },
        select: { photoUrl: true },
      })

      await tx.user.update({
        where: { id: actor.id },
        data: { photoUrl: uploaded.url },
      })

      await recordAuditEvent(
        {
          actorId: actor.id,
          actorRole: actor.role,
          affectedUserId: actor.id,
          action: AuditAction.MEMBER_PASSPORT_PHOTO_SET,
          entityType: 'StoredFile',
          entityId: uploaded.fileId,
          metadata: { replacedPrevious: Boolean(previous?.photoUrl) },
        },
        tx,
      )
    })

    try {
      revalidatePath(`/dashboard/${actor.id}`)
      revalidatePath(`/dashboard/${actor.id}/profile`)
      revalidatePath(`/admin/members/${actor.id}`)
    } catch {
      // revalidatePath is unavailable outside a Next.js request (e.g. in tests)
    }

    return { success: true, data: { photoUrl: uploaded.url } }
  } catch (error) {
    const err = toActionErrorResult(error, {
      actionName: 'uploadPassportPhotoAction',
      fallbackMessage: 'Your photo could not be uploaded. Please try again.',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      fieldErrors: err.fieldErrors,
      correlationId: err.correlationId,
    }
  }
}
