import { describe, it, expect } from 'vitest'
import { homePathFor, mfaChallengePath, safeInternalPath } from '@/lib/authz/redirects'

describe('Unit: auth redirect helpers (P1-07)', () => {
  it('keeps same-origin paths', () => {
    expect(safeInternalPath('/admin', '/')).toBe('/admin')
    expect(safeInternalPath('/admin/members?status=PENDING', '/')).toBe('/admin/members?status=PENDING')
  })

  it('rejects open redirects and loops back to login', () => {
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'admin',
      '/login',
      '/login/mfa?callbackUrl=/admin',
      '/admin\n/evil',
      '',
      null,
      undefined,
    ]) {
      expect(safeInternalPath(bad as string | null | undefined, '/fallback')).toBe('/fallback')
    }
  })

  it('computes landing pages by role', () => {
    expect(homePathFor('OWNER', 'o1')).toBe('/admin')
    expect(homePathFor('ADMIN', 'a1')).toBe('/admin')
    expect(homePathFor('USER', 'u1')).toBe('/dashboard/u1')
    expect(homePathFor(undefined, undefined)).toBe('/')
  })

  it('encodes the callback into the challenge URL', () => {
    expect(mfaChallengePath('/admin/members?x=1')).toBe('/login/mfa?callbackUrl=%2Fadmin%2Fmembers%3Fx%3D1')
  })
})
