import crypto from 'node:crypto'
import { ZodError } from 'zod'
import { AppError } from '@/lib/errors/app-error'
import { AuthzError } from '@/lib/authz/guards'
import { TokenError } from '@/lib/authz/tokens'
import {
  FileValidationError,
  StorageConfigError as FileStorageConfigError,
} from '@/lib/storage/file-validation'
import {
  StorageConfigError as CloudStorageConfigError,
  StorageUploadError,
} from '@/lib/storage/cloudinary'

export type ActionSuccess<T> = {
  success: true
  data: T
}

export type ActionFailure = {
  success: false
  code: string
  error: string
  fieldErrors?: Record<string, string[]>
  correlationId?: string
}

export type ActionResult<T = unknown> = ActionSuccess<T> | ActionFailure

const SENSITIVE_KEY_PATTERN =
  /password|secret|token|apikey|api_key|authorization|cookie|hash|credential/i

export function generateCorrelationId(): string {
  return `CK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
}

export function redactSensitiveData(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[Truncated]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (value.startsWith('$2a$') || value.startsWith('$2b$')) {
      return '[REDACTED_HASH]'
    }
    return value
  }
  if (typeof value !== 'object') return value
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length}B]`
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item, depth + 1))
  }

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      out[k] = '[REDACTED]'
    } else {
      out[k] = redactSensitiveData(v, depth + 1)
    }
  }
  return out
}

export function formatZodFieldErrors(
  zodError: ZodError,
): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {}
  for (const issue of zodError.issues) {
    const pathKey =
      issue.path.length > 0 ? issue.path.map(String).join('.') : '_form'
    if (!fieldErrors[pathKey]) {
      fieldErrors[pathKey] = []
    }
    fieldErrors[pathKey].push(issue.message)
  }
  return fieldErrors
}

function isPrismaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const err = error as { name?: string; message?: string; code?: string }
  if (typeof err.name === 'string' && err.name.startsWith('PrismaClient')) {
    return true
  }
  if (
    typeof err.message === 'string' &&
    (err.message.includes('Invalid `prisma.') ||
      err.message.includes('Unique constraint failed') ||
      err.message.includes('Foreign key constraint failed'))
  ) {
    return true
  }
  return false
}

export interface ToActionResultOptions {
  fallbackMessage?: string
  actionName?: string
  context?: Record<string, unknown>
}

/**
 * Normalises any thrown error into a safe, structured `ActionResult` failure.
 * - Expected operational errors (`AppError`, `AuthzError`, `TokenError`, `FileValidationError`, `ZodError`)
 *   return their safe message, error code, and optional `fieldErrors`.
 * - External service, database, and unexpected errors are logged server-side with a correlation ID
 *   and redacted context, and return a generic user-safe message with the correlation ID.
 */
export function toActionErrorResult(
  error: unknown,
  options: ToActionResultOptions = {},
): ActionFailure {
  const fallbackMessage =
    options.fallbackMessage ??
    'Something went wrong while processing your request. Please try again.'

  if (error instanceof AppError && error.isOperational) {
    return {
      success: false,
      code: error.code,
      error: error.message,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
    }
  }

  if (error instanceof AuthzError) {
    return {
      success: false,
      code: error.code,
      error: error.message,
    }
  }

  if (error instanceof TokenError) {
    return {
      success: false,
      code: error.code,
      error: error.message,
    }
  }

  if (error instanceof FileValidationError) {
    return {
      success: false,
      code: error.code,
      error: error.message,
    }
  }

  if (error instanceof ZodError) {
    const fieldErrors = formatZodFieldErrors(error)
    const firstIssue = error.issues[0]?.message
    return {
      success: false,
      code: 'VALIDATION_ERROR',
      error: firstIssue || 'Please check the highlighted form fields.',
      fieldErrors,
    }
  }

  const correlationId = generateCorrelationId()
  const redactedContext = options.context
    ? redactSensitiveData(options.context)
    : undefined

  if (
    error instanceof FileStorageConfigError ||
    error instanceof CloudStorageConfigError ||
    error instanceof StorageUploadError ||
    (error instanceof Error &&
      (error.name === 'StorageConfigError' ||
        error.name === 'StorageUploadError'))
  ) {
    console.error('[StorageError]', {
      correlationId,
      action: options.actionName ?? 'unknown',
      errorName: error.name,
      message: error.message,
      context: redactedContext,
    })

    return {
      success: false,
      code: 'EXTERNAL_SERVICE_ERROR',
      error: `Unable to upload file right now. Please try again later. (Ref: ${correlationId})`,
      correlationId,
    }
  }

  if (isPrismaError(error)) {
    const errObj = error as { name?: string; code?: string; message?: string }
    console.error('[DatabaseError]', {
      correlationId,
      action: options.actionName ?? 'unknown',
      errorName: errObj.name ?? 'PrismaError',
      prismaCode: errObj.code,
      context: redactedContext,
    })

    return {
      success: false,
      code: 'DATABASE_ERROR',
      error: `${fallbackMessage} (Ref: ${correlationId})`,
      correlationId,
    }
  }

  console.error('[UnhandledActionError]', {
    correlationId,
    action: options.actionName ?? 'unknown',
    errorName: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    context: redactedContext,
  })

  return {
    success: false,
    code: 'INTERNAL_ERROR',
    error: `${fallbackMessage} (Ref: ${correlationId})`,
    correlationId,
  }
}
