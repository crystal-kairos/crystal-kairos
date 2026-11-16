import { EditSavingsProductClient } from '@/components/admin/EditSavingsProductClient'
import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'

const EditSavingsProductPage = async ({
  params,
}: {
  params: Promise<{ id: string }>
}) => {
  const session = await auth()
  if (!session) {
    redirect('/login')
  }
  if (session.user.role !== 'ADMIN' && session.user.role !== 'OWNER') {
    redirect('/unauthorized')
  }

  const { id } = await params

  const product = await prisma.savingsProduct.findUnique({
    where: { id },
    include: {
      termRates: {
        where: { isActive: true },
        orderBy: { durationMonths: 'asc' },
        select: { durationMonths: true, ratePercent: true },
      },
    },
  })

  if (!product) {
    return <div className='p-12 text-center text-muted-foreground'>Savings Product not found.</div>
  }

  return (
    <div className='p-6 w-full'>
      <EditSavingsProductClient
        product={{
          id: product.id,
          type: product.type,
          title: product.title,
          description: product.description,
          badge: product.badge,
          icon: product.icon,
          termRates: product.termRates.map((t) => ({
            durationMonths: t.durationMonths,
            ratePercent: Number(t.ratePercent),
          })),
        }}
      />
    </div>
  )
}

export default EditSavingsProductPage
