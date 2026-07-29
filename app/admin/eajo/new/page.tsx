import NewEAjoClient from '@/components/admin/eajo/NewEAjoClient'
import { Metadata } from 'next'
import { prisma } from '@/lib/prisma'
import { EAjoStatus } from '@/generated/prisma/enums'

export const metadata: Metadata = {
  title: 'Add Member to eAjo | Crystal Kairos Admin',
}

export default async function NewEAjoPage() {
  const groups = await prisma.eAjoGroup.findMany({
    where: { 
      status: { in: [EAjoStatus.PENDING, EAjoStatus.ACTIVE] }
    },
    select: { 
      id: true, 
      contributionAmount: true, 
      frequency: true, 
      totalSlots: true 
    }
  })

  return <NewEAjoClient groups={groups} />
}
