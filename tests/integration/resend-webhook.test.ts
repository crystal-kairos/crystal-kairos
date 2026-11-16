import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { POST } from '@/app/api/webhooks/resend/route'
import { NextRequest } from 'next/server'
import crypto from 'crypto'
import {
  NotificationChannel,
  NotificationEventType,
  NotificationStatus,
} from '@/generated/prisma/enums'

describe('Resend Delivery Webhooks (Integration)', () => {
  const TEST_WEBHOOK_SECRET = 'whsec_dGVzdHNlY3JldDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI='
  let originalSecret: string | undefined
  let testUser: { id: string; email: string }

  function createSignedHeaders(payload: string, eventId: string) {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const secretBytes = Buffer.from(
      TEST_WEBHOOK_SECRET.replace('whsec_', ''),
      'base64',
    )
    const toSign = `${eventId}.${timestamp}.${payload}`
    const signature = `v1,${crypto.createHmac('sha256', secretBytes).update(toSign).digest('base64')}`

    return {
      'svix-id': eventId,
      'svix-timestamp': timestamp,
      'svix-signature': signature,
      'content-type': 'application/json',
    }
  }

  beforeEach(async () => {
    originalSecret = process.env.RESEND_WEBHOOK_SECRET
    process.env.RESEND_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET

    const uniqueSuffix = Date.now().toString()
    testUser = await prisma.user.create({
      data: {
        email: `webhook-test-${uniqueSuffix}@example.test`,
        name: `Webhook User ${uniqueSuffix}`,
        username: `webhook_user_${uniqueSuffix}`,
      },
      select: { id: true, email: true },
    })
  })

  afterEach(async () => {
    process.env.RESEND_WEBHOOK_SECRET = originalSecret
    if (testUser?.id) {
      await prisma.notification.deleteMany({
        where: { recipientId: testUser.id },
      })
      await prisma.user.deleteMany({
        where: { id: testUser.id },
      })
    }
    await prisma.auditEvent.deleteMany({
      where: { entityType: 'ResendWebhook' },
    })
  })

  it('rejects requests with missing signature headers with 400', async () => {
    const req = new NextRequest('http://localhost:3000/api/webhooks/resend', {
      method: 'POST',
      body: JSON.stringify({ type: 'email.delivered' }),
    })

    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Missing required webhook signature headers')
  })

  it('rejects requests with invalid cryptographic signature with 400', async () => {
    const rawPayload = JSON.stringify({
      type: 'email.delivered',
      data: { email_id: 'fake_123' },
    })

    const req = new NextRequest('http://localhost:3000/api/webhooks/resend', {
      method: 'POST',
      body: rawPayload,
      headers: {
        'svix-id': 'evt_invalid_sig',
        'svix-timestamp': Math.floor(Date.now() / 1000).toString(),
        'svix-signature': 'v1,invalid_signature_base64_string',
        'content-type': 'application/json',
      },
    })

    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Invalid webhook signature')
  })

  it('updates notification status from PENDING to SENT upon receiving email.sent event', async () => {
    const externalId = `re_sent_test_${Date.now()}`
    const notif = await prisma.notification.create({
      data: {
        recipientId: testUser.id,
        channel: NotificationChannel.EMAIL,
        type: NotificationEventType.CUSTOM,
        status: NotificationStatus.PENDING,
        subject: 'Pending Email',
        body: '<p>Hi</p>',
        externalId,
      },
    })

    const payload = JSON.stringify({
      type: 'email.sent',
      created_at: new Date().toISOString(),
      data: { email_id: externalId },
    })
    const eventId = `evt_sent_${Date.now()}`
    const headers = createSignedHeaders(payload, eventId)

    const req = new NextRequest('http://localhost:3000/api/webhooks/resend', {
      method: 'POST',
      body: payload,
      headers,
    })

    const res = await POST(req)
    expect(res.status).toBe(200)

    const updated = await prisma.notification.findUnique({
      where: { id: notif.id },
    })
    expect(updated?.status).toBe(NotificationStatus.SENT)
    expect(updated?.sentAt).toBeInstanceOf(Date)
  })

  it('updates notification status to DELIVERED and sets deliveredAt timestamp', async () => {
    const externalId = `re_delivered_test_${Date.now()}`
    const notif = await prisma.notification.create({
      data: {
        recipientId: testUser.id,
        channel: NotificationChannel.EMAIL,
        type: NotificationEventType.CUSTOM,
        status: NotificationStatus.SENT,
        sentAt: new Date(),
        subject: 'Delivery Test',
        body: '<p>Hi</p>',
        externalId,
      },
    })

    const payload = JSON.stringify({
      type: 'email.delivered',
      created_at: new Date().toISOString(),
      data: { email_id: externalId },
    })
    const eventId = `evt_deliv_${Date.now()}`
    const headers = createSignedHeaders(payload, eventId)

    const req = new NextRequest('http://localhost:3000/api/webhooks/resend', {
      method: 'POST',
      body: payload,
      headers,
    })

    const res = await POST(req)
    expect(res.status).toBe(200)

    const updated = await prisma.notification.findUnique({
      where: { id: notif.id },
    })
    expect(updated?.status).toBe(NotificationStatus.DELIVERED)
    expect(updated?.deliveredAt).toBeInstanceOf(Date)
  })

  it('maintains progressive status history: email.sent does not downgrade a DELIVERED notification', async () => {
    const externalId = `re_nodowngrade_test_${Date.now()}`
    const deliveredAt = new Date()
    const notif = await prisma.notification.create({
      data: {
        recipientId: testUser.id,
        channel: NotificationChannel.EMAIL,
        type: NotificationEventType.CUSTOM,
        status: NotificationStatus.DELIVERED,
        deliveredAt,
        subject: 'Already Delivered',
        body: '<p>Hi</p>',
        externalId,
      },
    })

    const payload = JSON.stringify({
      type: 'email.sent',
      created_at: new Date().toISOString(),
      data: { email_id: externalId },
    })
    const eventId = `evt_late_sent_${Date.now()}`
    const headers = createSignedHeaders(payload, eventId)

    const req = new NextRequest('http://localhost:3000/api/webhooks/resend', {
      method: 'POST',
      body: payload,
      headers,
    })

    const res = await POST(req)
    expect(res.status).toBe(200)

    const updated = await prisma.notification.findUnique({
      where: { id: notif.id },
    })
    expect(updated?.status).toBe(NotificationStatus.DELIVERED)
    expect(updated?.deliveredAt?.getTime()).toBe(deliveredAt.getTime())
  })

  it('updates notification status to FAILED on bounce or failure event', async () => {
    const externalId = `re_bounce_test_${Date.now()}`
    const notif = await prisma.notification.create({
      data: {
        recipientId: testUser.id,
        channel: NotificationChannel.EMAIL,
        type: NotificationEventType.CUSTOM,
        status: NotificationStatus.SENT,
        sentAt: new Date(),
        subject: 'Bounce Test',
        body: '<p>Hi</p>',
        externalId,
      },
    })

    const payload = JSON.stringify({
      type: 'email.bounced',
      created_at: new Date().toISOString(),
      data: { email_id: externalId },
    })
    const eventId = `evt_bounce_${Date.now()}`
    const headers = createSignedHeaders(payload, eventId)

    const req = new NextRequest('http://localhost:3000/api/webhooks/resend', {
      method: 'POST',
      body: payload,
      headers,
    })

    const res = await POST(req)
    expect(res.status).toBe(200)

    const updated = await prisma.notification.findUnique({
      where: { id: notif.id },
    })
    expect(updated?.status).toBe(NotificationStatus.FAILED)
    expect(updated?.errorMsg).toContain('email.bounced')
  })

  it('enforces replay resistance: duplicate webhook-id is ignored and has no second effect', async () => {
    const externalId = `re_replay_test_${Date.now()}`
    const notif = await prisma.notification.create({
      data: {
        recipientId: testUser.id,
        channel: NotificationChannel.EMAIL,
        type: NotificationEventType.CUSTOM,
        status: NotificationStatus.SENT,
        sentAt: new Date(),
        subject: 'Replay Test',
        body: '<p>Hi</p>',
        externalId,
      },
    })

    const payload = JSON.stringify({
      type: 'email.delivered',
      created_at: new Date().toISOString(),
      data: { email_id: externalId },
    })
    const eventId = `evt_replay_${Date.now()}`
    const headers = createSignedHeaders(payload, eventId)

    // First delivery
    const req1 = new NextRequest('http://localhost:3000/api/webhooks/resend', {
      method: 'POST',
      body: payload,
      headers,
    })
    const res1 = await POST(req1)
    expect(res1.status).toBe(200)
    const body1 = await res1.json()
    expect(body1.processed).toBe(true)

    // Second delivery (replay with same svix-id)
    const req2 = new NextRequest('http://localhost:3000/api/webhooks/resend', {
      method: 'POST',
      body: payload,
      headers,
    })
    const res2 = await POST(req2)
    expect(res2.status).toBe(200)
    const body2 = await res2.json()
    expect(body2.duplicate).toBe(true)

    // Verify audit event recorded only once
    const auditCount = await prisma.auditEvent.count({
      where: {
        action: 'RESEND_WEBHOOK_PROCESSED',
        entityId: eventId,
      },
    })
    expect(auditCount).toBe(1)

    const finalNotif = await prisma.notification.findUnique({
      where: { id: notif.id },
    })
    expect(finalNotif?.status).toBe(NotificationStatus.DELIVERED)
  })
})
