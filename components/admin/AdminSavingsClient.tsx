'use client'

import { useState } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusPill } from '@/components/ui/StatusPill'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MoreHorizontal, Plus, Search, Check, X, Edit, Eye, ShieldCheck, Lock, PiggyBank, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { toggleSavingsProductStatusAction } from '@/models/admin/savingsActions'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import * as LucideIcons from 'lucide-react'

interface SavingsProduct {
  id: string
  type: string
  title: string
  description: string
  rates: string
  badge: string
  icon: string
  isActive: boolean
  createdAt: Date
  createdByUser: { name: string; email: string }
}

interface UserSavings {
  id: string
  savingsType: string
  status: string
  targetAmount: number | null
  currentBalance: number
  totalDeposited: number
  accruedInterest: number
  createdAt: Date
  user: { name: string; email: string; username: string }
}

interface AdminSavingsClientProps {
  products: SavingsProduct[]
  userSavings: UserSavings[]
}

const getIcon = (name: string) => {
  const IconComponent = (LucideIcons as any)[name]
  return IconComponent ? <IconComponent className='w-4 h-4' /> : <PiggyBank className='w-4 h-4' />
}

export const AdminSavingsClient = ({ products, userSavings }: AdminSavingsClientProps) => {
  const [searchTerm, setSearchTerm] = useState('')
  const router = useRouter()

  const filteredUserSavings = userSavings.filter(
    (s) =>
      s.user.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.user.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.savingsType.toLowerCase().includes(searchTerm.toLowerCase()),
  )

  const handleToggleProduct = async (id: string, isActive: boolean) => {
    toast.promise(toggleSavingsProductStatusAction(id, isActive), {
      loading: isActive ? 'Activating product...' : 'Deactivating product...',
      success: () => {
        router.refresh()
        return `Product successfully ${isActive ? 'activated' : 'deactivated'}`
      },
      error: 'Failed to update product status',
    })
  }

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 0,
    }).format(val)
  }

  return (
    <div className='flex flex-col gap-6 w-full max-w-7xl mx-auto'>
      <header className='flex flex-col md:flex-row md:items-center justify-between gap-4'>
        <div>
          <h2 className='text-2xl font-bold font-heading text-primary leading-tight'>
            Savings Management
          </h2>
          <p className='text-muted-foreground text-sm mt-1'>
            Manage available savings products and oversee all user savings accounts.
          </p>
        </div>
      </header>

      <Tabs defaultValue='user-savings' className='w-full'>
        <TabsList className='grid w-full md:w-[400px] grid-cols-2 bg-surface-container'>
          <TabsTrigger value='user-savings'>User Savings</TabsTrigger>
          <TabsTrigger value='products'>Savings Products</TabsTrigger>
        </TabsList>

        <TabsContent value='user-savings' className='mt-6'>
          <Card className='border border-outline-variant/30 shadow-none p-4 rounded-xl'>
            <div className='flex items-center gap-2 bg-surface-container/50 px-3 py-2 rounded-lg mb-4 max-w-sm border border-outline-variant/30 focus-within:ring-2 focus-within:ring-primary/20 transition-all'>
              <Search className='w-4 h-4 text-muted-foreground shrink-0' />
              <Input
                placeholder='Search by member name, email or type...'
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className='border-0 bg-transparent shadow-none h-8 p-0 focus-visible:ring-0 placeholder:text-muted-foreground text-sm'
              />
            </div>

            <div className='rounded-md border border-outline-variant/30 overflow-hidden'>
              <Table>
                <TableHeader className='bg-surface-container/30'>
                  <TableRow className='hover:bg-transparent'>
                    <TableHead className='font-semibold'>Member</TableHead>
                    <TableHead className='font-semibold'>Type</TableHead>
                    <TableHead className='font-semibold'>Balance</TableHead>
                    <TableHead className='font-semibold'>Interest</TableHead>
                    <TableHead className='font-semibold'>Status</TableHead>
                    <TableHead className='font-semibold text-right'>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredUserSavings.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className='text-center py-8 text-muted-foreground'>
                        No user savings found.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredUserSavings.map((savings) => (
                      <TableRow key={savings.id} className='hover:bg-surface-container-low transition-colors'>
                        <TableCell>
                          <div className='flex flex-col'>
                            <span className='font-bold text-primary text-sm'>{savings.user.name}</span>
                            <span className='text-xs text-muted-foreground'>{savings.user.email}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className='px-2 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold uppercase tracking-wider'>
                            {savings.savingsType}
                          </span>
                        </TableCell>
                        <TableCell className='font-mono font-semibold'>
                          {formatCurrency(savings.currentBalance)}
                        </TableCell>
                        <TableCell className='font-mono text-success-green'>
                          +{formatCurrency(savings.accruedInterest)}
                        </TableCell>
                        <TableCell>
                          <StatusPill status={savings.status} />
                        </TableCell>
                        <TableCell className='text-right'>
                          <Button variant='ghost' size='sm' className='text-muted-foreground hover:text-primary'>
                            <Eye className='w-4 h-4' />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value='products' className='mt-6'>
          <Card className='border border-outline-variant/30 shadow-none p-4 rounded-xl'>
            <div className='flex justify-between items-center mb-4'>
              <h3 className='font-bold text-primary'>Configured Products</h3>
              <Button asChild size='sm' className='h-9'>
                <Link href='/admin/savings/new'>
                  <Plus className='w-4 h-4 mr-1.5' /> New Product
                </Link>
              </Button>
            </div>

            <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'>
              {products.length === 0 ? (
                <div className='col-span-full py-12 text-center text-muted-foreground border border-dashed rounded-lg bg-surface-container/30'>
                  No savings products configured yet.
                </div>
              ) : (
                products.map((product) => (
                  <Card key={product.id} className='bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant/20 p-5 flex flex-col justify-between hover:shadow-md transition-all'>
                    <div>
                      <div className='flex justify-between items-start mb-3'>
                        <div className='w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0'>
                          {getIcon(product.icon)}
                        </div>
                        <div className='flex items-center gap-2'>
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${product.isActive ? 'bg-success-green/10 text-success-green' : 'bg-outline-variant/20 text-muted-foreground'}`}>
                            {product.isActive ? 'Active' : 'Inactive'}
                          </span>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant='ghost' size='icon' className='h-8 w-8 text-muted-foreground hover:text-primary'>
                                <MoreHorizontal className='w-4 h-4' />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align='end' className='w-40'>
                              <DropdownMenuItem asChild className='cursor-pointer'>
                                <Link href={`/admin/savings/${product.id}/edit`}>
                                  <Edit className='w-4 h-4 mr-2' /> Edit
                                </Link>
                              </DropdownMenuItem>
                              {product.isActive ? (
                                <DropdownMenuItem className='cursor-pointer text-error focus:text-error' onClick={() => handleToggleProduct(product.id, false)}>
                                  <X className='w-4 h-4 mr-2' /> Deactivate
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem className='cursor-pointer text-success-green focus:text-success-green' onClick={() => handleToggleProduct(product.id, true)}>
                                  <Check className='w-4 h-4 mr-2' /> Activate
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>

                      <h4 className='font-bold text-primary text-lg'>{product.title}</h4>
                      <p className='text-muted-foreground text-xs mt-1 leading-relaxed'>{product.description}</p>
                      
                      <div className='flex flex-col gap-1.5 mt-4 text-xs bg-surface-container/50 p-3 rounded-lg border border-outline-variant/20'>
                        <div className='flex justify-between'>
                          <span className='text-muted-foreground font-medium'>Type</span>
                          <span className='font-bold text-primary'>{product.type}</span>
                        </div>
                        <div className='flex justify-between'>
                          <span className='text-muted-foreground font-medium'>Rates</span>
                          <span className='font-bold text-success-green'>{product.rates}</span>
                        </div>
                      </div>
                    </div>
                  </Card>
                ))
              )}
            </div>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
