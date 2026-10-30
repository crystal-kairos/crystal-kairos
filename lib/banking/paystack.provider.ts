import { AppError } from '@/lib/errors/app-error'
import {
  AccountResolutionResult,
  Bank,
  IBankProvider,
} from './provider'
import staticBanksList from '@/data/bank-list.json'

const PAYSTACK_BASE_URL = 'https://api.paystack.co'
const REQUEST_TIMEOUT_MS = 8000

// In-memory cache for bank list (TTL 1 hour)
let cachedBanks: Bank[] | null = null
let cacheTimestamp = 0
const CACHE_TTL_MS = 60 * 60 * 1000

let customTestProvider: IBankProvider | null = null

export function setBankProviderForTesting(provider: IBankProvider | null) {
  customTestProvider = provider
}

export class PaystackBankProvider implements IBankProvider {
  private getSecretKey(): string {
    const key = process.env.PAYSTACK_SECRET_KEY?.trim()
    return key || ''
  }

  /**
   * Fetches supported Nigerian banks from Paystack, caching in memory for 1 hour.
   * Gracefully falls back to bundled static bank list on error or when offline.
   */
  async listBanks(): Promise<Bank[]> {
    if (customTestProvider) {
      return customTestProvider.listBanks()
    }

    const now = Date.now()
    if (cachedBanks && now - cacheTimestamp < CACHE_TTL_MS) {
      return cachedBanks
    }

    const secretKey = this.getSecretKey()
    if (!secretKey) {
      // Fallback to static list when credentials are not configured
      cachedBanks = (staticBanksList as Bank[]).filter((b) => b.active !== false)
      cacheTimestamp = now
      return cachedBanks
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

      const response = await fetch(`${PAYSTACK_BASE_URL}/bank?country=nigeria`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      })

      clearTimeout(timer)

      if (!response.ok) {
        console.warn(`Paystack /bank returned status ${response.status}. Using fallback bank list.`)
        return (staticBanksList as Bank[]).filter((b) => b.active !== false)
      }

      const body = await response.json()
      if (body.status && Array.isArray(body.data)) {
        // Filter out deleted, inactive, and non-NGN banks
        const validBanks = body.data.filter(
          (b: any) => !b.is_deleted && (b.active ?? true) && (!b.currency || b.currency === 'NGN'),
        )

        // Deduplicate records where normalized name and code are identical
        const seen = new Set<string>()
        const banks: Bank[] = []

        for (const b of validBanks) {
          const dedupeKey = `${(b.name || '').toLowerCase().trim()}::${b.code}`
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey)
            banks.push({
              id: b.id,
              name: b.name,
              code: b.code,
              slug: b.slug,
              active: b.active ?? true,
              country: b.country,
              currency: b.currency,
              type: b.type,
            })
          }
        }

        cachedBanks = banks
        cacheTimestamp = now
        return banks
      }

      return (staticBanksList as Bank[]).filter((b) => b.active !== false)
    } catch (err: any) {
      console.warn('Failed to fetch banks from Paystack API, using local fallback:', err?.message)
      return (staticBanksList as Bank[]).filter((b) => b.active !== false)
    }
  }

  /**
   * Resolves a Nigerian bank account number to its registered account name using Paystack NUBAN API.
   * Server-only, strictly requiring 10 digits and a bank code.
   */
  async resolveAccount(
    bankCode: string,
    accountNumber: string,
  ): Promise<AccountResolutionResult> {
    if (customTestProvider) {
      return customTestProvider.resolveAccount(bankCode, accountNumber)
    }

    const cleanBankCode = bankCode?.trim()
    const cleanAccountNumber = accountNumber?.trim()

    if (!cleanBankCode) {
      throw new AppError(
        'INVALID_BANK_CODE',
        'Bank selection is required before resolving account number.',
        { statusCode: 400 },
      )
    }

    if (!/^\d{10}$/.test(cleanAccountNumber)) {
      throw new AppError(
        'INVALID_ACCOUNT_NUMBER',
        'Account number must be exactly 10 digits.',
        { statusCode: 400 },
      )
    }

    const secretKey = this.getSecretKey()

    // Deterministic fallback for dev/test when PAYSTACK_SECRET_KEY is not configured
    if (!secretKey) {
      return this.mockResolveAccount(cleanBankCode, cleanAccountNumber)
    }

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

      const url = `${PAYSTACK_BASE_URL}/bank/resolve?account_number=${encodeURIComponent(
        cleanAccountNumber,
      )}&bank_code=${encodeURIComponent(cleanBankCode)}`

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      })

      clearTimeout(timer)

      if (response.status === 422) {
        throw new AppError(
          'INVALID_BANK_ACCOUNT',
          'Could not resolve account name. Please verify the account number and selected bank.',
          { statusCode: 422 },
        )
      }

      if (response.status === 429) {
        throw new AppError(
          'RATE_LIMIT_EXCEEDED',
          'Bank verification rate limit reached. Please wait a moment and try again.',
          { statusCode: 429 },
        )
      }

      if (!response.ok) {
        throw new AppError(
          'BANK_SERVICE_UNAVAILABLE',
          'Bank verification provider is currently unreachable. Please try again shortly.',
          { statusCode: 502 },
        )
      }

      const body = await response.json()
      if (!body.status || !body.data?.account_name) {
        throw new AppError(
          'INVALID_BANK_ACCOUNT',
          'Could not resolve account name with the selected bank.',
          { statusCode: 422 },
        )
      }

      return {
        accountName: String(body.data.account_name).trim(),
        accountNumber: cleanAccountNumber,
        bankCode: cleanBankCode,
      }
    } catch (err: any) {
      if (err instanceof AppError) throw err

      if (err.name === 'AbortError') {
        throw new AppError(
          'BANK_SERVICE_TIMEOUT',
          'Bank verification request timed out. Please check your connection and try again.',
          { statusCode: 504 },
        )
      }

      throw new AppError(
        'BANK_SERVICE_UNAVAILABLE',
        'Bank verification service is currently unavailable. Please try again shortly.',
        { statusCode: 502 },
      )
    }
  }

  /**
   * Deterministic local mock resolution for test and offline dev environments.
   */
  private mockResolveAccount(
    bankCode: string,
    accountNumber: string,
  ): AccountResolutionResult {
    // Known test triggers
    if (accountNumber === '0000000000') {
      throw new AppError(
        'INVALID_BANK_ACCOUNT',
        'Could not resolve account name. Please verify the account number and selected bank.',
        { statusCode: 422 },
      )
    }

    if (accountNumber === '9999999999') {
      throw new AppError(
        'RATE_LIMIT_EXCEEDED',
        'Bank verification rate limit reached. Please wait a moment and try again.',
        { statusCode: 429 },
      )
    }

    let accountName = 'Olumide Bakare'
    if (accountNumber.startsWith('0')) {
      accountName = 'Ade Wale'
    } else if (accountNumber.startsWith('1')) {
      accountName = 'Chinelo Ngozi'
    } else if (accountNumber.startsWith('2')) {
      accountName = 'Chinedu Okafor'
    } else if (accountNumber.startsWith('3')) {
      accountName = 'Amina Ibrahim'
    } else if (accountNumber.startsWith('8')) {
      accountName = 'P301 Test Member'
    }

    return {
      accountName,
      accountNumber,
      bankCode,
    }
  }
}

export const bankProvider: IBankProvider = new PaystackBankProvider()
