import { BrevoClient } from '@getbrevo/brevo'
import { getRequiredEnv } from '@/lib/env'

let client: BrevoClient | undefined

/**
 * Created on first use, not at import time: `next build` evaluates every page's
 * modules while collecting page data, so reading `BREVO_API_KEY` at import made
 * the build fail wherever the key is not set (e.g. preview deployments).
 * A missing key now only fails the send, which `sendEmail` records as FAILED.
 */
export const getBrevoClient = (): BrevoClient => {
  client ??= new BrevoClient({ apiKey: getRequiredEnv('BREVO_API_KEY') })
  return client
}
