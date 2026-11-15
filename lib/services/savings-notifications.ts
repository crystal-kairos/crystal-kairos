/**
 * Best-effort member notices for savings workflows (P3-03). Uses only the public API of
 * features/notification (P4-02 replaces its internals). Called after the transaction commits;
 * a delivery failure never undoes the financial change.
 */
import { prisma } from '@/lib/prisma'
import { NotificationEventType } from '@/generated/prisma/enums'
import { sendEmail } from '@/features/notification'
import type { SavingsNotice } from '@/lib/services/savings.service'

export type SavingsNotifier = (notice: SavingsNotice) => Promise<void>

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

export const emailSavingsNotice: SavingsNotifier = async (notice) => {
  try {
    const member = await prisma.user.findUnique({
      where: { id: notice.memberId },
      select: { email: true, name: true },
    })
    if (!member?.email) return
    await sendEmail({
      to: member.email,
      subject: notice.subject,
      html: `<p>Dear ${escapeHtml(member.name)},</p><p>${escapeHtml(notice.message)}</p><p>Crystal Kairos</p>`,
      recipientId: notice.memberId,
      type: NotificationEventType.CUSTOM,
      triggeredBy: 'savings-job',
    })
  } catch (error) {
    console.error('Savings notice could not be sent', { memberId: notice.memberId, subject: notice.subject, error: (error as Error)?.message })
  }
}

export async function deliverSavingsNotices(notices: SavingsNotice[], notify: SavingsNotifier = emailSavingsNotice) {
  for (const n of notices) await notify(n)
}
