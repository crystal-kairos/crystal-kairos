'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { AdminPermission, EAjoMemberStatus, TransactionCategory, TransactionStatus, TransactionType } from '@/generated/prisma/enums'
import { Prisma } from '@/generated/prisma/client'
import { AuthzError, requirePermission } from '@/lib/authz/guards'

export const addMemberToEAjoGroupAction = async (data: {
  userId: string
  groupId: string
  payoutPosition: number
  guarantorName?: string
  guarantorPhoneNumber?: string
  status: EAjoMemberStatus
  receiptUrl?: string
}) => {
  try {
    const actor = await requirePermission(AdminPermission.EAJO_MANAGE)

    const { userId, groupId, payoutPosition, guarantorName, guarantorPhoneNumber, status, receiptUrl } = data

    // 1. Verify Member
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { bankAccounts: true }
    })
    
    if (!user) return { success: false, error: 'Member not found.' }
    if (!user.bankAccounts || user.bankAccounts.length === 0) {
      return { success: false, error: 'Member must have a bank account set up first.' }
    }
    const defaultBank = user.bankAccounts[0]

    // 2. Verify Group
    const group = await prisma.eAjoGroup.findUnique({
      where: { id: groupId },
      include: {
        members: true
      }
    })

    if (!group) return { success: false, error: 'eAjo group not found.' }
    
    // Check if user already in group
    const alreadyMember = group.members.find(m => m.userId === userId)
    if (alreadyMember) return { success: false, error: 'Member is already in this eAjo group.' }

    // Check if position is taken
    const positionTaken = group.members.find(m => m.payoutPosition === payoutPosition)
    if (positionTaken) return { success: false, error: `Payout position ${payoutPosition} is already taken.` }

    // 3. Create Member Record
    const result = await prisma.$transaction(async (tx) => {
      const eajoMember = await tx.eAjoMember.create({
        data: {
          userId,
          groupId,
          payoutPosition,
          status,
          guarantorName: guarantorName || 'N/A',
          guarantorPhoneNumber: guarantorPhoneNumber || 'N/A',
          bankName: defaultBank.bankName,
          accountNumber: defaultBank.accountNumber,
          accountName: defaultBank.accountName,
          totalContributed: new Prisma.Decimal(receiptUrl ? Number(group.contributionAmount) : 0),
        }
      })

      // 4. Optionally create initial contribution transaction
      if (receiptUrl) {
        await tx.transaction.create({
          data: {
            userId,
            amount: group.contributionAmount,
            type: TransactionType.DEPOSIT,
            category: TransactionCategory.AJO_CONTRIBUTION,
            status: TransactionStatus.CONFIRMED,
            eAjoMemberId: eajoMember.id,
            receiptUrl,
            notes: 'Initial eAjo contribution recorded by Admin',
            recordedBy: actor.id,
            processedBy: actor.id,
            processedAt: new Date(),
          }
        })
      }

      return eajoMember
    })

    try {
      revalidatePath('/admin/eajo')
      revalidatePath(`/admin/eajo/${groupId}`)
      revalidatePath(`/dashboard/${userId}/eajo`)
    } catch {}
    
    return { success: true, data: result }
  } catch (error: unknown) {
    if (error instanceof AuthzError) {
      return { success: false, error: error.message }
    }
    console.error('Error adding member to eAjo group:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to add member to eAjo group.' }
  }
}
