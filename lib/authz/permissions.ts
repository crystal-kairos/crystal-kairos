import { AdminPermission, UserRole } from '@/generated/prisma/enums'

export const ALL_ADMIN_PERMISSIONS: readonly AdminPermission[] = [
  AdminPermission.MEMBERS_READ,
  AdminPermission.MEMBERS_CREATE,
  AdminPermission.MEMBERS_APPROVE,
  AdminPermission.PROFILE_CHANGES_REVIEW,
  AdminPermission.SOCIETY_SETTINGS_MANAGE,
  AdminPermission.SAVINGS_READ,
  AdminPermission.SAVINGS_MANAGE,
  AdminPermission.SAVINGS_PAYMENTS_REVIEW,
  AdminPermission.LOANS_READ,
  AdminPermission.LOANS_REVIEW,
  AdminPermission.LOANS_DISBURSE,
  AdminPermission.LOAN_SETTINGS_MANAGE,
  AdminPermission.GUARANTEES_REVIEW,
  AdminPermission.EAJO_READ,
  AdminPermission.EAJO_MANAGE,
  AdminPermission.EAJO_PAYMENTS_REVIEW,
  AdminPermission.EAJO_PAYOUTS_MANAGE,
  AdminPermission.TRANSACTIONS_READ,
  AdminPermission.TRANSACTIONS_REVIEW,
  AdminPermission.PAYMENTS_REVERSE,
  AdminPermission.WALLET_MANAGE,
  AdminPermission.WALLET_WITHDRAWALS_REVIEW,
  AdminPermission.RECOVERY_MANAGE,
  AdminPermission.RECOVERY_EXECUTE,
  AdminPermission.PENALTY_WAIVE,
  AdminPermission.RECONCILIATION_MANAGE,
  AdminPermission.SETTLEMENTS_MANAGE,
  AdminPermission.POLICY_NOTICES_MANAGE,
  AdminPermission.NOTIFICATIONS_MANAGE,
  AdminPermission.AUDIT_READ,
  AdminPermission.STAFF_MANAGE,
] as const

export interface PermissionMeta {
  permission: AdminPermission
  label: string
  description: string
}

export interface PermissionGroup {
  id: string
  title: string
  permissions: readonly PermissionMeta[]
}

export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    id: 'members',
    title: 'Members & Profiles',
    permissions: [
      {
        permission: AdminPermission.MEMBERS_READ,
        label: 'Read Members',
        description: 'View member directory, profiles, and membership status.',
      },
      {
        permission: AdminPermission.MEMBERS_CREATE,
        label: 'Create Members',
        description: 'Onboard new member accounts and issue setup links.',
      },
      {
        permission: AdminPermission.MEMBERS_APPROVE,
        label: 'Approve / Reject Memberships',
        description: 'Review and approve or reject pending membership applications.',
      },
      {
        permission: AdminPermission.PROFILE_CHANGES_REVIEW,
        label: 'Review Profile Changes',
        description: 'Approve or reject member bank and profile change requests.',
      },
    ],
  },
  {
    id: 'savings',
    title: 'Savings',
    permissions: [
      {
        permission: AdminPermission.SAVINGS_READ,
        label: 'Read Savings',
        description: 'View savings products, plans, and schedules.',
      },
      {
        permission: AdminPermission.SAVINGS_MANAGE,
        label: 'Manage Savings Products',
        description: 'Create and update savings products and member plans.',
      },
      {
        permission: AdminPermission.SAVINGS_PAYMENTS_REVIEW,
        label: 'Review Savings Payments',
        description: 'Confirm or reject savings deposit and withdrawal receipts.',
      },
    ],
  },
  {
    id: 'loans',
    title: 'Loans & Guarantees',
    permissions: [
      {
        permission: AdminPermission.LOANS_READ,
        label: 'Read Loans',
        description: 'View loan applications, schedules, and repayment history.',
      },
      {
        permission: AdminPermission.LOANS_REVIEW,
        label: 'Review & Approve Loans',
        description: 'Approve, amend, or reject loan applications.',
      },
      {
        permission: AdminPermission.LOANS_DISBURSE,
        label: 'Disburse Loans',
        description: 'Execute and record loan disbursements (dual control with review).',
      },
      {
        permission: AdminPermission.LOAN_SETTINGS_MANAGE,
        label: 'Manage Loan Rates & Terms',
        description: 'Configure monthly loan interest rates, daily penalties, and caps.',
      },
      {
        permission: AdminPermission.GUARANTEES_REVIEW,
        label: 'Review Guarantees',
        description: 'Inspect and manage member guarantee requests and reservations.',
      },
    ],
  },
  {
    id: 'eajo',
    title: 'E-Ajo',
    permissions: [
      {
        permission: AdminPermission.EAJO_READ,
        label: 'Read E-Ajo',
        description: 'View e-ajo groups, participants, slots, and funding requirements.',
      },
      {
        permission: AdminPermission.EAJO_MANAGE,
        label: 'Manage E-Ajo Groups',
        description: 'Create, edit, activate groups and approve slot applications.',
      },
      {
        permission: AdminPermission.EAJO_PAYMENTS_REVIEW,
        label: 'Review E-Ajo Contributions',
        description: 'Confirm or reject e-ajo contribution receipts.',
      },
      {
        permission: AdminPermission.EAJO_PAYOUTS_MANAGE,
        label: 'Manage E-Ajo Payouts',
        description: 'Approve and record e-ajo slot payouts.',
      },
    ],
  },
  {
    id: 'payments',
    title: 'Transactions, Wallet & Reversals',
    permissions: [
      {
        permission: AdminPermission.TRANSACTIONS_READ,
        label: 'Read Transactions',
        description: 'View verification queues, disbursements, and ledger history.',
      },
      {
        permission: AdminPermission.TRANSACTIONS_REVIEW,
        label: 'Review Transactions',
        description: 'Confirm or reject general payment receipts and disbursements.',
      },
      {
        permission: AdminPermission.PAYMENTS_REVERSE,
        label: 'Reverse Confirmed Payments',
        description: 'Execute audited payment reversals.',
      },
      {
        permission: AdminPermission.WALLET_MANAGE,
        label: 'Manage Wallets',
        description: 'View and manage member wallet balances and allocations.',
      },
      {
        permission: AdminPermission.WALLET_WITHDRAWALS_REVIEW,
        label: 'Review Wallet Withdrawals',
        description: 'Approve and disburse member wallet withdrawal requests.',
      },
    ],
  },
  {
    id: 'recovery',
    title: 'Recovery, Reconciliation & Settlements',
    permissions: [
      {
        permission: AdminPermission.RECOVERY_MANAGE,
        label: 'Manage Recovery Cases',
        description: 'Review overdue recovery cases, place holds, and issue final notices.',
      },
      {
        permission: AdminPermission.RECOVERY_EXECUTE,
        label: 'Execute Recovery Waterfall',
        description: 'Approve execution of recovery cases after final notice (dual control).',
      },
      {
        permission: AdminPermission.PENALTY_WAIVE,
        label: 'Waive Late Penalties',
        description: 'Waive accrued loan or e-ajo late-payment penalties with a recorded reason.',
      },
      {
        permission: AdminPermission.RECONCILIATION_MANAGE,
        label: 'Manage Bank Reconciliation',
        description: 'Record and match unidentified suspense deposits.',
      },
      {
        permission: AdminPermission.SETTLEMENTS_MANAGE,
        label: 'Manage Member Settlements',
        description: 'Handle member death/exit settlement cases and next-of-kin logs.',
      },
    ],
  },
  {
    id: 'governance',
    title: 'Governance, Notifications & Staff',
    permissions: [
      {
        permission: AdminPermission.SOCIETY_SETTINGS_MANAGE,
        label: 'Manage Society Settings',
        description: 'Configure cooperative receiving bank accounts and society parameters.',
      },
      {
        permission: AdminPermission.POLICY_NOTICES_MANAGE,
        label: 'Manage Policy Notices',
        description: 'Review and send rate/policy update announcements to members.',
      },
      {
        permission: AdminPermission.NOTIFICATIONS_MANAGE,
        label: 'Manage Notifications',
        description: 'Configure and send member notifications and templates.',
      },
      {
        permission: AdminPermission.AUDIT_READ,
        label: 'Read Audit Logs',
        description: 'Inspect immutable system and financial audit trails.',
      },
      {
        permission: AdminPermission.STAFF_MANAGE,
        label: 'Manage Staff Directory',
        description: 'View staff directory (creating staff and granting permissions is OWNER-only).',
      },
    ],
  },
] as const

export const ADMIN_NAV_SECTION_PERMISSIONS: Record<
  string,
  readonly AdminPermission[]
> = {
  dashboard: [],
  members: [
    AdminPermission.MEMBERS_READ,
    AdminPermission.MEMBERS_CREATE,
    AdminPermission.MEMBERS_APPROVE,
    AdminPermission.PROFILE_CHANGES_REVIEW,
  ],
  loans: [
    AdminPermission.LOANS_READ,
    AdminPermission.LOANS_REVIEW,
    AdminPermission.LOANS_DISBURSE,
    AdminPermission.LOAN_SETTINGS_MANAGE,
    AdminPermission.GUARANTEES_REVIEW,
  ],
  savings: [
    AdminPermission.SAVINGS_READ,
    AdminPermission.SAVINGS_MANAGE,
    AdminPermission.SAVINGS_PAYMENTS_REVIEW,
  ],
  eajo: [
    AdminPermission.EAJO_READ,
    AdminPermission.EAJO_MANAGE,
    AdminPermission.EAJO_PAYMENTS_REVIEW,
    AdminPermission.EAJO_PAYOUTS_MANAGE,
  ],
  settings: [
    AdminPermission.STAFF_MANAGE,
    AdminPermission.SOCIETY_SETTINGS_MANAGE,
    AdminPermission.NOTIFICATIONS_MANAGE,
    AdminPermission.POLICY_NOTICES_MANAGE,
  ],
}

export function hasPermissionInSet(
  role: UserRole | string | null | undefined,
  grantedPermissions: Iterable<AdminPermission>,
  required: AdminPermission | readonly AdminPermission[],
  mode: 'ALL' | 'ANY' = 'ALL',
): boolean {
  if (role === UserRole.OWNER) {
    return true
  }

  if (role !== UserRole.ADMIN) {
    return false
  }

  const requiredList = Array.isArray(required)
    ? required
    : [required as AdminPermission]

  if (requiredList.length === 0) {
    return true
  }

  const grantSet =
    grantedPermissions instanceof Set
      ? grantedPermissions
      : new Set(grantedPermissions)

  if (mode === 'ANY') {
    return requiredList.some((perm) => grantSet.has(perm))
  }

  return requiredList.every((perm) => grantSet.has(perm))
}

export function canAccessAdminNavSection(
  role: UserRole | string | null | undefined,
  grantedPermissions: Iterable<AdminPermission>,
  sectionId: string,
): boolean {
  if (role === UserRole.OWNER) {
    return true
  }

  if (role !== UserRole.ADMIN) {
    return false
  }

  const sectionPermissions = ADMIN_NAV_SECTION_PERMISSIONS[sectionId]
  if (!sectionPermissions || sectionPermissions.length === 0) {
    return true
  }

  return hasPermissionInSet(role, grantedPermissions, sectionPermissions, 'ANY')
}

export function resolveRequiredPermissionsForAdminPath(
  pathname: string,
): readonly AdminPermission[] {
  if (pathname === '/admin' || pathname === '/admin/') {
    return []
  }
  if (pathname.startsWith('/admin/members/new')) {
    return [AdminPermission.MEMBERS_CREATE]
  }
  if (pathname.startsWith('/admin/members')) {
    return ADMIN_NAV_SECTION_PERMISSIONS.members
  }
  if (pathname.startsWith('/admin/loans/settings')) {
    return [AdminPermission.LOAN_SETTINGS_MANAGE]
  }
  if (pathname.startsWith('/admin/loans')) {
    return ADMIN_NAV_SECTION_PERMISSIONS.loans
  }
  if (pathname.startsWith('/admin/savings/new') || pathname.includes('/edit')) {
    return [AdminPermission.SAVINGS_MANAGE]
  }
  if (pathname.startsWith('/admin/savings')) {
    return ADMIN_NAV_SECTION_PERMISSIONS.savings
  }
  if (pathname.startsWith('/admin/eajo/new')) {
    return [AdminPermission.EAJO_MANAGE]
  }
  if (pathname.startsWith('/admin/eajo')) {
    return ADMIN_NAV_SECTION_PERMISSIONS.eajo
  }
  if (pathname.startsWith('/admin/verification') || pathname.startsWith('/admin/disbursements')) {
    return [
      AdminPermission.TRANSACTIONS_READ,
      AdminPermission.TRANSACTIONS_REVIEW,
      AdminPermission.SAVINGS_PAYMENTS_REVIEW,
      AdminPermission.LOANS_REVIEW,
      AdminPermission.LOANS_DISBURSE,
      AdminPermission.EAJO_PAYMENTS_REVIEW,
      AdminPermission.EAJO_PAYOUTS_MANAGE,
    ]
  }
  if (pathname.startsWith('/admin/settings')) {
    return ADMIN_NAV_SECTION_PERMISSIONS.settings
  }
  return []
}
