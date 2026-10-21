import { describe, expect, it } from 'vitest'
import { AdminPermission, UserRole } from '@/generated/prisma/enums'
import {
  ALL_ADMIN_PERMISSIONS,
  canAccessAdminNavSection,
  hasPermissionInSet,
  resolveRequiredPermissionsForAdminPath,
} from '@/lib/authz/permissions'

describe('admin permissions domain helpers (P1-03)', () => {
  it('includes all 31 extended Revision 2 AdminPermission values', () => {
    expect(ALL_ADMIN_PERMISSIONS.length).toBe(31)
    expect(ALL_ADMIN_PERMISSIONS).toContain(AdminPermission.EAJO_PAYOUTS_MANAGE)
    expect(ALL_ADMIN_PERMISSIONS).toContain(AdminPermission.PAYMENTS_REVERSE)
    expect(ALL_ADMIN_PERMISSIONS).toContain(AdminPermission.WALLET_MANAGE)
    expect(ALL_ADMIN_PERMISSIONS).toContain(AdminPermission.WALLET_WITHDRAWALS_REVIEW)
    expect(ALL_ADMIN_PERMISSIONS).toContain(AdminPermission.RECOVERY_MANAGE)
    expect(ALL_ADMIN_PERMISSIONS).toContain(AdminPermission.RECOVERY_EXECUTE)
    expect(ALL_ADMIN_PERMISSIONS).toContain(AdminPermission.PENALTY_WAIVE)
    expect(ALL_ADMIN_PERMISSIONS).toContain(AdminPermission.RECONCILIATION_MANAGE)
    expect(ALL_ADMIN_PERMISSIONS).toContain(AdminPermission.SETTLEMENTS_MANAGE)
    expect(ALL_ADMIN_PERMISSIONS).toContain(AdminPermission.POLICY_NOTICES_MANAGE)
  })

  it('grants OWNER every permission regardless of explicit grants', () => {
    for (const perm of ALL_ADMIN_PERMISSIONS) {
      expect(hasPermissionInSet(UserRole.OWNER, [], perm)).toBe(true)
    }
  })

  it('never grants USER any admin permission even if a forged grant set is passed', () => {
    expect(
      hasPermissionInSet(
        UserRole.USER,
        ALL_ADMIN_PERMISSIONS,
        AdminPermission.LOANS_READ,
      ),
    ).toBe(false)
    expect(
      canAccessAdminNavSection(UserRole.USER, ALL_ADMIN_PERMISSIONS, 'loans'),
    ).toBe(false)
  })

  it('grants ADMIN only explicitly granted permissions', () => {
    const grants = [AdminPermission.LOANS_READ]

    expect(
      hasPermissionInSet(UserRole.ADMIN, grants, AdminPermission.LOANS_READ),
    ).toBe(true)
    expect(
      hasPermissionInSet(UserRole.ADMIN, grants, AdminPermission.LOANS_REVIEW),
    ).toBe(false)
    expect(
      hasPermissionInSet(UserRole.ADMIN, grants, AdminPermission.LOANS_DISBURSE),
    ).toBe(false)
  })

  it('filters sidebar navigation sections according to granted permissions', () => {
    const loansOnlyGrants = [AdminPermission.LOANS_READ]

    expect(
      canAccessAdminNavSection(UserRole.ADMIN, loansOnlyGrants, 'dashboard'),
    ).toBe(true)
    expect(
      canAccessAdminNavSection(UserRole.ADMIN, loansOnlyGrants, 'loans'),
    ).toBe(true)
    expect(
      canAccessAdminNavSection(UserRole.ADMIN, loansOnlyGrants, 'members'),
    ).toBe(false)
    expect(
      canAccessAdminNavSection(UserRole.ADMIN, loansOnlyGrants, 'savings'),
    ).toBe(false)
    expect(
      canAccessAdminNavSection(UserRole.ADMIN, loansOnlyGrants, 'eajo'),
    ).toBe(false)
    expect(
      canAccessAdminNavSection(UserRole.ADMIN, loansOnlyGrants, 'settings'),
    ).toBe(false)
  })

  it('resolves required permissions for admin routes', () => {
    expect(resolveRequiredPermissionsForAdminPath('/admin')).toEqual([])
    expect(resolveRequiredPermissionsForAdminPath('/admin/members/new')).toEqual([
      AdminPermission.MEMBERS_CREATE,
    ])
    expect(resolveRequiredPermissionsForAdminPath('/admin/loans/settings')).toEqual([
      AdminPermission.LOAN_SETTINGS_MANAGE,
    ])
    expect(resolveRequiredPermissionsForAdminPath('/admin/eajo/new')).toEqual([
      AdminPermission.EAJO_MANAGE,
    ])
  })
})
