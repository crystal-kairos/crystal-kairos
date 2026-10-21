import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import nextConfig from '@/next.config'
import { AppError } from '@/lib/errors/app-error'
import {
  redactSensitiveData,
  toActionErrorResult,
} from '@/lib/errors/to-action-result'
import { AuthzError } from '@/lib/authz/guards'
import { validateEnvironment } from '@/lib/env'
import {
  FileValidationError,
  validateStoredFileBuffer,
} from '@/lib/storage/file-validation'
import { StorageUploadError } from '@/lib/storage/cloudinary'
import { updateNextOfKinAction } from '@/models/members/actions'
import { createSavingsPlanAction } from '@/models/savings/actions'
import {
  Relationship,
  SavingsFrequency,
  SavingsMaturity,
  SavingsType,
  UserRole,
} from '@/generated/prisma/enums'
import { prisma } from '@/lib/prisma'

const mockSessionState = vi.hoisted(() => ({
  session: null as {
    user?: {
      id: string
      email: string
      name: string
      role: UserRole
      sessionVersion?: number
    }
  } | null,
}))

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => mockSessionState.session),
}))

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

describe('Error Normalisation, Validation & Receipt Upload Limit (PR P1-06)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockSessionState.session = {
      user: {
        id: 'member-1',
        email: 'member1@crystalkairos.coop',
        name: 'Member One',
        role: UserRole.USER,
        sessionVersion: 1,
      },
    }

    vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
      id: 'member-1',
      email: 'member1@crystalkairos.coop',
      name: 'Member One',
      role: UserRole.USER,
      sessionVersion: 1,
    } as never)

    vi.spyOn(prisma.adminPermissionGrant, 'findMany').mockResolvedValue([])
  })

  it('sets Server Actions bodySizeLimit to 6mb in next.config.ts and validates 4.9 MB pass vs 5.1 MB fail', () => {
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe('6mb')

    // 4.9 MB valid PNG passes validation
    const size4_9MB = Math.floor(4.9 * 1024 * 1024)
    const buf4_9MB = Buffer.concat([
      PNG_HEADER,
      Buffer.alloc(size4_9MB - PNG_HEADER.length, 0),
    ])

    const validated = validateStoredFileBuffer({
      buffer: buf4_9MB,
      filename: 'receipt-4.9mb.png',
      declaredMimeType: 'image/png',
    })
    expect(validated.sizeBytes).toBe(size4_9MB)
    expect(validated.mimeType).toBe('image/png')

    // 5.1 MB valid PNG fails with FILE_TOO_LARGE and normalises to a visible user message
    const size5_1MB = Math.ceil(5.1 * 1024 * 1024)
    const buf5_1MB = Buffer.concat([
      PNG_HEADER,
      Buffer.alloc(size5_1MB - PNG_HEADER.length, 0),
    ])

    let caughtError: unknown
    try {
      validateStoredFileBuffer({
        buffer: buf5_1MB,
        filename: 'receipt-5.1mb.png',
        declaredMimeType: 'image/png',
      })
    } catch (err) {
      caughtError = err
    }

    expect(caughtError).toBeInstanceOf(FileValidationError)
    const actionRes = toActionErrorResult(caughtError, {
      actionName: 'uploadReceiptAction',
    })
    expect(actionRes.success).toBe(false)
    expect(actionRes.code).toBe('FILE_TOO_LARGE')
    expect(actionRes.error).toMatch(/exceeds the 5MB maximum limit/i)
  })

  it('returns structured fieldErrors for invalid form data and does not create database rows', async () => {
    const upsertSpy = vi.spyOn(prisma.nextOfKin, 'upsert')

    const res = await updateNextOfKinAction('member-1', {
      name: 'A', // Too short (< 2 chars)
      phoneNumber: '123', // Invalid phone number
      relationship: Relationship.SIBLING,
      occupation: '',
      address: 'Short',
      bankName: '',
      accountNumber: '12345', // Not 10 digits
      accountName: '',
    })

    expect(res.success).toBe(false)
    expect(res.code).toBe('VALIDATION_ERROR')
    expect(res.fieldErrors).toBeDefined()
    expect(res.fieldErrors?.accountNumber).toBeDefined()
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('normalises database (Prisma) and Cloudinary failures into safe messages with a correlation ID and hides raw internals', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})

    // 1. Simulate raw Prisma error during savings creation
    const rawPrismaError = new Error(
      'Invalid `prisma.savings.create()` invocation:\nUnique constraint failed on the fields: (`userId`, `accountNumber`) SELECT * FROM "Savings" WHERE secret_token = \'super-secret\'',
    )
    rawPrismaError.name = 'PrismaClientKnownRequestError'

    vi.spyOn(prisma.savings, 'create').mockRejectedValue(rawPrismaError)

    const dbRes = await createSavingsPlanAction('member-1', {
      savingsType: SavingsType.FIXED,
      targetAmount: 50000,
      frequency: SavingsFrequency.ONCE,
      maturity: SavingsMaturity.SIX_MONTHS,
      bankName: 'Test Bank',
      accountNumber: '0123456789',
      accountName: 'Member One',
    })

    expect(dbRes.success).toBe(false)
    expect(dbRes.code).toBe('DATABASE_ERROR')
    expect(dbRes.correlationId).toMatch(/^CK-[0-9A-F]{8}$/)
    expect(dbRes.error).toContain(`(Ref: ${dbRes.correlationId})`)
    expect(dbRes.error).not.toContain('prisma.savings.create')
    expect(dbRes.error).not.toContain('Unique constraint')
    expect(dbRes.error).not.toContain('SELECT * FROM')

    // 2. Simulate Cloudinary upload failure
    const cloudErr = new StorageUploadError(
      'Unable to upload file to cloud storage. Please try again.',
    )
    const storageRes = toActionErrorResult(cloudErr, {
      actionName: 'uploadReceiptAction',
    })

    expect(storageRes.success).toBe(false)
    expect(storageRes.code).toBe('EXTERNAL_SERVICE_ERROR')
    expect(storageRes.correlationId).toMatch(/^CK-[0-9A-F]{8}$/)
    expect(storageRes.error).toContain(
      `Unable to upload file right now. Please try again later. (Ref: ${storageRes.correlationId})`,
    )
    expect(consoleErrorSpy).toHaveBeenCalled()
  })

  it('redacts sensitive fields (passwords, tokens, hashes, secrets) from server error logs and never leaks stack traces', () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})

    const unexpectedErr = new Error(
      'Unexpected null pointer at internal/vault/connection.ts:94',
    )
    const res = toActionErrorResult(unexpectedErr, {
      actionName: 'sensitiveAction',
      fallbackMessage: 'Operation could not be completed.',
      context: {
        userId: 'user-123',
        password: 'PlaintextPassword123!',
        rawToken: 'secret-setup-token-abc',
        apiSecret: 'cloudinary-api-secret',
        existingHash: '$2b$12$abcdefghijklmnopqrstuv',
      },
    })

    expect(res.success).toBe(false)
    expect(res.code).toBe('INTERNAL_ERROR')
    expect(res.correlationId).toMatch(/^CK-[0-9A-F]{8}$/)
    expect(res.error).toBe(
      `Operation could not be completed. (Ref: ${res.correlationId})`,
    )
    expect(res.error).not.toContain('internal/vault/connection.ts')
    expect('stack' in res).toBe(false)

    const loggedPayload = consoleErrorSpy.mock.calls[0]?.[1] as {
      context: Record<string, unknown>
    }
    expect(loggedPayload.context).toEqual({
      userId: 'user-123',
      password: '[REDACTED]',
      rawToken: '[REDACTED]',
      apiSecret: '[REDACTED]',
      existingHash: '[REDACTED]',
    })

    // Also test direct hash value redaction on non-sensitive key names
    const redactedDirectHash = redactSensitiveData({
      note: '$2b$12$someBcryptHashStringValue',
    }) as { note: string }
    expect(redactedDirectHash.note).toBe('[REDACTED_HASH]')
  })

  it('preserves operational AppError, AuthzError, and ZodError codes and messages', () => {
    const appErr = new AppError('CONFLICT', 'Slot is already taken.', {
      fieldErrors: { payoutPosition: ['Slot 1 is already taken'] },
    })
    const appRes = toActionErrorResult(appErr)
    expect(appRes).toEqual({
      success: false,
      code: 'CONFLICT',
      error: 'Slot is already taken.',
      fieldErrors: { payoutPosition: ['Slot 1 is already taken'] },
    })

    const authzErr = new AuthzError('FORBIDDEN', 'Insufficient permissions.')
    const authzRes = toActionErrorResult(authzErr)
    expect(authzRes).toEqual({
      success: false,
      code: 'FORBIDDEN',
      error: 'Insufficient permissions.',
    })

    const schema = z.object({ amount: z.number().positive('Amount must be > 0') })
    const parsed = schema.safeParse({ amount: -10 })
    if (!parsed.success) {
      const zodRes = toActionErrorResult(parsed.error)
      expect(zodRes.code).toBe('VALIDATION_ERROR')
      expect(zodRes.fieldErrors?.amount).toEqual(['Amount must be > 0'])
    }
  })

  it('validates environment variables and rejects NEXT_PUBLIC_ secret leaks with CONFIGURATION_ERROR', () => {
    expect(() =>
      validateEnvironment({
        DATABASE_URL: 'postgresql://localhost:5432/ck',
        AUTH_SECRET: 'super-secret-auth-key',
        CLOUDINARY_CLOUD_NAME: 'ck-cloud',
        CLOUDINARY_API_KEY: '12345',
        CLOUDINARY_API_SECRET: 'secret',
        NEXT_PUBLIC_CLOUDINARY_API_SECRET: 'leaked-secret',
      }),
    ).toThrow(/Forbidden public secret variable detected/)
  })
})
