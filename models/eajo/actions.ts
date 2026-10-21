'use server'

import { prisma } from '@/lib/prisma'
import {
  AdminPermission,
  EAjoStatus,
  EAjoMemberStatus,
  TransactionCategory,
  TransactionType,
  TransactionStatus,
  UserRole,
} from '@/generated/prisma/enums'
import { EAjoMember, Transaction } from '@/generated/prisma/client'
import { revalidatePath } from 'next/cache'
import { uploadReceipt } from '@/lib/upload'
import {
  bindStoredFileToRecord,
  StorageConfigError,
  StorageUploadError,
} from '@/lib/storage/cloudinary'
import {
  FileValidationError,
  isStoredFilePurpose,
  StoredFilePurpose,
} from '@/lib/storage/file-validation'
import {
  assertTargetUserIsMember,
  AuthzError,
  requireAuthenticatedSession,
  requireMemberOrStaffWithPermission,
} from '@/lib/authz/guards'

const serializeMember = (m: EAjoMember) => ({
  ...m,
  feePercentage: Number(m.feePercentage),
  feeAmount: Number(m.feeAmount),
  totalExpectedPayout: Number(m.totalExpectedPayout),
  netPayoutAmount: Number(m.netPayoutAmount),
  currentBalance: Number(m.currentBalance),
  totalContributed: Number(m.totalContributed),
})

const serializeTransaction = (tx: Transaction) => ({
  ...tx,
  amount: Number(tx.amount),
})

/**
 * User applies to join an eAjo group slot
 */
export const applyToEAjoGroupAction = async (
  userId: string,
  groupId: string,
  formData: {
    payoutPosition: number
    guarantorName: string
    guarantorPhoneNumber: string
    bankName: string
    accountNumber: string
    accountName: string
  },
) => {
  try {
    const actor = await requireMemberOrStaffWithPermission(userId, [
      AdminPermission.EAJO_MANAGE,
    ])
    const targetUserId =
      actor.role === UserRole.USER ? actor.id : userId

    await assertTargetUserIsMember(targetUserId)

    // Verify the group exists and is PENDING (accepting applications)
    const group = await prisma.eAjoGroup.findUnique({ where: { id: groupId } })
    if (!group) return { success: false, error: 'Ajo group not found.' }
    if (
      group.status !== EAjoStatus.PENDING &&
      group.status !== EAjoStatus.ACTIVE
    ) {
      return {
        success: false,
        error: 'This group is no longer accepting applications.',
      }
    }

    // Verify slot is still available
    const slotTaken = await prisma.eAjoMember.findUnique({
      where: {
        groupId_payoutPosition: {
          groupId,
          payoutPosition: formData.payoutPosition,
        },
      },
    })
    if (slotTaken) {
      return {
        success: false,
        error: 'This slot has already been taken. Please choose another.',
      }
    }

    // Verify user hasn't already applied to this group
    const existingApplication = await prisma.eAjoMember.findUnique({
      where: { groupId_userId: { groupId, userId: targetUserId } },
    })
    if (existingApplication) {
      return {
        success: false,
        error: 'You have already applied to this group.',
      }
    }

    // Fetch fee config for position
    const durationMonthsMap: Record<string, number> = {
      FOUR_MONTHS: 4,
      SIX_MONTHS: 6,
      TWELVE_MONTHS: 12,
    }
    const months = durationMonthsMap[group.duration]
    const feeConfig = await prisma.ajoFeeConfig.findUnique({
      where: {
        durationMonths_pickPosition: {
          durationMonths: months,
          pickPosition: formData.payoutPosition,
        },
      },
    })

    const feePercentage = feeConfig ? Number(feeConfig.feePercentage) : 0
    const totalExpectedPayout =
      Number(group.contributionAmount) * group.totalSlots
    const feeAmount = (totalExpectedPayout * feePercentage) / 100
    const netPayoutAmount = totalExpectedPayout - feeAmount

    const newMember = await prisma.eAjoMember.create({
      data: {
        groupId,
        userId: targetUserId,
        payoutPosition: formData.payoutPosition,
        feePercentage,
        feeAmount,
        totalExpectedPayout,
        netPayoutAmount,
        guarantorName: formData.guarantorName,
        guarantorPhoneNumber: formData.guarantorPhoneNumber,
        bankName: formData.bankName,
        accountNumber: formData.accountNumber,
        accountName: formData.accountName,
        status: EAjoMemberStatus.PENDING,
      },
    })

    try {
      revalidatePath(`/dashboard/${targetUserId}/eajo`)
    } catch {}

    return {
      success: true,
      data: serializeMember(newMember),
    }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error applying to eAjo group:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to apply to group.',
    }
  }
}

/**
 * User submits a contribution receipt for their eAjo membership
 */
export const submitEAjoContributionAction = async (
  userId: string,
  eAjoMemberId: string,
  amount: number,
  receiptUrl: string,
  referenceNumber?: string,
  notes?: string,
) => {
  try {
    const actor = await requireMemberOrStaffWithPermission(userId, [
      AdminPermission.EAJO_MANAGE,
      AdminPermission.EAJO_PAYMENTS_REVIEW,
    ])
    const targetUserId =
      actor.role === UserRole.USER ? actor.id : userId

    await assertTargetUserIsMember(targetUserId)

    // Verify membership record belongs to targetUserId
    const membership = await prisma.eAjoMember.findFirst({
      where: { id: eAjoMemberId, userId: targetUserId },
    })
    if (!membership) {
      return { success: false, error: 'Ajo membership record not found.' }
    }
    if (
      membership.status !== EAjoMemberStatus.ACTIVE &&
      membership.status !== EAjoMemberStatus.APPROVED
    ) {
      return { success: false, error: 'Your membership is not yet active.' }
    }

    const newTransaction = await prisma.transaction.create({
      data: {
        userId: targetUserId,
        amount,
        category: TransactionCategory.AJO_CONTRIBUTION,
        type: TransactionType.DEPOSIT,
        status: TransactionStatus.PENDING,
        eAjoMemberId,
        receiptUrl,
        referenceNumber,
        notes,
        recordedBy: actor.id,
      },
    })

    await bindStoredFileToRecord({
      fileUrl: receiptUrl,
      ownerUserId: targetUserId,
      associatedType: 'TRANSACTION',
      associatedId: newTransaction.id,
    })

    try {
      revalidatePath(`/dashboard/${targetUserId}/eajo`)
      revalidatePath(`/dashboard/${targetUserId}`)
    } catch {}

    return {
      success: true,
      data: serializeTransaction(newTransaction),
    }
  } catch (error) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error submitting contribution receipt:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to submit contribution receipt.',
    }
  }
}

/**
 * Uploads a receipt or verification file strictly to Cloudinary and returns its controlled access URL.
 * Requires an authenticated session and validates size (<= 5 MB), format, and magic-byte signature.
 */
export const uploadReceiptAction = async (formData: FormData) => {
  try {
    const actor = await requireAuthenticatedSession()

    if (formData.has('folder')) {
      return {
        success: false,
        error: 'Client-specified storage folders are not permitted.',
      }
    }

    const rawPurpose = formData.get('purpose')
    let purpose: StoredFilePurpose = 'receipts'
    if (rawPurpose !== null && rawPurpose !== '') {
      if (!isStoredFilePurpose(rawPurpose)) {
        return {
          success: false,
          error: 'Invalid file storage purpose.',
        }
      }
      purpose = rawPurpose
    }

    const file = formData.get('file') as File | null
    if (!file || typeof file.arrayBuffer !== 'function') {
      return { success: false, error: 'No file uploaded' }
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const uploadResult = await uploadReceipt(buffer, file.name, {
      purpose,
      declaredMimeType: file.type,
      uploadedById: actor.id,
      ownerUserId: actor.id,
    })

    return {
      success: true,
      url: uploadResult.url,
      fileId: uploadResult.fileId,
      publicId: uploadResult.publicId,
    }
  } catch (error) {
    if (
      error instanceof AuthzError ||
      error instanceof FileValidationError
    ) {
      return { success: false, error: error.message }
    }
    if (
      error instanceof StorageConfigError ||
      error instanceof StorageUploadError
    ) {
      return {
        success: false,
        error: 'Unable to upload file right now. Please try again later.',
      }
    }
    console.error('File upload action error:', error)
    return {
      success: false,
      error: 'Unable to upload receipt file.',
    }
  }
}
