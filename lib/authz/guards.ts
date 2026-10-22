import { AdminPermission, UserRole } from '@/generated/prisma/enums'
import { prisma } from '@/lib/prisma'
import { getSessionHelper } from '@/models/members/actions'
import {
  ALL_ADMIN_PERMISSIONS,
  hasPermissionInSet,
} from '@/lib/authz/permissions'
import { validateAndTouchUserSession } from '@/lib/authz/sessions'
import { assertMockSessionAllowed } from '@/lib/authz/mock-session-guard'

assertMockSessionAllowed()

export type AuthzErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'DUAL_CONTROL_REQUIRED'
  | 'STAFF_CANNOT_BE_MEMBER'
  | 'MFA_REQUIRED'

export class AuthzError extends Error {
  readonly code: AuthzErrorCode

  constructor(code: AuthzErrorCode, message: string) {
    super(message)
    this.name = 'AuthzError'
    this.code = code
  }
}

export interface AuthenticatedActor {
  id: string
  email: string
  name: string
  role: UserRole
  sessionVersion: number
  sessionId?: string
  mfaEnabled?: boolean
  isActive?: boolean
}

export interface MemberActor extends AuthenticatedActor {
  role: typeof UserRole.USER
}

export interface StaffActor extends AuthenticatedActor {
  role: typeof UserRole.OWNER | typeof UserRole.ADMIN
  permissions: readonly AdminPermission[]
}

async function loadLiveActor(
  db: typeof prisma = prisma,
): Promise<AuthenticatedActor> {
  const session = await getSessionHelper()
  const sessionUser = session?.user as
    | {
        id?: string
        email?: string
        role?: UserRole
        sessionVersion?: number
        sid?: string
      }
    | undefined

  if (!sessionUser?.id) {
    throw new AuthzError('UNAUTHENTICATED', 'Please sign in.')
  }

  // 1. If session carries a sid (database session), validate it against user_sessions table
  if (sessionUser.sid) {
    const sessionValidation = await validateAndTouchUserSession(
      sessionUser.sid,
      new Date(),
      db,
    )
    if (!sessionValidation.valid) {
      throw new AuthzError(
        'UNAUTHENTICATED',
        'Your session has expired or been revoked. Please sign in again.',
      )
    }
  }

  const dbUser = (await db.user.findUnique({
    where: { id: sessionUser.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      sessionVersion: true,
      mfaEnabled: true,
      isActive: true,
    },
  })) as (AuthenticatedActor & { isActive?: boolean; mfaEnabled?: boolean }) | null

  if (!dbUser) {
    throw new AuthzError('UNAUTHENTICATED', 'Please sign in.')
  }

  if (dbUser.isActive === false) {
    throw new AuthzError(
      'FORBIDDEN',
      'This account has been deactivated.',
    )
  }

  if (
    typeof sessionUser.sessionVersion === 'number' &&
    sessionUser.sessionVersion !== dbUser.sessionVersion
  ) {
    throw new AuthzError(
      'UNAUTHENTICATED',
      'Your session is no longer valid. Please sign in again.',
    )
  }

  if (sessionUser.role && sessionUser.role !== dbUser.role) {
    throw new AuthzError(
      'UNAUTHENTICATED',
      'Your session role has changed. Please sign in again.',
    )
  }

  return {
    ...dbUser,
    mfaEnabled: dbUser.mfaEnabled ?? true,
    sessionId: sessionUser.sid,
  }
}

export async function requireAuthenticatedSession(
  db: typeof prisma = prisma,
): Promise<AuthenticatedActor> {
  return loadLiveActor(db)
}

export async function requireMemberSession(
  expectedUserId?: string,
  db: typeof prisma = prisma,
): Promise<MemberActor> {
  const actor = await loadLiveActor(db)

  if (actor.role !== UserRole.USER) {
    throw new AuthzError(
      'FORBIDDEN',
      'Staff accounts cannot perform member financial operations.',
    )
  }

  if (expectedUserId && expectedUserId !== actor.id) {
    throw new AuthzError(
      'FORBIDDEN',
      'You are not authorised to access or modify another member record.',
    )
  }

  return {
    ...actor,
    role: UserRole.USER,
  }
}

export async function requireStaffSession(
  db: typeof prisma = prisma,
): Promise<StaffActor> {
  const actor = await loadLiveActor(db)

  if (actor.role !== UserRole.OWNER && actor.role !== UserRole.ADMIN) {
    throw new AuthzError('FORBIDDEN', 'Not authorised.')
  }

  // P1-07: Staff accounts must have MFA enrolled and verified
  if (actor.mfaEnabled === false) {
    throw new AuthzError(
      'MFA_REQUIRED',
      'Multi-factor authentication must be enabled for staff accounts.',
    )
  }

  if (actor.role === UserRole.OWNER) {
    return {
      ...actor,
      role: UserRole.OWNER,
      permissions: ALL_ADMIN_PERMISSIONS,
    }
  }

  const grants = await db.adminPermissionGrant.findMany({
    where: { adminUserId: actor.id },
    select: { permission: true },
  })

  return {
    ...actor,
    role: UserRole.ADMIN,
    permissions: grants.map((g) => g.permission),
  }
}

export async function requireOwner(
  db: typeof prisma = prisma,
): Promise<StaffActor> {
  const actor = await loadLiveActor(db)

  if (actor.role !== UserRole.OWNER) {
    throw new AuthzError(
      'FORBIDDEN',
      'Only the cooperative owner can perform this action.',
    )
  }

  if (actor.mfaEnabled === false) {
    throw new AuthzError(
      'MFA_REQUIRED',
      'Multi-factor authentication must be enabled for the cooperative owner account.',
    )
  }

  return {
    ...actor,
    role: UserRole.OWNER,
    permissions: ALL_ADMIN_PERMISSIONS,
  }
}

export async function requirePermission(
  permission: AdminPermission,
  db: typeof prisma = prisma,
): Promise<StaffActor> {
  const actor = await requireStaffSession(db)

  if (actor.role === UserRole.OWNER) {
    return actor
  }

  const grant = await db.adminPermissionGrant.findUnique({
    where: {
      adminUserId_permission: {
        adminUserId: actor.id,
        permission,
      },
    },
  })

  if (!grant) {
    throw new AuthzError(
      'FORBIDDEN',
      'You do not have permission to perform this action.',
    )
  }

  return actor
}

export async function requireAnyPermission(
  permissions: readonly AdminPermission[],
  db: typeof prisma = prisma,
): Promise<StaffActor> {
  const staffActor = await requireStaffSession(db)

  if (
    !hasPermissionInSet(
      staffActor.role,
      staffActor.permissions,
      permissions,
      'ANY',
    )
  ) {
    throw new AuthzError(
      'FORBIDDEN',
      'You do not have permission to perform this action.',
    )
  }

  return staffActor
}

export async function requireMemberOrStaffWithPermission(
  targetUserId: string,
  permissions: AdminPermission | readonly AdminPermission[],
  db: typeof prisma = prisma,
): Promise<AuthenticatedActor> {
  const actor = await loadLiveActor(db)

  if (actor.role === UserRole.USER) {
    if (actor.id !== targetUserId) {
      throw new AuthzError(
        'FORBIDDEN',
        'You are not authorised to access another member record.',
      )
    }
    return actor
  }

  const requiredList = Array.isArray(permissions)
    ? permissions
    : [permissions as AdminPermission]

  return requireAnyPermission(requiredList, db)
}

export async function assertTargetUserIsMember(
  userId: string,
  db: typeof prisma = prisma,
): Promise<{ id: string; email: string; name: string; role: UserRole }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
    },
  })

  if (!user) {
    throw new AuthzError('NOT_FOUND', 'Member not found.')
  }

  if (user.role === UserRole.OWNER || user.role === UserRole.ADMIN) {
    throw new AuthzError(
      'STAFF_CANNOT_BE_MEMBER',
      'Staff accounts (OWNER or ADMIN) cannot hold membership or financial records.',
    )
  }

  return user
}

export async function assertUserHasNoMemberRecords(
  userId: string,
  db: typeof prisma = prisma,
): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      membership: { select: { id: true } },
      savings: { select: { id: true }, take: 1 },
      loans: { select: { id: true }, take: 1 },
      eAjoMembers: { select: { id: true }, take: 1 },
      eAjo: { select: { id: true }, take: 1 },
    },
  })

  if (!user) return

  if (
    user.membership ||
    user.savings.length > 0 ||
    user.loans.length > 0 ||
    user.eAjoMembers.length > 0 ||
    user.eAjo.length > 0
  ) {
    throw new AuthzError(
      'STAFF_CANNOT_BE_MEMBER',
      'A user with membership or financial records cannot be assigned a staff role (OWNER or ADMIN).',
    )
  }
}

/**
 * Enforces dual control (A-19): when at least two eligible staff users exist,
 * the acting staff user must differ from the user who performed the paired step.
 * If only one eligible staff user exists and the actor is OWNER, returns `{ singleOperator: true }`.
 */
export async function enforceDualControl(
  params: {
    actor: StaffActor
    previousActorId: string | null | undefined
    requiredPermission: AdminPermission
  },
  db: typeof prisma = prisma,
): Promise<{ singleOperator: boolean }> {
  const { actor, previousActorId, requiredPermission } = params

  if (!previousActorId || previousActorId !== actor.id) {
    return { singleOperator: false }
  }

  // Count distinct staff users eligible for the required permission (all OWNERs + ADMINs with the grant)
  const owners = await db.user.findMany({
    where: { role: UserRole.OWNER },
    select: { id: true },
  })
  const grantedAdmins = await db.adminPermissionGrant.findMany({
    where: { permission: requiredPermission },
    select: { adminUserId: true },
  })

  const eligibleStaffIds = new Set<string>([
    ...owners.map((o) => o.id),
    ...grantedAdmins.map((g) => g.adminUserId),
  ])

  if (eligibleStaffIds.size <= 1 && actor.role === UserRole.OWNER) {
    return { singleOperator: true }
  }

  throw new AuthzError(
    'DUAL_CONTROL_REQUIRED',
    'Dual control requires a different authorised staff member to complete this step.',
  )
}
