import { SavingsFrequency, SavingsType } from '@/generated/prisma/enums'

// Seeded subscriptions are PENDING (awaiting a first deposit, D-08): no schedule or dates yet.
export const savings = [
  {
    savingsType: SavingsType.REGULAR,
    targetAmount: 10000,
    frequency: SavingsFrequency.MONTHLY,
    durationMonths: 12,
    ratePercentSnapshot: 10.5,
  },
  {
    savingsType: SavingsType.FIXED,
    targetAmount: 100000,
    frequency: SavingsFrequency.ONCE,
    durationMonths: 6,
    ratePercentSnapshot: 12,
  },
  {
    savingsType: SavingsType.STAGGERED,
    targetAmount: null,
    frequency: SavingsFrequency.ONCE,
    durationMonths: 3,
    ratePercentSnapshot: 3,
  },
]
