/**
 * Redirect helpers shared by the proxy and the auth pages (P1-07).
 * Kept free of server-only imports so client components can use them.
 */

/**
 * Returns `path` only when it is a same-origin absolute path (e.g. `/admin/members?x=1`);
 * otherwise `fallback`. Prevents open redirects through `callbackUrl`.
 */
export function safeInternalPath(path: string | null | undefined, fallback: string): string {
  if (!path || typeof path !== 'string') return fallback
  const trimmed = path.trim()
  if (!trimmed.startsWith('/')) return fallback
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) return fallback
  if (/[\u0000-\u001f]/.test(trimmed)) return fallback
  if (trimmed.startsWith('/login')) return fallback
  return trimmed
}

/** Landing page for a signed-in user. */
export function homePathFor(role: string | null | undefined, userId: string | null | undefined): string {
  if (role === 'ADMIN' || role === 'OWNER') return '/admin'
  if (role === 'USER' && userId) return `/dashboard/${userId}`
  return '/'
}

/** URL of the MFA challenge page, carrying where to go afterwards. */
export function mfaChallengePath(callbackPath: string): string {
  return `/login/mfa?callbackUrl=${encodeURIComponent(callbackPath)}`
}
