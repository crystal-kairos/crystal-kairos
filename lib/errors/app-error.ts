export type AppErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'STALE_STATE'
  | 'RATE_LIMITED'
  | 'DUAL_CONTROL_REQUIRED'
  | 'STAFF_CANNOT_BE_MEMBER'
  | 'FILE_TOO_LARGE'
  | 'EMPTY_FILE'
  | 'UNSUPPORTED_FORMAT'
  | 'SIGNATURE_MISMATCH'
  | 'PURPOSE_FORMAT_NOT_ALLOWED'
  | 'INVALID_PURPOSE'
  | 'EXTERNAL_SERVICE_ERROR'
  | 'DATABASE_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'INTERNAL_ERROR'
  | (string & {})

export interface AppErrorOptions {
  statusCode?: number
  fieldErrors?: Record<string, string[]>
  cause?: unknown
  isOperational?: boolean
}

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly statusCode: number
  readonly fieldErrors?: Record<string, string[]>
  readonly isOperational: boolean

  constructor(
    code: AppErrorCode,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = 'AppError'
    this.code = code
    this.statusCode = options.statusCode ?? (code === 'STALE_STATE' || code === 'CONFLICT' ? 409 : 400)
    this.fieldErrors = options.fieldErrors
    this.isOperational = options.isOperational ?? true
  }
}
