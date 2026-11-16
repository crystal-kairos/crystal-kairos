import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { resend, redactErrorMessage } from '@/features/notification/providers/resend.provider'
import { NotificationStatus } from '@/generated/prisma/enums'
import type { WebhookEventPayload } from 'resend'

/**
 * Resend Signed Delivery Webhooks Handler
 * 
 * Verifies request signature using the official Resend verifier with RESEND_WEBHOOK_SECRET,
 * ignores replayed/duplicate events, updates notification delivery statuses without
 * overwriting progressive history, and records audit trail.
 */
export async function POST(req: NextRequest) {
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET
  if (!webhookSecret) {
    return NextResponse.json(
      { error: 'Webhook secret not configured' },
      { status: 500 },
    )
  }

  // Svix / Standard Webhook headers
  const id = req.headers.get('svix-id') || req.headers.get('webhook-id') || ''
  const timestamp =
    req.headers.get('svix-timestamp') ||
    req.headers.get('webhook-timestamp') ||
    ''
  const signature =
    req.headers.get('svix-signature') ||
    req.headers.get('webhook-signature') ||
    ''

  if (!id || !timestamp || !signature) {
    return NextResponse.json(
      { error: 'Missing required webhook signature headers' },
      { status: 400 },
    )
  }

  // Read raw request body string for cryptographic signature verification
  const rawBody = await req.text()

  let event: WebhookEventPayload
  try {
    event = resend.webhooks.verify({
      payload: rawBody,
      headers: { id, timestamp, signature },
      webhookSecret,
    })
  } catch (err) {
    return NextResponse.json(
      {
        error: 'Invalid webhook signature',
        details: err instanceof Error ? err.message : 'Verification failed',
      },
      { status: 400 },
    )
  }

  // Idempotency: Deduplicate by webhook-id (svix-id / webhook-id header, checked above)
  const webhookId = id

  if (webhookId) {
    const alreadyProcessed = await prisma.auditEvent.findFirst({
      where: {
        action: 'RESEND_WEBHOOK_PROCESSED',
        entityType: 'ResendWebhook',
        entityId: webhookId,
      },
    })

    if (alreadyProcessed) {
      return NextResponse.json({ ok: true, duplicate: true })
    }
  }

  const eventType: string = event.type
  // Only email.* events carry an email_id; contact/domain/inbox events are ignored.
  const emailId =
    event.data && 'email_id' in event.data && typeof event.data.email_id === 'string'
      ? event.data.email_id
      : undefined

  if (emailId) {
    const notification = await prisma.notification.findFirst({
      where: { externalId: emailId },
    })

    if (notification) {
      const eventDate = event.created_at
        ? new Date(event.created_at)
        : new Date()

      switch (eventType) {
        case 'email.sent':
          if (notification.status === NotificationStatus.PENDING) {
            await prisma.notification.update({
              where: { id: notification.id },
              data: {
                status: NotificationStatus.SENT,
                sentAt: notification.sentAt ?? eventDate,
              },
            })
          }
          break

        case 'email.delivered':
          if (
            notification.status === NotificationStatus.PENDING ||
            notification.status === NotificationStatus.SENT
          ) {
            await prisma.notification.update({
              where: { id: notification.id },
              data: {
                status: NotificationStatus.DELIVERED,
                deliveredAt: eventDate,
              },
            })
          }
          break

        case 'email.opened':
        case 'email.clicked':
          if (
            notification.status === NotificationStatus.SENT ||
            notification.status === NotificationStatus.DELIVERED
          ) {
            await prisma.notification.update({
              where: { id: notification.id },
              data: {
                status: NotificationStatus.READ,
                readAt: notification.readAt ?? eventDate,
              },
            })
          }
          break

        case 'email.bounced':
        case 'email.failed':
        case 'email.suppressed':
        case 'email.complained':
          await prisma.notification.update({
            where: { id: notification.id },
            data: {
              status: NotificationStatus.FAILED,
              errorMsg: redactErrorMessage(`Provider event: ${eventType}`),
            },
          })
          break

        default:
          break
      }
    }
  }

  // Record audit event to prevent future replays of this webhook ID
  if (webhookId) {
    await prisma.auditEvent.create({
      data: {
        action: 'RESEND_WEBHOOK_PROCESSED',
        entityType: 'ResendWebhook',
        entityId: webhookId,
        metadata: {
          eventType,
          emailId: emailId ?? null,
        },
      },
    })
  }

  return NextResponse.json({ ok: true, processed: true })
}
