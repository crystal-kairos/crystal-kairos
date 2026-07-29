import NewSavingsClient from '@/components/admin/savings/NewSavingsClient'
import { Metadata } from 'next'
import { prisma } from '@/lib/prisma'

export const metadata: Metadata = {
  title: 'Create Savings Record | Crystal Kairos Admin',
}

export default async function NewSavingsPage() {
  const products = await prisma.savingsProduct.findMany({
    where: { isActive: true },
    select: { id: true, title: true }
  })

  return <NewSavingsClient products={products} />
}
