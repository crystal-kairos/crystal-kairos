import { AdminPermission, UserRole } from '@/generated/prisma/enums'
import { prisma } from '@/lib/prisma'
import { getSessionHelper } from '@/models/members/actions'
import {
  ALL_ADMIN_PERMISSIONS,
  hasPermissionInSet,
} from '@/lib/authz/permissions'

export type AuthzErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'DUAL_CONTROL_REQUIRED'
  | 'STAFF_CANNOT_BE_MEMBER'

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
      }
    | undefined

  if (!sessionUser?.id) {
    throw new AuthzError('UNAUTHENTICATED', 'Please sign in.')
  }

  const dbUser = await db.user.findUnique({
    where: { id: sessionUser.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      sessionVersion: true,
    },
  })

  if (!dbUser) {
    throw new AuthzError('UNAUTHENTICATED', 'Please sign in.')
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

  return dbUser
}

export async function requireStaffSession(
  db: typeof prisma = prisma,
): Promise<StaffActor> {
  const actor = await loadLiveActor(db)

  if (actor.role !== UserRole.OWNER && actor.role !== UserRole.ADMIN) {
    throw new AuthzError('FORBIDDEN', 'Not authorised.')
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
  const actor = await loadLiveActor(db)

  if (actor.role === UserRole.OWNER) {
    return {
      ...actor,
      role: UserRole.OWNER,
      permissions: ALL_ADMIN_PERMISSIONS,
    }
  }

  if (actor.role !== UserRole.ADMIN) {
    throw new AuthzError('FORBIDDEN', 'Not authorised.')
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

  const allGrants = await db.adminPermissionGrant.findMany({
    where: { adminUserId: actor.id },
    select: { permission: true },
  })

  return {
    ...actor,
    role: UserRole.ADMIN,
    permissions: allGrants.map((g) => g.permission),
  }
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
