import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminPermission, UserRole } from '@/generated/prisma/enums'

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

import { prisma } from '@/lib/prisma'
import {
  authorizeAndResolveStoredFile,
  uploadStoredFile,
} from '@/lib/storage/cloudinary'
import { uploadReceiptAction } from '@/models/eajo/actions'
import { GET as getFileRoute } from '@/app/api/files/[fileId]/route'
import { GET as getLegacyReceiptRoute } from '@/app/api/receipts/[filename]/route'

const VALID_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
])

interface StoredFileRow {
  id: string
  publicId: string
  secureUrl: string
  purpose: string
  resourceType: string
  deliveryType: string
  format: string
  contentType: string
  sizeBytes: number
  originalFilename: string | null
  uploadedById: string
  ownerUserId: string | null
  associatedType: string | null
  associatedId: string | null
  createdAt: Date
}

describe('Cloudinary storage & authenticated receipt access integration (PR P1-05)', () => {
  const storedFiles = new Map<string, StoredFileRow>()
  const users = new Map<
    string,
    {
      id: string
      email: string
      name: string
      role: UserRole
      sessionVersion: number
    }
  >()
  const grants = new Map<string, AdminPermission[]>()
  let fileSeq = 1

  const signInAs = (userId: string | null) => {
    if (!userId) {
      mockSessionState.session = null
      return
    }
    const u = users.get(userId)
    if (!u) throw new Error(`Unknown user ${userId}`)
    mockSessionState.session = {
      user: { ...u },
    }
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    storedFiles.clear()
    users.clear()
    grants.clear()
    fileSeq = 1

    process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud'
    process.env.CLOUDINARY_API_KEY = '1234567890'
    process.env.CLOUDINARY_API_SECRET = 'test-secret-key'
    process.env.CLOUDINARY_BASE_FOLDER = 'crystal-kairos'
    delete process.env.NEXT_PUBLIC_CLOUDINARY_API_SECRET

    users.set('member-a', {
      id: 'member-a',
      email: 'member.a@crystalkairos.coop',
      name: 'Member Alpha',
      role: UserRole.USER,
      sessionVersion: 1,
    })
    users.set('member-b', {
      id: 'member-b',
      email: 'member.b@crystalkairos.coop',
      name: 'Member Beta',
      role: UserRole.USER,
      sessionVersion: 1,
    })
    users.set('admin-unpriv', {
      id: 'admin-unpriv',
      email: 'admin.unpriv@crystalkairos.coop',
      name: 'Unprivileged Admin',
      role: UserRole.ADMIN,
      sessionVersion: 1,
    })
    grants.set('admin-unpriv', [])

    users.set('admin-finance', {
      id: 'admin-finance',
      email: 'admin.finance@crystalkairos.coop',
      name: 'Finance Admin',
      role: UserRole.ADMIN,
      sessionVersion: 1,
    })
    grants.set('admin-finance', [AdminPermission.TRANSACTIONS_READ])

    users.set('owner-1', {
      id: 'owner-1',
      email: 'owner@crystalkairos.coop',
      name: 'Cooperative Owner',
      role: UserRole.OWNER,
      sessionVersion: 1,
    })

    vi.spyOn(prisma.user, 'findUnique').mockImplementation((async (args: {
      where: { id?: string }
    }) => {
      if (!args.where.id) return null
      return users.get(args.where.id) ?? null
    }) as never)

    vi.spyOn(prisma.adminPermissionGrant, 'findMany').mockImplementation((async (
      args?: { where?: { adminUserId?: string } },
    ) => {
      const id = args?.where?.adminUserId
      if (!id) return []
      return (grants.get(id) ?? []).map((permission) => ({
        adminUserId: id,
        permission,
      }))
    }) as never)

    vi.spyOn(prisma.storedFile, 'create').mockImplementation((async (args: {
      data: Omit<StoredFileRow, 'id' | 'createdAt'>
    }) => {
      const row: StoredFileRow = {
        id: `file-${fileSeq++}`,
        createdAt: new Date(),
        ...args.data,
      }
      storedFiles.set(row.id, row)
      return row
    }) as never)

    vi.spyOn(prisma.storedFile, 'findFirst').mockImplementation((async (args: {
      where?: { OR?: Array<{ id?: string; publicId?: string }> }
    }) => {
      const clauses = args.where?.OR ?? []
      for (const row of storedFiles.values()) {
        for (const c of clauses) {
          if (c.id && row.id === c.id) return row
          if (c.publicId && row.publicId === c.publicId) return row
        }
      }
      return null
    }) as never)

    vi.spyOn(prisma.transaction, 'findFirst').mockResolvedValue(null as never)
  })

  it('uploads valid files to the typed Cloudinary subfolder with authenticated delivery and persists StoredFile metadata', async () => {
    const capturedOptions: Record<string, unknown>[] = []
    const fakeUploader = {
      upload_stream: vi.fn(
        (
          options: Record<string, unknown>,
          cb: (
            err: Error | null,
            res?: { secure_url: string; public_id: string },
          ) => void,
        ) => {
          capturedOptions.push(options)
          return {
            end: (buf: Buffer) => {
              expect(buf.length).toBeGreaterThan(0)
              cb(null, {
                secure_url:
                  'https://res.cloudinary.com/test-cloud/image/authenticated/s--sig--/v1/crystal-kairos/receipts/rcpt_1.png',
                public_id: 'crystal-kairos/receipts/rcpt_1',
              })
            },
          }
        },
      ),
    }

    const uploaded = await uploadStoredFile(
      {
        buffer: VALID_PNG,
        filename: 'deposit-proof.png',
        declaredMimeType: 'image/png',
        purpose: 'receipts',
        uploadedById: 'member-a',
        ownerUserId: 'member-a',
      },
      { uploader: fakeUploader as never },
    )

    expect(capturedOptions[0]).toEqual({
      folder: 'crystal-kairos/receipts',
      resource_type: 'image',
      type: 'authenticated',
    })
    expect(uploaded.fileId).toBe('file-1')
    expect(uploaded.url).toBe('/api/files/file-1')
    expect('isLocal' in uploaded).toBe(false)
    expect(storedFiles.get('file-1')).toMatchObject({
      publicId: 'crystal-kairos/receipts/rcpt_1',
      purpose: 'receipts',
      deliveryType: 'authenticated',
      contentType: 'image/png',
      uploadedById: 'member-a',
      ownerUserId: 'member-a',
    })
  })

  it('enforces ownership and staff permissions on /api/files/[fileId] and /api/receipts/[filename] with private no-store headers', async () => {
    storedFiles.set('file-member-a', {
      id: 'file-member-a',
      publicId: 'crystal-kairos/receipts/member_a_rcpt',
      secureUrl:
        'https://res.cloudinary.com/test-cloud/image/authenticated/v1/crystal-kairos/receipts/member_a_rcpt.png',
      purpose: 'receipts',
      resourceType: 'image',
      deliveryType: 'authenticated',
      format: 'png',
      contentType: 'image/png',
      sizeBytes: VALID_PNG.length,
      originalFilename: 'receipt.png',
      uploadedById: 'member-a',
      ownerUserId: 'member-a',
      associatedType: 'TRANSACTION',
      associatedId: 'tx-a',
      createdAt: new Date(),
    })

    // 1. Anonymous caller -> 401
    signInAs(null)
    const anonReq = new NextRequest('http://localhost:3000/api/files/file-member-a')
    const anonRes = await getFileRoute(anonReq, {
      params: Promise.resolve({ fileId: 'file-member-a' }),
    })
    expect(anonRes.status).toBe(401)
    expect(anonRes.headers.get('Cache-Control')).toBe(
      'private, no-store, max-age=0',
    )

    // 2. Member B attempting to access Member A's file -> 403 Forbidden
    signInAs('member-b')
    const memberBReq = new NextRequest(
      'http://localhost:3000/api/files/file-member-a',
    )
    const memberBRes = await getFileRoute(memberBReq, {
      params: Promise.resolve({ fileId: 'file-member-a' }),
    })
    expect(memberBRes.status).toBe(403)

    // 3. Unprivileged Admin -> 403 Forbidden
    signInAs('admin-unpriv')
    const unprivAdminRes = await getFileRoute(memberBReq, {
      params: Promise.resolve({ fileId: 'file-member-a' }),
    })
    expect(unprivAdminRes.status).toBe(403)

    // 4. Member A accessing own file -> 302 redirect to short-lived signed Cloudinary URL with private no-store headers
    signInAs('member-a')
    const memberARes = await getFileRoute(
      new NextRequest('http://localhost:3000/api/files/file-member-a'),
      { params: Promise.resolve({ fileId: 'file-member-a' }) },
    )
    expect(memberARes.status).toBe(302)
    expect(memberARes.headers.get('Cache-Control')).toBe(
      'private, no-store, max-age=0',
    )
    expect(memberARes.headers.get('Location')).toContain('api.cloudinary.com')
    expect(memberARes.headers.get('Location')).toContain('expires_at=')

    // 5. Finance Admin with TRANSACTIONS_READ -> 302 redirect
    signInAs('admin-finance')
    const financeAdminRes = await getLegacyReceiptRoute(
      new NextRequest('http://localhost:3000/api/receipts/file-member-a'),
      { params: Promise.resolve({ filename: 'file-member-a' }) },
    )
    expect(financeAdminRes.status).toBe(302)
    expect(financeAdminRes.headers.get('Cache-Control')).toBe(
      'private, no-store, max-age=0',
    )

    // 6. Owner -> succeeds
    signInAs('owner-1')
    const resolved = await authorizeAndResolveStoredFile('file-member-a')
    expect(resolved.signedUrl).toContain('expires_at=')
  })

  it('returns a safe error and creates no orphan record when Cloudinary fails or credentials are missing', async () => {
    signInAs('member-a')

    // Rejects client-supplied folder parameter
    const spoofedFolderForm = new FormData()
    spoofedFolderForm.append('folder', 'custom/evil-folder')
    spoofedFolderForm.append(
      'file',
      new File([VALID_PNG], 'receipt.png', { type: 'image/png' }),
    )
    const folderRes = await uploadReceiptAction(spoofedFolderForm)
    expect(folderRes.success).toBe(false)
    if (!folderRes.success) {
      expect(folderRes.error).toMatch(/folders are not permitted/i)
    }
    expect(storedFiles.size).toBe(0)

    // Missing Cloudinary credentials -> safe error with correlation ID, no StoredFile created
    delete process.env.CLOUDINARY_API_SECRET
    const validForm = new FormData()
    validForm.append(
      'file',
      new File([VALID_PNG], 'receipt.png', { type: 'image/png' }),
    )
    const missingCredsRes = await uploadReceiptAction(validForm)
    expect(missingCredsRes.success).toBe(false)
    if (!missingCredsRes.success) {
      expect(missingCredsRes.error).toMatch(
        /Unable to upload file right now\. Please try again later\./,
      )
      expect(missingCredsRes.correlationId).toMatch(/^CK-[0-9A-F]{8}$/)
    }
    expect(storedFiles.size).toBe(0)

    // Simulate Cloudinary stream timeout/error -> safe error, no StoredFile created
    process.env.CLOUDINARY_API_SECRET = 'test-secret-key'
    const failingUploader = {
      upload_stream: vi.fn(
        (_opts: unknown, cb: (err: Error | null) => void) => ({
          end: () => cb(new Error('ETIMEDOUT: Cloudinary request timed out')),
        }),
      ),
    }

    await expect(
      uploadStoredFile(
        {
          buffer: VALID_PNG,
          filename: 'receipt.png',
          declaredMimeType: 'image/png',
          uploadedById: 'member-a',
        },
        { uploader: failingUploader as never },
      ),
    ).rejects.toThrow(/Unable to upload file to cloud storage/i)
    expect(storedFiles.size).toBe(0)
  })
})
