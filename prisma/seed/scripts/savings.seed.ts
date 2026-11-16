import { prisma } from '@/lib/prisma'
import { randomize } from '@/prisma/utils'
import { savings } from '../data/savings'
import { SavingsStatus } from '@/generated/prisma/enums'
import { Decimal } from '@prisma/client/runtime/index-browser'

export const seedSavings = async (
  users: {
    id: string
    name: string
    bankName: string
    accountNumber: string
    accountName: string
  }[],
) => {
  console.log('🌱 Seeding savings...')
  const neededUsers = randomize({ list: users, total: savings.length })

  await Promise.all(
    savings.map(async (saving, index) => {
      await prisma.savings.create({
        data: {
          userId: neededUsers[index].id,
          savingsType: saving.savingsType,
          targetAmount: saving.targetAmount,
          frequency: saving.frequency,
          durationMonths: saving.durationMonths,
          ratePercentSnapshot: new Decimal(saving.ratePercentSnapshot),
          rateVersionSnapshot: 1,
          currentBalance: new Decimal(0),
          totalDeposited: new Decimal(0),
          status: SavingsStatus.PENDING,
        },
      })
    }),
  )
  console.log('✅ Savings seeded successfully.')
}
