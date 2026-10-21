import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  detectFileSignature,
  FileValidationError,
  folderFor,
  getRequiredEnv,
  MAX_UPLOAD_SIZE_BYTES,
  StorageConfigError,
  validateStoredFileBuffer,
} from '@/lib/storage/file-validation'

const VALID_JPEG_BUFFER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
])
const VALID_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
])
const VALID_PDF_BUFFER = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n', 'utf8')

describe('Server-side file validation & Cloudinary folder rules (PR P1-05)', () => {
  it('accepts valid JPG, PNG, and PDF buffers under 5 MB', () => {
    const jpg = validateStoredFileBuffer({
      buffer: VALID_JPEG_BUFFER,
      filename: 'payment-receipt.jpeg',
      declaredMimeType: 'image/jpeg',
      purpose: 'receipts',
    })
    expect(jpg.mimeType).toBe('image/jpeg')
    expect(jpg.extension).toBe('jpg')
    expect(jpg.resourceType).toBe('image')
    expect(jpg.sanitizedFilename).toBe('payment-receipt.jpg')

    const png = validateStoredFileBuffer({
      buffer: VALID_PNG_BUFFER,
      filename: 'passport photo!.png',
      declaredMimeType: 'image/png',
      purpose: 'passport-photos',
    })
    expect(png.mimeType).toBe('image/png')
    expect(png.extension).toBe('png')
    expect(png.resourceType).toBe('image')
    expect(png.sanitizedFilename).toBe('passport_photo_.png')

    const pdf = validateStoredFileBuffer({
      buffer: VALID_PDF_BUFFER,
      filename: 'guarantor.pdf',
      declaredMimeType: 'application/pdf',
      purpose: 'guarantor-evidence',
    })
    expect(pdf.mimeType).toBe('application/pdf')
    expect(pdf.extension).toBe('pdf')
    expect(pdf.resourceType).toBe('raw')
  })

  it('rejects empty files and files exceeding 5 MB', () => {
    expect(() =>
      validateStoredFileBuffer({
        buffer: Buffer.alloc(0),
        filename: 'empty.png',
      }),
    ).toThrowError(FileValidationError)

    const oversized = Buffer.alloc(MAX_UPLOAD_SIZE_BYTES + 1)
    VALID_PNG_BUFFER.copy(oversized, 0)

    expect(() =>
      validateStoredFileBuffer({
        buffer: oversized,
        filename: 'huge.png',
        declaredMimeType: 'image/png',
      }),
    ).toThrow(/exceeds the 5MB maximum limit/i)
  })

  it('rejects unsupported file formats and mismatched file signatures', () => {
    const htmlDisguisedAsPng = Buffer.from(
      '<!DOCTYPE html><script>alert(1)</script>',
      'utf8',
    )
    expect(detectFileSignature(htmlDisguisedAsPng)).toBeNull()

    expect(() =>
      validateStoredFileBuffer({
        buffer: htmlDisguisedAsPng,
        filename: 'receipt.png',
        declaredMimeType: 'image/png',
      }),
    ).toThrow(/Unsupported file format/i)

    // Valid PNG magic bytes but declared as application/pdf
    expect(() =>
      validateStoredFileBuffer({
        buffer: VALID_PNG_BUFFER,
        filename: 'receipt.png',
        declaredMimeType: 'application/pdf',
      }),
    ).toThrow(/signature does not match the declared file type/i)

    // Valid JPEG magic bytes but named .pdf
    expect(() =>
      validateStoredFileBuffer({
        buffer: VALID_JPEG_BUFFER,
        filename: 'receipt.pdf',
        declaredMimeType: 'image/jpeg',
      }),
    ).toThrow(/signature does not match the file extension/i)
  })

  it('rejects PDF files when purpose is passport-photos and rejects unknown purposes', () => {
    expect(() =>
      validateStoredFileBuffer({
        buffer: VALID_PDF_BUFFER,
        filename: 'avatar.pdf',
        declaredMimeType: 'application/pdf',
        purpose: 'passport-photos',
      }),
    ).toThrow(/not permitted for passport-photos/i)

    expect(() =>
      validateStoredFileBuffer({
        buffer: VALID_PNG_BUFFER,
        filename: 'avatar.png',
        purpose: '../../etc/passwd' as never,
      }),
    ).toThrow(/Invalid file storage purpose/i)
  })

  it('constructs strict Cloudinary folders from CLOUDINARY_BASE_FOLDER and purpose', () => {
    const prevBase = process.env.CLOUDINARY_BASE_FOLDER
    try {
      process.env.CLOUDINARY_BASE_FOLDER = '/crystal-kairos/'
      expect(folderFor('receipts')).toBe('crystal-kairos/receipts')
      expect(folderFor('passport-photos')).toBe(
        'crystal-kairos/passport-photos',
      )
      expect(folderFor('guarantor-evidence')).toBe(
        'crystal-kairos/guarantor-evidence',
      )

      expect(() =>
        getRequiredEnv('NEXT_PUBLIC_CLOUDINARY_API_SECRET'),
      ).toThrowError(StorageConfigError)
    } finally {
      process.env.CLOUDINARY_BASE_FOLDER = prevBase
    }
  })

  it('ensures /api/receipts/[filename] does not read from local disk or set public cache headers', () => {
    const routePath = path.join(
      process.cwd(),
      'app/api/receipts/[filename]/route.ts',
    )
    const content = fs.readFileSync(routePath, 'utf8')
    expect(content).not.toMatch(/from\s+['"]fs['"]/)
    expect(content).not.toMatch(/readFileSync/)
    expect(content).not.toMatch(/public,\s*max-age=/i)
    expect(content).toContain('private, no-store, max-age=0')
  })
})
