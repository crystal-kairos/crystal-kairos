import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getEmailFrom,
  getEmailReplyTo,
  redactErrorMessage,
  setResendClient,
  getResendClient,
} from '@/features/notification/providers/resend.provider'
import { Resend } from 'resend'

describe('Resend Provider Adapter (Unit)', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    setResendClient(null)
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    setResendClient(null)
    process.env = { ...originalEnv }
  })

  describe('getEmailFrom & getEmailReplyTo', () => {
    it('formats RFC 5322 From address with name and address', () => {
      process.env.EMAIL_FROM_NAME = 'Crystal Kairos'
      process.env.EMAIL_FROM_ADDRESS = 'notifications@crystalkairos.com'
      expect(getEmailFrom()).toBe('Crystal Kairos <notifications@crystalkairos.com>')
    })

    it('falls back to EMAIL_FROM if EMAIL_FROM_ADDRESS is not set', () => {
      process.env.EMAIL_FROM_NAME = 'Crystal Kairos'
      delete process.env.EMAIL_FROM_ADDRESS
      process.env.EMAIL_FROM = 'legacy@crystalkairos.com'
      expect(getEmailFrom()).toBe('Crystal Kairos <legacy@crystalkairos.com>')
    })

    it('returns reply-to when configured', () => {
      process.env.EMAIL_REPLY_TO = 'support@crystalkairos.com'
      expect(getEmailReplyTo()).toBe('support@crystalkairos.com')
    })

    it('returns undefined for reply-to when unset', () => {
      delete process.env.EMAIL_REPLY_TO
      expect(getEmailReplyTo()).toBeUndefined()
    })
  })

  describe('redactErrorMessage', () => {
    it('redacts Resend API keys', () => {
      const raw = 'Invalid request using key re_1234567890abcdefABCDEF'
      expect(redactErrorMessage(raw)).toBe('Invalid request using key [REDACTED_API_KEY]')
    })

    it('redacts Bearer tokens and webhook secrets', () => {
      const raw = 'Authorization Bearer eyJhbGciOiJIUzI1NiJ9 and secret whsec_abcdef1234567890=='
      const redacted = redactErrorMessage(raw)
      expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9')
      expect(redacted).not.toContain('whsec_abcdef1234567890==')
      expect(redacted).toContain('Bearer [REDACTED_TOKEN]')
      expect(redacted).toContain('[REDACTED_WEBHOOK_SECRET]')
    })

    it('redacts email addresses to preserve privacy in audit/error logs', () => {
      const raw = 'Failed to deliver message to john.doe@example.com: mailbox unavailable'
      expect(redactErrorMessage(raw)).toBe(
        'Failed to deliver message to [REDACTED_EMAIL]: mailbox unavailable',
      )
    })
  })

  describe('Resend Client Injection', () => {
    it('uses injected client when provided', () => {
      const mockClient = {
        emails: { send: vi.fn() },
      } as unknown as Resend

      setResendClient(mockClient)
      expect(getResendClient()).toBe(mockClient)
    })

    it('instantiates client from RESEND_API_KEY', () => {
      process.env.RESEND_API_KEY = 're_custom_key_123'
      const client = getResendClient()
      expect(client).toBeInstanceOf(Resend)
      expect(client.key).toBe('re_custom_key_123')
    })

    it('throws CONFIGURATION_ERROR in production when RESEND_API_KEY is missing', () => {
      const prevNodeEnv = process.env.NODE_ENV
      const envRef = process.env as Record<string, string | undefined>
      try {
        envRef.NODE_ENV = 'production'
        delete process.env.RESEND_API_KEY
        expect(() => getResendClient()).toThrow(/Missing required environment variable: RESEND_API_KEY/)
      } finally {
        envRef.NODE_ENV = prevNodeEnv
      }
    })
  })
})
