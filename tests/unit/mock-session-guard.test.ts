import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { assertMockSessionAllowed } from '@/lib/authz/mock-session-guard'

describe('Mock session guard (PR P1-08)', () => {
  const originalEnv = process.env
  const env = process.env as Record<string, string | undefined>

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('allows execution when MOCK_SESSION_USER is unset regardless of environment', () => {
    delete process.env.MOCK_SESSION_USER
    env.NODE_ENV = 'production'
    process.env.VERCEL = '1'

    expect(() => assertMockSessionAllowed()).not.toThrow()
  })

  it('allows MOCK_SESSION_USER when NODE_ENV === "test" and no deployed flags are set', () => {
    process.env.MOCK_SESSION_USER = JSON.stringify({ user: { id: 'test-user' } })
    env.NODE_ENV = 'test'
    delete process.env.VERCEL
    delete process.env.RAILWAY_ENVIRONMENT

    expect(() => assertMockSessionAllowed()).not.toThrow()
  })

  it('throws critical security violation when NODE_ENV === "production"', () => {
    process.env.MOCK_SESSION_USER = JSON.stringify({ user: { id: 'test-user' } })
    env.NODE_ENV = 'production'

    expect(() => assertMockSessionAllowed()).toThrow(/CRITICAL SECURITY VIOLATION/)
  })

  it('throws critical security violation when deployed environment flags are detected', () => {
    process.env.MOCK_SESSION_USER = JSON.stringify({ user: { id: 'test-user' } })
    env.NODE_ENV = 'test' // even if NODE_ENV says test

    // Vercel
    process.env.VERCEL = '1'
    expect(() => assertMockSessionAllowed()).toThrow(/CRITICAL SECURITY VIOLATION/)

    // Railway
    delete process.env.VERCEL
    process.env.RAILWAY_ENVIRONMENT = 'production'
    expect(() => assertMockSessionAllowed()).toThrow(/CRITICAL SECURITY VIOLATION/)

    // Render
    delete process.env.RAILWAY_ENVIRONMENT
    process.env.RENDER = 'true'
    expect(() => assertMockSessionAllowed()).toThrow(/CRITICAL SECURITY VIOLATION/)
  })

  it('throws when NODE_ENV is "development"', () => {
    process.env.MOCK_SESSION_USER = JSON.stringify({ user: { id: 'test-user' } })
    env.NODE_ENV = 'development'

    expect(() => assertMockSessionAllowed()).toThrow(/CRITICAL SECURITY VIOLATION/)
  })
})
