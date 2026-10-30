'use client'

import React, { useState } from 'react'
import {
  UserPlus,
  Edit2,
  AlertTriangle,
  Save,
  Coins,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog'
import { createAdminStaffAction } from '@/models/admin/actions'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { AdminPermission } from '@/generated/prisma/enums'
import { AdminPermissionsEditor } from './AdminPermissionsEditor'
import { SocietyBankAccountsManager } from './SocietyBankAccountsManager'
import Link from 'next/link'

interface StaffMember {
  id: string
  name: string
  email: string
  role: string
  lastLoginAt: Date | null
  createdAt: Date
  permissions?: AdminPermission[]
}

interface AdminSettingsClientProps {
  staff: StaffMember[]
  actorRole?: string
}

export const AdminSettingsClient = ({
  staff: initialStaff,
  actorRole = 'ADMIN',
}: AdminSettingsClientProps) => {
  const router = useRouter()
  const isOwner = actorRole === 'OWNER'
  const [activeTab, setActiveTab] = useState<
    'users' | 'permissions' | 'notifications' | 'society-accounts'
  >('users')

  // User Management States
  const [staff, setStaff] = useState<StaffMember[]>(initialStaff)
  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(
    initialStaff.find((s) => s.role === 'ADMIN')?.id ??
      initialStaff[0]?.id ??
      null,
  )
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [newStaffName, setNewStaffName] = useState('')
  const [newStaffEmail, setNewStaffEmail] = useState('')
  const [newStaffPassword, setNewStaffPassword] = useState('')
  const [loading, setLoading] = useState(false)

  // Notification Preferences States
  const [prefs, setPrefs] = useState({
    overdueDisbursements: true,
    systemErrors: true,
    largeLoans: true,
    loanDefaultWarning: false,
  })

  const selectedStaff =
    staff.find((s) => s.id === selectedStaffId) ?? staff[0] ?? null

  const handleAddStaffSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newStaffName || !newStaffEmail) {
      toast.error('Please enter name and email.')
      return
    }

    setLoading(true)
    try {
      const result = await createAdminStaffAction({
        name: newStaffName,
        email: newStaffEmail,
        role: 'ADMIN',
        password: newStaffPassword || undefined,
      })

      if (result.success && result.data) {
        toast.success('Staff member created successfully!')
        setNewStaffName('')
        setNewStaffEmail('')
        setNewStaffPassword('')
        setIsAddDialogOpen(false)
        router.refresh()
      } else {
        toast.error(result.error || 'Failed to create staff member.')
      }
    } catch (err) {
      console.error(err)
      toast.error('Something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  const handleSavePreferences = () => {
    toast.success('System preferences saved successfully!')
  }

  return (
    <div className='flex flex-col gap-6 w-full py-2'>
      {/* Page Header */}
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div>
          <h2 className='text-2xl font-bold font-heading text-primary leading-tight'>
            System Settings
          </h2>
          <p className='text-muted-foreground text-xs mt-1'>
            Manage administrative access, staff permissions, and system-wide
            notifications.
          </p>
        </div>

        <Link
          href='/admin/settings/permissions'
          className='text-xs font-bold text-primary underline flex items-center gap-1'
        >
          <ShieldCheck className='w-4 h-4' />
          <span>Full Permissions Matrix</span>
        </Link>
      </div>

      {/* Tab Navigation */}
      <div className='border-b border-outline-variant/30 flex gap-6 mb-2'>
        <button
          onClick={() => setActiveTab('users')}
          className={`pb-2 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${
            activeTab === 'users'
              ? 'text-primary border-primary'
              : 'text-muted-foreground border-transparent hover:text-primary'
          }`}
        >
          User Management
        </button>
        <button
          onClick={() => setActiveTab('permissions')}
          className={`pb-2 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${
            activeTab === 'permissions'
              ? 'text-primary border-primary'
              : 'text-muted-foreground border-transparent hover:text-primary'
          }`}
        >
          Staff Permissions
        </button>
        <button
          onClick={() => setActiveTab('notifications')}
          className={`pb-2 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${
            activeTab === 'notifications'
              ? 'text-primary border-primary'
              : 'text-muted-foreground border-transparent hover:text-primary'
          }`}
        >
          Notification Preferences
        </button>
        <button
          onClick={() => setActiveTab('society-accounts')}
          className={`pb-2 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${
            activeTab === 'society-accounts'
              ? 'text-primary border-primary'
              : 'text-muted-foreground border-transparent hover:text-primary'
          }`}
        >
          Receiving Accounts
        </button>
      </div>

      {/* Tab Content: User Management */}
      {activeTab === 'users' && (
        <div className='space-y-4 animate-in fade-in duration-200'>
          {/* Action Bar */}
          <div className='flex justify-between items-center'>
            <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
              Admin Staff Directory
            </h3>

            {isOwner && (
              <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
                <DialogTrigger asChild>
                  <Button className='bg-primary text-on-primary text-xs font-bold uppercase tracking-wider px-4 py-2 h-9 rounded-sm flex items-center gap-1.5 cursor-pointer shadow-sm'>
                    <UserPlus className='w-4 h-4' />
                    <span>Add Staff</span>
                  </Button>
                </DialogTrigger>
                <DialogContent className='sm:max-w-106.25'>
                  <form onSubmit={handleAddStaffSubmit}>
                    <DialogHeader>
                      <DialogTitle className='text-primary font-heading font-bold text-base'>
                        Add Admin Staff
                      </DialogTitle>
                      <DialogDescription className='text-xs text-muted-foreground'>
                        Create an administrative staff account. Leave the
                        password blank to send a single-use 24-hour setup link.
                      </DialogDescription>
                    </DialogHeader>

                    <div className='grid gap-4 py-4'>
                      <div className='grid grid-cols-4 items-center gap-4'>
                        <Label
                          htmlFor='name'
                          className='text-right text-xs font-semibold text-primary'
                        >
                          Name
                        </Label>
                        <Input
                          id='name'
                          value={newStaffName}
                          onChange={(e) => setNewStaffName(e.target.value)}
                          placeholder='e.g. Aisha E.'
                          className='col-span-3 text-xs'
                          required
                        />
                      </div>
                      <div className='grid grid-cols-4 items-center gap-4'>
                        <Label
                          htmlFor='email'
                          className='text-right text-xs font-semibold text-primary'
                        >
                          Email
                        </Label>
                        <Input
                          id='email'
                          type='email'
                          value={newStaffEmail}
                          onChange={(e) => setNewStaffEmail(e.target.value)}
                          placeholder='aisha@crystalkairos.coop'
                          className='col-span-3 text-xs'
                          required
                        />
                      </div>
                      <div className='grid grid-cols-4 items-center gap-4'>
                        <Label
                          htmlFor='pass'
                          className='text-right text-xs font-semibold text-primary'
                        >
                          Password
                        </Label>
                        <Input
                          id='pass'
                          type='password'
                          value={newStaffPassword}
                          onChange={(e) => setNewStaffPassword(e.target.value)}
                          placeholder='Optional (sends setup link if blank)'
                          className='col-span-3 text-xs'
                        />
                      </div>
                    </div>

                    <DialogFooter>
                      <Button
                        type='submit'
                        disabled={loading}
                        className='bg-primary text-on-primary text-xs font-bold rounded-sm h-9 px-4'
                      >
                        {loading ? 'Creating...' : 'Create Staff Account'}
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            )}
          </div>

          {/* Directory Table */}
          <Card className='bg-surface-container-lowest rounded-xl shadow-sm border border-outline-variant/10 overflow-hidden'>
            <div className='overflow-x-auto'>
              <table className='w-full text-left border-collapse text-xs'>
                <thead>
                  <tr className='bg-surface-container-low border-b border-outline-variant/20 text-muted-foreground font-bold'>
                    <th className='p-3 uppercase tracking-wider'>
                      Staff Member
                    </th>
                    <th className='p-3 uppercase tracking-wider'>Role</th>
                    <th className='p-3 uppercase tracking-wider'>
                      Granted Permissions
                    </th>
                    <th className='p-3 uppercase tracking-wider'>Status</th>
                    <th className='p-3 uppercase tracking-wider text-right'>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className='divide-y divide-outline-variant/10 text-primary font-medium'>
                  {staff.map((member) => (
                    <tr
                      key={member.id}
                      className='hover:bg-surface-bright transition-colors group'
                    >
                      <td className='p-3'>
                        <div className='flex items-center gap-2'>
                          <div className='w-8 h-8 rounded-full bg-tertiary-fixed text-on-tertiary-fixed flex items-center justify-center font-bold text-xs shrink-0'>
                            {member.name.substring(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <div className='font-semibold text-primary'>
                              {member.name}
                            </div>
                            <div className='text-[10px] text-muted-foreground'>
                              {member.email}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className='p-3'>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
                            member.role === 'OWNER'
                              ? 'bg-primary-fixed text-on-primary-fixed'
                              : 'bg-tertiary-fixed text-on-tertiary-fixed'
                          }`}
                        >
                          {member.role === 'OWNER'
                            ? 'Super Admin (Owner)'
                            : 'Administrator'}
                        </span>
                      </td>
                      <td className='p-3 text-xs text-muted-foreground'>
                        {member.role === 'OWNER'
                          ? 'All permissions'
                          : `${member.permissions?.length ?? 0} granted`}
                      </td>
                      <td className='p-3'>
                        <span className='inline-flex items-center px-2 py-0.5 rounded-full bg-light-green text-success-green text-[9px] font-bold uppercase tracking-wider'>
                          Active
                        </span>
                      </td>
                      <td className='p-3 text-right'>
                        <Button
                          variant='ghost'
                          size='sm'
                          onClick={() => {
                            setSelectedStaffId(member.id)
                            setActiveTab('permissions')
                          }}
                          className='h-7 text-xs text-primary hover:bg-surface-container-high'
                        >
                          <Edit2 className='w-3.5 h-3.5 mr-1' />
                          Permissions
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* Tab Content: Staff Permissions */}
      {activeTab === 'permissions' && (
        <div className='space-y-4 animate-in fade-in duration-200'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='text-xs font-bold text-primary uppercase tracking-wider'>
              Select Staff Member:
            </span>
            {staff.map((member) => (
              <Button
                key={member.id}
                type='button'
                size='sm'
                variant={
                  selectedStaff?.id === member.id ? 'default' : 'outline'
                }
                onClick={() => setSelectedStaffId(member.id)}
                className='text-xs h-8'
              >
                {member.name} ({member.role})
              </Button>
            ))}
          </div>

          {selectedStaff && (
            <AdminPermissionsEditor
              key={selectedStaff.id}
              staffMember={selectedStaff}
              canEdit={isOwner}
              onSaved={(updatedPermissions) => {
                setStaff((prev) =>
                  prev.map((s) =>
                    s.id === selectedStaff.id
                      ? { ...s, permissions: updatedPermissions }
                      : s,
                  ),
                )
              }}
            />
          )}
        </div>
      )}

      {/* Tab Content: Notification Preferences */}
      {activeTab === 'notifications' && (
        <div className='space-y-6 animate-in fade-in duration-200'>
          <div className='grid grid-cols-1 lg:grid-cols-2 gap-6'>
            {/* Section: High Priority */}
            <Card className='bg-surface-container-lowest border border-outline-variant/15 rounded-xl p-5 shadow-sm'>
              <div className='flex items-center gap-2 mb-4 pb-2 border-b border-outline-variant/15'>
                <AlertTriangle className='w-5 h-5 text-warning-amber' />
                <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
                  High-Priority Alerts
                </h3>
              </div>
              <div className='space-y-4'>
                <div className='flex justify-between items-center'>
                  <div>
                    <p className='text-xs font-bold text-primary'>
                      Overdue Disbursements
                    </p>
                    <p className='text-[10px] text-muted-foreground'>
                      Alert when a member payout is delayed by &gt;24h.
                    </p>
                  </div>
                  <label className='relative inline-flex items-center cursor-pointer'>
                    <input
                      type='checkbox'
                      checked={prefs.overdueDisbursements}
                      onChange={(e) =>
                        setPrefs({
                          ...prefs,
                          overdueDisbursements: e.target.checked,
                        })
                      }
                      className='sr-only peer'
                    />
                    <div className="w-9 h-5 bg-surface-variant peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary" />
                  </label>
                </div>
                <div className='flex justify-between items-center'>
                  <div>
                    <p className='text-xs font-bold text-primary'>
                      System Errors
                    </p>
                    <p className='text-[10px] text-muted-foreground'>
                      Critical ledger synchronization failures.
                    </p>
                  </div>
                  <label className='relative inline-flex items-center cursor-pointer'>
                    <input
                      type='checkbox'
                      checked={prefs.systemErrors}
                      onChange={(e) =>
                        setPrefs({ ...prefs, systemErrors: e.target.checked })
                      }
                      className='sr-only peer'
                    />
                    <div className="w-9 h-5 bg-surface-variant peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary" />
                  </label>
                </div>
              </div>
            </Card>

            {/* Section: Loan Activity */}
            <Card className='bg-surface-container-lowest border border-outline-variant/15 rounded-xl p-5 shadow-sm'>
              <div className='flex items-center gap-2 mb-4 pb-2 border-b border-outline-variant/15'>
                <Coins className='w-5 h-5 text-primary' />
                <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
                  Loan Activity
                </h3>
              </div>
              <div className='space-y-4'>
                <div className='flex justify-between items-center'>
                  <div>
                    <p className='text-xs font-bold text-primary'>
                      Large Loan Applications
                    </p>
                    <p className='text-[10px] text-muted-foreground'>
                      Notify on requests exceeding tier thresholds.
                    </p>
                  </div>
                  <label className='relative inline-flex items-center cursor-pointer'>
                    <input
                      type='checkbox'
                      checked={prefs.largeLoans}
                      onChange={(e) =>
                        setPrefs({ ...prefs, largeLoans: e.target.checked })
                      }
                      className='sr-only peer'
                    />
                    <div className="w-9 h-5 bg-surface-variant peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary" />
                  </label>
                </div>
                <div className='flex justify-between items-center'>
                  <div>
                    <p className='text-xs font-bold text-primary'>
                      Loan Default Warning
                    </p>
                    <p className='text-[10px] text-muted-foreground'>
                      3 days prior to status changing to default.
                    </p>
                  </div>
                  <label className='relative inline-flex items-center cursor-pointer'>
                    <input
                      type='checkbox'
                      checked={prefs.loanDefaultWarning}
                      onChange={(e) =>
                        setPrefs({
                          ...prefs,
                          loanDefaultWarning: e.target.checked,
                        })
                      }
                      className='sr-only peer'
                    />
                    <div className="w-9 h-5 bg-surface-variant peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary" />
                  </label>
                </div>
              </div>
            </Card>
          </div>

          <div className='flex justify-end mt-6'>
            <Button
              onClick={handleSavePreferences}
              className='bg-primary text-on-primary text-xs font-bold uppercase tracking-wider px-6 py-2.5 h-10 rounded-sm flex items-center gap-1.5 shadow-md cursor-pointer'
            >
              <Save className='w-4 h-4' />
              <span>Save Preferences</span>
            </Button>
          </div>
        </div>
      )}

      {/* Tab Content: Society Receiving Accounts */}
      {activeTab === 'society-accounts' && (
        <div className='space-y-4 animate-in fade-in duration-200'>
          <SocietyBankAccountsManager />
        </div>
      )}
    </div>
  )
}
export default AdminSettingsClient
