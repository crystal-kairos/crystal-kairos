import { AppError } from '@/lib/errors/app-error'

const SERVER_ONLY_SECRET_PATTERNS = [
  'SECRET',
  'PRIVATE',
  'PASSWORD',
  'DATABASE_URL',
  'API_KEY',
  'ENCRYPTION_KEY',
  'PAYSTACK',
]

const cleanValue = (raw: string | undefined): string => {
  if (!raw) return ''
  return raw.replace(/^["']|["']$/g, '').trim()
}

export const getRequiredEnv = (
  key: string,
  envSource: NodeJS.ProcessEnv = process.env,
): string => {
  if (
    key.startsWith('NEXT_PUBLIC_') &&
    SERVER_ONLY_SECRET_PATTERNS.some((pattern) => key.includes(pattern))
  ) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      `Forbidden public secret variable detected: ${key} must not be prefixed with NEXT_PUBLIC_.`,
      { statusCode: 500, isOperational: false },
    )
  }

  const value = cleanValue(envSource[key])
  if (!value) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      `Missing required environment variable: ${key}`,
      { statusCode: 500, isOperational: false },
    )
  }
  return value
}

export const getOptionalEnv = (
  key: string,
  defaultValue = '',
  envSource: NodeJS.ProcessEnv = process.env,
): string => {
  const value = cleanValue(envSource[key])
  return value || defaultValue
}

export const validateEnvironment = (
  envSource: Record<string, string | undefined> = process.env,
) => {
  for (const key of Object.keys(envSource)) {
    if (
      key.startsWith('NEXT_PUBLIC_') &&
      SERVER_ONLY_SECRET_PATTERNS.some((pattern) => key.includes(pattern)) &&
      cleanValue(envSource[key])
    ) {
      throw new AppError(
        'CONFIGURATION_ERROR',
        `Forbidden public secret variable detected: ${key} must not be prefixed with NEXT_PUBLIC_.`,
        { statusCode: 500, isOperational: false },
      )
    }
  }

  const requiredKeys = [
    'DATABASE_URL',
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
  ]

  for (const key of requiredKeys) {
    getRequiredEnv(key, envSource as NodeJS.ProcessEnv)
  }

  const authSecret =
    cleanValue(envSource.AUTH_SECRET) || cleanValue(envSource.NEXTAUTH_SECRET)
  if (!authSecret) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'Missing required environment variable: AUTH_SECRET (or NEXTAUTH_SECRET)',
      { statusCode: 500, isOperational: false },
    )
  }

  return true
}
