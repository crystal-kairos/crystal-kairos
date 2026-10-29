import { describe, expect, it } from 'vitest'
import {
  calculatePaymentAllocation,
  AllocationPeriodItem,
} from '@/lib/services/allocation.service'
import {
  AllocationTargetType,
  PaymentComponentType,
} from '@/generated/prisma/client'

describe('Payment Allocation Waterfall (§2.10, D-13)', () => {
  const memberId = 'member-1'

  it('allocates strictly oldest dueDate first across multiple loan instalments', () => {
    const periods: AllocationPeriodItem[] = [
      {
        periodId: 'instalment-2',
        targetType: 'LOAN',
        targetId: 'loan-1',
        periodNumber: 2,
        dueDate: new Date('2026-03-01'),
        penaltyDue: 0,
        interestDue: 2000,
        principalDue: 10000,
      },
      {
        periodId: 'instalment-1',
        targetType: 'LOAN',
        targetId: 'loan-1',
        periodNumber: 1,
        dueDate: new Date('2026-02-01'),
        penaltyDue: 500,
        interestDue: 2000,
        principalDue: 10000,
      },
    ]

    // Pay ₦10,000: should pay instalment-1 penalty (₦500), instalment-1 interest (₦2000),
    // instalment-1 principal (₦7500), leaving instalment-2 untouched
    const result = calculatePaymentAllocation({
      amount: 10000,
      memberId,
      periods,
    })

    expect(result.allocations).toHaveLength(3)
    expect(result.allocations[0]).toEqual({
      targetType: AllocationTargetType.LOAN,
      targetId: 'loan-1',
      periodId: 'instalment-1',
      componentType: PaymentComponentType.PENALTY,
      amount: 500,
    })
    expect(result.allocations[1]).toEqual({
      targetType: AllocationTargetType.LOAN,
      targetId: 'loan-1',
      periodId: 'instalment-1',
      componentType: PaymentComponentType.INTEREST,
      amount: 2000,
    })
    expect(result.allocations[2]).toEqual({
      targetType: AllocationTargetType.LOAN,
      targetId: 'loan-1',
      periodId: 'instalment-1',
      componentType: PaymentComponentType.PRINCIPAL,
      amount: 7500,
    })
    expect(result.excessToWallet).toBe(0)
    expect(result.totalAllocated).toBe(10000)
  })

  it('within a single period, applies penalty -> interest -> principal', () => {
    const periods: AllocationPeriodItem[] = [
      {
        periodId: 'inst-1',
        targetType: 'LOAN',
        targetId: 'loan-1',
        periodNumber: 1,
        dueDate: new Date('2026-01-15'),
        penaltyDue: 1000,
        interestDue: 3000,
        principalDue: 15000,
      },
    ]

    // Pay ₦2,500: covers full penalty ₦1,000, and partial interest ₦1,500, zero principal
    const result = calculatePaymentAllocation({
      amount: 2500,
      memberId,
      periods,
    })

    expect(result.allocations).toHaveLength(2)
    expect(result.allocations[0].componentType).toBe(PaymentComponentType.PENALTY)
    expect(result.allocations[0].amount).toBe(1000)
    expect(result.allocations[1].componentType).toBe(PaymentComponentType.INTEREST)
    expect(result.allocations[1].amount).toBe(1500)
    expect(result.excessToWallet).toBe(0)
  })

  it('routes any excess amount above selected periods to WALLET_TOPUP (§2.10 rule 3)', () => {
    const periods: AllocationPeriodItem[] = [
      {
        periodId: 'inst-1',
        targetType: 'LOAN',
        targetId: 'loan-1',
        periodNumber: 1,
        dueDate: new Date('2026-01-15'),
        penaltyDue: 0,
        interestDue: 1000,
        principalDue: 4000,
      },
    ]

    // Pay ₦10,000: covers entire period (₦5,000), remaining ₦5,000 goes to wallet
    const result = calculatePaymentAllocation({
      amount: 10000,
      memberId,
      periods,
    })

    expect(result.allocations).toHaveLength(3)
    expect(result.allocations[0].componentType).toBe(PaymentComponentType.INTEREST)
    expect(result.allocations[0].amount).toBe(1000)
    expect(result.allocations[1].componentType).toBe(PaymentComponentType.PRINCIPAL)
    expect(result.allocations[1].amount).toBe(4000)
    expect(result.allocations[2]).toEqual({
      targetType: AllocationTargetType.WALLET,
      targetId: memberId,
      periodId: null,
      componentType: PaymentComponentType.WALLET_TOPUP,
      amount: 5000,
    })
    expect(result.excessToWallet).toBe(5000)
    expect(result.totalAllocated).toBe(10000)
  })

  it('supports savings plans with penalty before principal', () => {
    const periods: AllocationPeriodItem[] = [
      {
        periodId: 'sav-p1',
        targetType: 'SAVINGS',
        targetId: 'savings-plan-1',
        periodNumber: 1,
        dueDate: new Date('2026-02-10'),
        penaltyDue: 500,
        interestDue: 0,
        principalDue: 20000,
      },
    ]

    const result = calculatePaymentAllocation({
      amount: 20500,
      memberId,
      periods,
    })

    expect(result.allocations).toHaveLength(2)
    expect(result.allocations[0].componentType).toBe(PaymentComponentType.PENALTY)
    expect(result.allocations[0].amount).toBe(500)
    expect(result.allocations[1].componentType).toBe(PaymentComponentType.PRINCIPAL)
    expect(result.allocations[1].amount).toBe(20000)
    expect(result.excessToWallet).toBe(0)
  })
})
