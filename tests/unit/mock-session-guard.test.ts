import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { assertMockSessionAllowed } from '@/lib/authz/mock-session-guard'

describe('Mock session guard (PR P1-08)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('allows execution when MOCK_SESSION_USER is unset regardless of environment', () => {
    vi.stubEnv('MOCK_SESSION_USER', '')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL', '1')

    expect(() => assertMockSessionAllowed()).not.toThrow()
  })

  it('allows MOCK_SESSION_USER when NODE_ENV === "test" and no deployed flags are set', () => {
    vi.stubEnv('MOCK_SESSION_USER', JSON.stringify({ user: { id: 'test-user' } }))
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('RAILWAY_ENVIRONMENT', '')

    expect(() => assertMockSessionAllowed()).not.toThrow()
  })

  it('throws critical security violation when NODE_ENV === "production"', () => {
    vi.stubEnv('MOCK_SESSION_USER', JSON.stringify({ user: { id: 'test-user' } }))
    vi.stubEnv('NODE_ENV', 'production')

    expect(() => assertMockSessionAllowed()).toThrow(/CRITICAL SECURITY VIOLATION/)
  })

  it('throws critical security violation when deployed environment flags are detected', () => {
    vi.stubEnv('MOCK_SESSION_USER', JSON.stringify({ user: { id: 'test-user' } }))
    vi.stubEnv('NODE_ENV', 'test') // even if NODE_ENV says test

    // Vercel
    vi.stubEnv('VERCEL', '1')
    expect(() => assertMockSessionAllowed()).toThrow(/CRITICAL SECURITY VIOLATION/)

    // Railway
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('RAILWAY_ENVIRONMENT', 'production')
    expect(() => assertMockSessionAllowed()).toThrow(/CRITICAL SECURITY VIOLATION/)

    // Render
    vi.stubEnv('RAILWAY_ENVIRONMENT', '')
    vi.stubEnv('RENDER', 'true')
    expect(() => assertMockSessionAllowed()).toThrow(/CRITICAL SECURITY VIOLATION/)
  })

  it('throws when NODE_ENV is "development"', () => {
    vi.stubEnv('MOCK_SESSION_USER', JSON.stringify({ user: { id: 'test-user' } }))
    vi.stubEnv('NODE_ENV', 'development')

    expect(() => assertMockSessionAllowed()).toThrow(/CRITICAL SECURITY VIOLATION/)
  })
})
