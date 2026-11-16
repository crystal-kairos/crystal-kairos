import { Resend } from 'resend'
import { getOptionalEnv, getRequiredEnv } from '@/lib/env'

let injectedClient: Resend | null = null

/**
 * Injects a custom or mocked Resend client for unit testing.
 * Pass null to restore default environment-based client creation.
 */
export function setResendClient(client: Resend | null): void {
  injectedClient = client
}

/**
 * Returns the active Resend client instance.
 * In non-test environments, throws CONFIGURATION_ERROR if RESEND_API_KEY is missing.
 * In test environments without RESEND_API_KEY, provides a fallback client to prevent import errors.
 */
export function getResendClient(): Resend {
  if (injectedClient) {
    return injectedClient
  }

  const apiKey =
    process.env.RESEND_API_KEY ||
    (process.env.NODE_ENV === 'test' ? 're_mock_test_key_00000000' : '')

  if (!apiKey) {
    return new Resend(getRequiredEnv('RESEND_API_KEY'))
  }

  return new Resend(apiKey)
}

/**
 * Server-only Resend client export.
 * Delegates to the active client through a Proxy to allow dynamic configuration
 * and test mock injection without requiring module reloads.
 */
export const resend: Resend = new Proxy({} as Resend, {
  get(_target, prop, receiver) {
    const client = getResendClient()
    const value = Reflect.get(client, prop, receiver)
    return typeof value === 'function' ? value.bind(client) : value
  },
})

/**
 * Returns the RFC 5322 formatted From sender header (e.g., "Crystal Kairos <notifications@crystalkairos.com>").
 */
export function getEmailFrom(): string {
  const name = getRequiredEnv('EMAIL_FROM_NAME')
  const address = process.env.EMAIL_FROM_ADDRESS || getRequiredEnv('EMAIL_FROM')
  return `${name} <${address}>`
}

/**
 * Returns the optional reply-to address if configured.
 */
export function getEmailReplyTo(): string | undefined {
  return getOptionalEnv('EMAIL_REPLY_TO') || undefined
}

/**
 * Redacts secrets, tokens, API keys and personal data from provider error messages.
 */
export function redactErrorMessage(raw: string): string {
  if (!raw) return 'Unknown delivery error'
  return raw
    .replace(/re_[a-zA-Z0-9_\-]+/g, '[REDACTED_API_KEY]')
    .replace(/Bearer\s+[a-zA-Z0-9_\-.]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/whsec_[a-zA-Z0-9_+=/]+/g, '[REDACTED_WEBHOOK_SECRET]')
    .replace(/apiKey[:=]\s*['"]?[a-zA-Z0-9_\-]+['"]?/gi, 'apiKey=[REDACTED]')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    .slice(0, 500)
}
