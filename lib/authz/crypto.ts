import crypto from 'node:crypto'
import { getRequiredEnv } from '@/lib/env'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

function getEncryptionKeyBuffer(): Buffer {
  const b64Key = getRequiredEnv('MFA_ENCRYPTION_KEY')
  const keyBuf = Buffer.from(b64Key, 'base64')
  if (keyBuf.length !== 32) {
    throw new Error('MFA_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
  }
  return keyBuf
}

/**
 * Encrypts a plaintext string with AES-256-GCM using the server's MFA_ENCRYPTION_KEY.
 * Returns an envelope string: iv:authTag:ciphertext (base64 encoded).
 */
export function encryptMfaSecret(plaintext: string): string {
  const key = getEncryptionKeyBuffer()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()

  return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

/**
 * Decrypts an envelope string (iv:authTag:ciphertext) created by encryptMfaSecret.
 */
export function decryptMfaSecret(payload: string): string {
  const parts = payload.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted MFA secret payload format')
  }

  const [ivB64, tagB64, cipherB64] = parts
  const key = getEncryptionKeyBuffer()
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ciphertext = Buffer.from(cipherB64, 'base64')

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  decipher.setAuthTag(tag)

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])

  return decrypted.toString('utf8')
}

/**
 * Computes a deterministic SHA-256 hash formatted as a hex string.
 * Used for hashing identifiers (email, IP, backup codes) to prevent storing plaintext PII in logs or attempt tables.
 */
export function hashSha256(value: string, salt = ''): string {
  return crypto
    .createHash('sha256')
    .update(`${salt}:${value}`)
    .digest('hex')
}
