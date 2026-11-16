'use server'

import { prisma } from '@/lib/prisma'
import { getRequiredEnv } from '@/lib/env'
import { getBrevoClient } from '../providers/email.provider'
import { SendEmailOptions } from '../types'
import {
  NotificationChannel,
  NotificationStatus,
} from '@/generated/prisma/enums'

export const sendEmail = async (options: SendEmailOptions) => {
  const {
    to,
    subject,
    html,
    recipientId,
    type,
    templateId,
    variables,
    triggeredBy,
  } = options

  // 1. Create notification record as PENDING
  const notification = await prisma.notification.create({
    data: {
      type,
      channel: NotificationChannel.EMAIL,
      status: NotificationStatus.PENDING,
      recipientId,
      subject,
      body: html,
      templateId,
      variables,
      triggeredBy,
    },
  })

  try {
    // 2. Send email via Brevo
    const data = await getBrevoClient().transactionalEmails.sendTransacEmail({
      sender: {
        email: getRequiredEnv('EMAIL_FROM'),
        name: getRequiredEnv('EMAIL_FROM_NAME'),
      },
      to: Array.isArray(to)
        ? to.map((item) => ({ email: item }))
        : [
            {
              email: to,
            },
          ],
      subject,
      htmlContent: html,
    })

    // 3. Update to SENT with Brevo's message ID
    await prisma.notification.update({
      where: { id: notification.id },
      data: {
        status: NotificationStatus.SENT,
        externalId: data.messageId,
        sentAt: new Date(),
      },
    })

    return { success: true, notificationId: notification.id }
  } catch (error) {
    // 4. Log failure
    await prisma.notification.update({
      where: { id: notification.id },
      data: {
        status: NotificationStatus.FAILED,
        errorMsg: error instanceof Error ? error.message : 'Unknown error',
      },
    })
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}
