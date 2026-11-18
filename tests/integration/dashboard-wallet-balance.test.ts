import { afterAll, describe, expect, it, vi } from 'vitest'

const mockSessionHolder: { session: unknown } = { session: null }

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => mockSessionHolder.session),
}))

vi.mock('@/models/members/actions', () => ({
  getSessionHelper: vi.fn(async () => mockSessionHolder.session),
}))

import { prisma } from '@/lib/prisma'
import { UserRole } from '@/generated/prisma/client'
import { lagosToday } from '@/lib/domain/dates'
import { postWalletCredit } from '@/lib/services/ledger.service'
import { getUserLedgerBalances } from '@/models/transactions/actions'

/**
 * The member dashboard's wallet card reads `getUserLedgerBalances`. The wallet lives in the journal
 * (P2-03/P3-06); the legacy WALLET_TOPUP/WALLET_WITHDRAWAL transactions are no longer written, so the
 * card showed ₦0 for members with wallet money.
 */
describe('Dashboard wallet balance (journal wallet)', () => {
  const prefix = `dashwallet_${Date.now()}`

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('reports the journal wallet balance to the member', async () => {
    const member = await prisma.user.create({
      data: {
        email: `${prefix}@example.test`,
        username: prefix,
        name: 'Dashboard Wallet Member',
        role: UserRole.USER,
        isActive: true,
      },
    })
    mockSessionHolder.session = {
      user: { id: member.id, email: member.email, name: member.name, role: member.role, sessionVersion: 0 },
    }

    const before = await getUserLedgerBalances(member.id)
    expect(before.success).toBe(true)
    expect(before.data?.generalWalletBalance).toBe(0)
    expect(before.data?.availableWallet).toBe(0)

    await prisma.$transaction((tx) =>
      postWalletCredit(tx, {
        amount: 5000,
        memberId: member.id,
        effectiveDate: new Date(`${lagosToday()}T00:00:00Z`),
        idempotencyKey: `${prefix}-credit`,
      }),
    )

    const after = await getUserLedgerBalances(member.id)
    expect(after.success).toBe(true)
    expect(after.data?.generalWalletBalance).toBe(5000)
    expect(after.data?.availableWallet).toBe(5000)
    expect(after.data?.heldBalance).toBe(0)
  })

  it('does not show another member their wallet', async () => {
    const [a, b] = await Promise.all(
      ['a', 'b'].map((t) =>
        prisma.user.create({
          data: {
            email: `${prefix}_${t}@example.test`,
            username: `${prefix}_${t}`,
            name: `Member ${t}`,
            role: UserRole.USER,
            isActive: true,
          },
        }),
      ),
    )
    mockSessionHolder.session = {
      user: { id: a.id, email: a.email, name: a.name, role: a.role, sessionVersion: 0 },
    }
    const res = await getUserLedgerBalances(b.id)
    expect(res.success).toBe(false)
  })
})
