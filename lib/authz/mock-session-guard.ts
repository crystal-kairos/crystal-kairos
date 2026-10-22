/**
 * Mock session guard ensuring MOCK_SESSION_USER cannot run when NODE_ENV === 'production'
 * or when any deployed-environment flag is set; throws at startup or evaluation time.
 */
export function assertMockSessionAllowed(): void {
  const mockUser = process.env.MOCK_SESSION_USER
  if (!mockUser) {
    return
  }

  const isProduction = process.env.NODE_ENV === 'production'
  const isDeployed = Boolean(
    process.env.VERCEL ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RENDER ||
    process.env.FLY_APP_NAME ||
    process.env.HEROKU_APP_NAME ||
    process.env.AWS_EXECUTION_ENV ||
    process.env.NETLIFY ||
    process.env.KUBERNETES_SERVICE_HOST
  )
  const isTest = process.env.NODE_ENV === 'test'

  if (isProduction || isDeployed || !isTest) {
    throw new Error(
      'MOCK_SESSION_USER is forbidden outside NODE_ENV=test. CRITICAL SECURITY VIOLATION: MOCK_SESSION_USER is strictly forbidden in production or deployed environments.',
    )
  }
}

// Enforce guard at module evaluation time
assertMockSessionAllowed()
