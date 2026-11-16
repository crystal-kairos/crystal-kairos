'use server'

import { prisma } from '@/lib/prisma'
import {
  resend,
  getEmailFrom,
  getEmailReplyTo,
  redactErrorMessage,
} from '../providers/resend.provider'
import { SendEmailOptions, SendEmailResult } from '../types'
import { EmailDeliveryError } from '../errors'
import {
  NotificationChannel,
  NotificationStatus,
} from '@/generated/prisma/enums'
import type { Prisma } from '@/generated/prisma/client'

/**
 * Sends a transactional email to a single recipient.
 * Ensures an internal notification record exists prior to dispatch,
 * protects retries with stable idempotency keys, and keeps provider errors redacted.
 */
async function sendSingleRecipientEmail(
  options: Omit<SendEmailOptions, 'to'> & { to: string },
): Promise<SendEmailResult> {
  const {
    to,
    subject,
    html,
    recipientId,
    type,
    templateId,
    variables,
    triggeredBy,
    notificationId,
    throwOnError,
  } = options

  let notification

  if (notificationId) {
    notification = await prisma.notification.findUnique({
      where: { id: notificationId },
    })

    if (!notification) {
      const errorMsg = `Notification record ${notificationId} not found for retry.`
      if (throwOnError) {
        throw new EmailDeliveryError('NOTIFICATION_NOT_FOUND', errorMsg)
      }
      return { success: false, error: errorMsg }
    }

    // If already sent or delivered, do not re-send
    if (
      notification.status === NotificationStatus.SENT ||
      notification.status === NotificationStatus.DELIVERED ||
      notification.status === NotificationStatus.READ
    ) {
      return {
        success: true,
        notificationId: notification.id,
        externalId: notification.externalId ?? undefined,
      }
    }
  } else {
    // 1. Create notification record as PENDING before provider call
    notification = await prisma.notification.create({
      data: {
        type,
        channel: NotificationChannel.EMAIL,
        status: NotificationStatus.PENDING,
        recipientId,
        subject,
        body: html,
        templateId,
        variables: variables ? (variables as Prisma.InputJsonValue) : undefined,
        triggeredBy,
      },
    })
  }

  // 2. Stable idempotency key derived from authoritative DB notification ID
  const idempotencyKey = `notification/${notification.id}`

  try {
    const from = getEmailFrom()
    const replyTo = getEmailReplyTo()

    const { data, error } = await resend.emails.send(
      {
        from,
        to: [to],
        replyTo,
        subject,
        html,
      },
      { idempotencyKey },
    )

    if (error) {
      const safeErrorMsg = redactErrorMessage(error.message)
      await prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: NotificationStatus.FAILED,
          errorMsg: safeErrorMsg,
        },
      })

      if (throwOnError) {
        throw new EmailDeliveryError('RESEND_SEND_FAILED', safeErrorMsg)
      }

      return {
        success: false,
        notificationId: notification.id,
        error: safeErrorMsg,
      }
    }

    // 3. Update status to SENT (not DELIVERED; delivery is confirmed by webhook/reconciliation)
    await prisma.notification.update({
      where: { id: notification.id },
      data: {
        status: NotificationStatus.SENT,
        externalId: data?.id,
        sentAt: new Date(),
        errorMsg: null,
      },
    })

    return {
      success: true,
      notificationId: notification.id,
      externalId: data?.id,
    }
  } catch (error) {
    if (error instanceof EmailDeliveryError && throwOnError) {
      throw error
    }

    const rawMessage = error instanceof Error ? error.message : String(error)
    const safeErrorMsg = redactErrorMessage(rawMessage)

    await prisma.notification.update({
      where: { id: notification.id },
      data: {
        status: NotificationStatus.FAILED,
        errorMsg: safeErrorMsg,
      },
    })

    if (throwOnError) {
      throw new EmailDeliveryError('RESEND_SEND_FAILED', safeErrorMsg, error)
    }

    return {
      success: false,
      notificationId: notification.id,
      error: safeErrorMsg,
    }
  }
}

/**
 * Public transactional email entry point.
 * Creates one delivery record per recipient and dispatches via Resend.
 */
export const sendEmail = async (
  options: SendEmailOptions,
): Promise<SendEmailResult> => {
  const { to, ...rest } = options

  if (Array.isArray(to)) {
    if (to.length === 0) {
      return { success: true, notificationIds: [] }
    }

    if (to.length === 1) {
      return sendSingleRecipientEmail({ ...rest, to: to[0] })
    }

    const results: SendEmailResult[] = []
    for (const recipientEmail of to) {
      const res = await sendSingleRecipientEmail({
        ...rest,
        to: recipientEmail,
      })
      results.push(res)
    }

    const allSucceeded = results.every((r) => r.success)
    const notificationIds = results
      .map((r) => r.notificationId)
      .filter((id): id is string => Boolean(id))

    return {
      success: allSucceeded,
      notificationIds,
      error: allSucceeded ? undefined : results.find((r) => !r.success)?.error,
    }
  }

  return sendSingleRecipientEmail({ ...rest, to })
}

/**
 * Retries dispatching an existing notification record using its stable idempotency key.
 */
export const retryNotification = async (
  notificationId: string,
): Promise<SendEmailResult> => {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    include: { recipient: true },
  })

  if (!notification) {
    return {
      success: false,
      error: `Notification ${notificationId} not found`,
    }
  }

  const recipientEmail = notification.recipient.email
  if (!recipientEmail) {
    return {
      success: false,
      error: `Recipient has no email address`,
    }
  }

  return sendSingleRecipientEmail({
    to: recipientEmail,
    subject: notification.subject ?? 'Notification',
    html: notification.body,
    recipientId: notification.recipientId,
    type: notification.type,
    templateId: notification.templateId ?? undefined,
    triggeredBy: notification.triggeredBy ?? undefined,
    notificationId: notification.id,
  })
}
