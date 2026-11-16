import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { prisma } from '@/lib/prisma'
import {
  sendEmail,
  retryNotification,
  setResendClient,
  EmailDeliveryError,
} from '@/features/notification'
import {
  NotificationChannel,
  NotificationEventType,
  NotificationStatus,
} from '@/generated/prisma/enums'
import { Resend } from 'resend'

describe('Resend Email Delivery & Idempotency (Integration)', () => {
  let testUser: { id: string; email: string }

  beforeEach(async () => {
    // Clean up notifications from prior tests
    await prisma.notification.deleteMany({
      where: { recipient: { email: { contains: 'resend-test-' } } },
    })

    const uniqueSuffix = Date.now().toString()
    testUser = await prisma.user.create({
      data: {
        email: `resend-test-${uniqueSuffix}@example.test`,
        name: `Resend Test Member ${uniqueSuffix}`,
        username: `resend_user_${uniqueSuffix}`,
      },
      select: { id: true, email: true },
    })
  })

  afterEach(async () => {
    setResendClient(null)
    if (testUser?.id) {
      await prisma.notification.deleteMany({
        where: { recipientId: testUser.id },
      })
      await prisma.user.deleteMany({
        where: { id: testUser.id },
      })
    }
  })

  it('records a PENDING notification in DB, calls Resend with stable idempotencyKey, and updates status to SENT (not DELIVERED)', async () => {
    const sendMock = vi.fn().mockResolvedValue({
      data: { id: 'msg_resend_mock_12345' },
      error: null,
    })

    setResendClient({
      emails: { send: sendMock },
    } as unknown as Resend)

    const result = await sendEmail({
      to: testUser.email,
      subject: 'Welcome to Crystal Kairos',
      html: '<p>Welcome!</p>',
      recipientId: testUser.id,
      type: NotificationEventType.MEMBER_REGISTERED,
    })

    expect(result.success).toBe(true)
    expect(result.notificationId).toBeDefined()
    expect(result.externalId).toBe('msg_resend_mock_12345')

    // Verify DB state
    const record = await prisma.notification.findUnique({
      where: { id: result.notificationId },
    })
    expect(record).not.toBeNull()
    expect(record?.status).toBe(NotificationStatus.SENT)
    expect(record?.channel).toBe(NotificationChannel.EMAIL)
    expect(record?.externalId).toBe('msg_resend_mock_12345')
    expect(record?.sentAt).toBeInstanceOf(Date)
    expect(record?.deliveredAt).toBeNull() // Crucial: must NOT be falsely marked DELIVERED on send
    expect(record?.errorMsg).toBeNull()

    // Verify Resend send call arguments and idempotency key
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: [testUser.email],
        subject: 'Welcome to Crystal Kairos',
        html: '<p>Welcome!</p>',
      }),
      { idempotencyKey: `notification/${result.notificationId}` },
    )
  })

  it('records safe failure state with redacted error when Resend provider returns an error', async () => {
    const sendMock = vi.fn().mockResolvedValue({
      data: null,
      error: {
        message: 'Invalid key re_secret1234567890 for test-user@example.test',
        name: 'validation_error',
      },
    })

    setResendClient({
      emails: { send: sendMock },
    } as unknown as Resend)

    const result = await sendEmail({
      to: testUser.email,
      subject: 'Important Update',
      html: '<p>Update</p>',
      recipientId: testUser.id,
      type: NotificationEventType.CUSTOM,
    })

    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).toContain('[REDACTED_API_KEY]')
    expect(result.error).toContain('[REDACTED_EMAIL]')
    expect(result.error).not.toContain('re_secret1234567890')

    const record = await prisma.notification.findUnique({
      where: { id: result.notificationId },
    })
    expect(record?.status).toBe(NotificationStatus.FAILED)
    expect(record?.externalId).toBeNull()
    expect(record?.errorMsg).toContain('[REDACTED_API_KEY]')
  })

  it('handles provider timeout/network failure safely without throwing when throwOnError is false', async () => {
    const sendMock = vi.fn().mockRejectedValue(new Error('Connection timeout to api.resend.com'))

    setResendClient({
      emails: { send: sendMock },
    } as unknown as Resend)

    const result = await sendEmail({
      to: testUser.email,
      subject: 'Timeout Notice',
      html: '<p>Testing timeout</p>',
      recipientId: testUser.id,
      type: NotificationEventType.CUSTOM,
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Connection timeout to api.resend.com')

    const record = await prisma.notification.findUnique({
      where: { id: result.notificationId },
    })
    expect(record?.status).toBe(NotificationStatus.FAILED)
  })

  it('throws EmailDeliveryError when throwOnError is explicitly enabled', async () => {
    const sendMock = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'Quota exceeded', name: 'rate_limit_error' },
    })

    setResendClient({
      emails: { send: sendMock },
    } as unknown as Resend)

    await expect(
      sendEmail({
        to: testUser.email,
        subject: 'Strict Delivery',
        html: '<p>Strict</p>',
        recipientId: testUser.id,
        type: NotificationEventType.CUSTOM,
        throwOnError: true,
      }),
    ).rejects.toThrow(EmailDeliveryError)
  })

  it('retrying a notification reuses the same DB record and same idempotency key without creating a duplicate', async () => {
    let callCount = 0
    const sendMock = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve({
          data: null,
          error: { message: 'Temporary upstream error', name: 'provider_error' },
        })
      }
      return Promise.resolve({
        data: { id: 'msg_retry_success_999' },
        error: null,
      })
    })

    setResendClient({
      emails: { send: sendMock },
    } as unknown as Resend)

    // First attempt fails
    const initialResult = await sendEmail({
      to: testUser.email,
      subject: 'Retry Test',
      html: '<p>Retry me</p>',
      recipientId: testUser.id,
      type: NotificationEventType.CUSTOM,
    })

    expect(initialResult.success).toBe(false)
    const notificationId = initialResult.notificationId!

    const countBeforeRetry = await prisma.notification.count({
      where: { recipientId: testUser.id },
    })
    expect(countBeforeRetry).toBe(1)

    // Second attempt: retryNotification
    const retryResult = await retryNotification(notificationId)

    expect(retryResult.success).toBe(true)
    expect(retryResult.notificationId).toBe(notificationId)
    expect(retryResult.externalId).toBe('msg_retry_success_999')

    // Must NOT have created a duplicate DB delivery record
    const countAfterRetry = await prisma.notification.count({
      where: { recipientId: testUser.id },
    })
    expect(countAfterRetry).toBe(1)

    // DB record should now be SENT with externalId
    const updated = await prisma.notification.findUnique({
      where: { id: notificationId },
    })
    expect(updated?.status).toBe(NotificationStatus.SENT)
    expect(updated?.externalId).toBe('msg_retry_success_999')

    // Both calls must have used the EXACT SAME idempotency key
    expect(sendMock).toHaveBeenCalledTimes(2)
    expect(sendMock.mock.calls[0][1]).toEqual({
      idempotencyKey: `notification/${notificationId}`,
    })
    expect(sendMock.mock.calls[1][1]).toEqual({
      idempotencyKey: `notification/${notificationId}`,
    })
  })

  it('sending to multiple recipients creates one delivery record per recipient with distinct idempotency keys', async () => {
    const sendMock = vi.fn().mockImplementation((payload) => {
      return Promise.resolve({
        data: { id: `msg_${payload.to[0].replace('@', '_')}` },
        error: null,
      })
    })

    setResendClient({
      emails: { send: sendMock },
    } as unknown as Resend)

    const secondUser = await prisma.user.create({
      data: {
        email: `resend-second-${Date.now()}@example.test`,
        name: 'Second Test Member',
        username: `second_user_${Date.now()}`,
      },
    })

    try {
      const result = await sendEmail({
        to: [testUser.email, secondUser.email],
        subject: 'Broadcast Announcement',
        html: '<p>Broadcast</p>',
        recipientId: testUser.id,
        type: NotificationEventType.CUSTOM,
      })

      expect(result.success).toBe(true)
      expect(result.notificationIds).toHaveLength(2)

      // Verify two distinct records in DB
      const notifs = await prisma.notification.findMany({
        where: { id: { in: result.notificationIds! } },
      })
      expect(notifs).toHaveLength(2)
      expect(notifs[0].id).not.toBe(notifs[1].id)
      expect(notifs[0].status).toBe(NotificationStatus.SENT)
      expect(notifs[1].status).toBe(NotificationStatus.SENT)

      // Provider was called with each distinct idempotency key
      expect(sendMock).toHaveBeenCalledTimes(2)
      expect(sendMock.mock.calls[0][1]).toEqual({
        idempotencyKey: `notification/${notifs[0].id}`,
      })
      expect(sendMock.mock.calls[1][1]).toEqual({
        idempotencyKey: `notification/${notifs[1].id}`,
      })
    } finally {
      await prisma.notification.deleteMany({
        where: { recipientId: secondUser.id },
      })
      await prisma.user.deleteMany({
        where: { id: secondUser.id },
      })
    }
  })
})
