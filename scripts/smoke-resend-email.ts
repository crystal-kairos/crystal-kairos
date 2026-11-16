/**
 * Manual Email Smoke Test Script (PR P4-01)
 *
 * Usage:
 *   pnpm tsx scripts/smoke-resend-email.ts recipient@example.com
 *
 * NOTE:
 * - This script must NEVER run automatically in CI or production test suites.
 * - It requires a valid RESEND_API_KEY and verified sending domain.
 * - Do not send real member data.
 */

import { sendEmail } from '@/features/notification'
import { NotificationEventType } from '@/generated/prisma/enums'
import { prisma } from '@/lib/prisma'

async function main() {
  const targetEmail = process.argv[2]?.trim()

  if (!targetEmail || !targetEmail.includes('@')) {
    console.error('Usage: pnpm tsx scripts/smoke-resend-email.ts <recipient-email>')
    process.exit(1)
  }

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey || apiKey.startsWith('re_mock') || apiKey.startsWith('re_test')) {
    console.warn('[WARNING] RESEND_API_KEY appears to be unset or a dummy test value.')
    console.warn('Set a live RESEND_API_KEY in your local .env to perform an actual delivery test.')
  }

  // Find or create a temporary smoke test recipient user
  let smokeUser = await prisma.user.findFirst({
    where: { email: targetEmail },
  })

  if (!smokeUser) {
    smokeUser = await prisma.user.findFirst({
      where: { role: 'OWNER' },
    })
  }

  const recipientId = smokeUser?.id || '00000000-0000-4000-8000-000000000001'

  console.log(`[Smoke Test] Sending smoke test email to: ${targetEmail}`)
  console.log(`[Smoke Test] Internal recipient ID: ${recipientId}`)

  const testTimestamp = new Date().toISOString()
  const result = await sendEmail({
    to: targetEmail,
    subject: `Crystal Kairos — Resend Delivery Smoke Test (${testTimestamp})`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #1e3a8a;">Crystal Kairos Transactional Email Smoke Test</h2>
        <p>This is a manual verification message sent via <strong>Resend</strong>.</p>
        <p><strong>Timestamp:</strong> ${testTimestamp}</p>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
        <p style="font-size: 12px; color: #64748b;">Crystal Kairos Cooperative Society &bull; Automated Delivery Smoke Test</p>
      </div>
    `,
    recipientId,
    type: NotificationEventType.CUSTOM,
    triggeredBy: 'manual-smoke-script',
  })

  if (!result.success) {
    console.error('[Smoke Test] FAILED:', result.error)
    process.exit(1)
  }

  console.log('[Smoke Test] SUCCESS!')
  console.log(`[Smoke Test] Notification DB ID: ${result.notificationId}`)
  console.log(`[Smoke Test] Resend External ID: ${result.externalId}`)
  console.log('Check Resend dashboard logs and recipient mailbox (including spam/junk folder).')
}

main()
  .catch((err) => {
    console.error('[Smoke Test] Unexpected error:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
