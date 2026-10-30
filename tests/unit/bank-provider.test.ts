import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  checkNameSimilarity,
  normalizeNameTokens,
} from '@/lib/banking/provider'
import {
  PaystackBankProvider,
  setBankProviderForTesting,
} from '@/lib/banking/paystack.provider'
import { AppError } from '@/lib/errors/app-error'
import { generateMemberPaymentReference } from '@/lib/domain/payment-reference'

describe('Bank Provider & Verification (Unit Tests)', () => {
  beforeEach(() => {
    setBankProviderForTesting(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setBankProviderForTesting(null)
  })

  describe('normalizeNameTokens & checkNameSimilarity', () => {
    it('normalizes names and strips professional / honorary titles', () => {
      const tokens1 = normalizeNameTokens('Dr. Adebayo Olumide Wale (Esq)')
      expect(tokens1).toEqual(['adebayo', 'olumide', 'wale', 'esq'])

      const tokens2 = normalizeNameTokens('Alhaji Chief Pastor Musa Ibrahim')
      expect(tokens2).toEqual(['musa', 'ibrahim'])
    })

    it('matches exact name matches and permuted token orders', () => {
      const exact = checkNameSimilarity('Ade Wale', 'ADE WALE')
      expect(exact.isMatch).toBe(true)
      expect(exact.similarityScore).toBe(1)

      const permuted = checkNameSimilarity('Ade Wale', 'Wale Ade')
      expect(permuted.isMatch).toBe(true)
    })

    it('matches names with additional middle name or initials', () => {
      const withMiddle = checkNameSimilarity('Ade Wale', 'Ade Samuel Wale')
      expect(withMiddle.isMatch).toBe(true)
      expect(withMiddle.similarityScore).toBeGreaterThanOrEqual(0.6)

      const withTitle = checkNameSimilarity('Chief Olumide Bakare', 'Bakare Olumide')
      expect(withTitle.isMatch).toBe(true)
    })

    it('detects and flags blatant name mismatches', () => {
      const mismatch = checkNameSimilarity('Ade Wale', 'Emeka Chukwu Okafor')
      expect(mismatch.isMatch).toBe(false)
      expect(mismatch.reason).toContain('does not closely match')
    })
  })

  describe('PaystackBankProvider - Account Resolution', () => {
    const provider = new PaystackBankProvider()

    it('validates 10-digit account numbers and non-empty bank code before network call', async () => {
      await expect(provider.resolveAccount('', '0123456789')).rejects.toThrowError(
        'Bank selection is required',
      )

      await expect(provider.resolveAccount('058', '12345')).rejects.toThrowError(
        'Account number must be exactly 10 digits',
      )

      await expect(provider.resolveAccount('058', 'abcdefghij')).rejects.toThrowError(
        'Account number must be exactly 10 digits',
      )
    })

    it('handles successful API resolution with authorization bearer token', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_mock_paystack_key'

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: true,
          data: {
            account_number: '0123456789',
            account_name: 'ADEBAYO SAMUEL OLUMIDE',
            bank_id: 9,
          },
        }),
      })
      global.fetch = mockFetch as any

      const res = await provider.resolveAccount('058', '0123456789')
      expect(res.accountName).toBe('ADEBAYO SAMUEL OLUMIDE')
      expect(res.accountNumber).toBe('0123456789')
      expect(res.bankCode).toBe('058')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('account_number=0123456789&bank_code=058'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer sk_test_mock_paystack_key',
          }),
        }),
      )
    })

    it('handles 422 unresolvable account with descriptive AppError', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_mock_paystack_key'

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ status: false, message: 'Could not resolve account name' }),
      }) as any

      await expect(provider.resolveAccount('058', '0000000000')).rejects.toThrowError(
        /Could not resolve account name/,
      )
    })

    it('handles 429 rate limit errors gracefully without crashing', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_mock_paystack_key'

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ status: false, message: 'Too Many Requests' }),
      }) as any

      await expect(provider.resolveAccount('058', '1122334455')).rejects.toThrowError(
        /rate limit reached/,
      )
    })

    it('handles network timeouts cleanly with 504 AppError', async () => {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_mock_paystack_key'

      global.fetch = vi.fn().mockImplementation(() => {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        return Promise.reject(err)
      }) as any

      await expect(provider.resolveAccount('058', '0123456789')).rejects.toThrowError(
        /timed out/,
      )
    })

    it('returns banks list (falling back to bundled list if network fails)', async () => {
      delete process.env.PAYSTACK_SECRET_KEY
      const banks = await provider.listBanks()
      expect(Array.isArray(banks)).toBe(true)
      expect(banks.length).toBeGreaterThan(0)
      const accessBank = banks.find((b) => b.name.includes('Access Bank') || b.code === '044')
      expect(accessBank).toBeDefined()
    })
  })

  describe('Transfer Narration Formatting (§1.2)', () => {
    it('generates correct deposit references with membership numbers', () => {
      expect(generateMemberPaymentReference('CK000123', 'SAV')).toBe('CK000123 SAV')
      expect(generateMemberPaymentReference('CK000123', 'LOAN')).toBe('CK000123 LOAN')
      expect(generateMemberPaymentReference('CK000123', 'AJO')).toBe('CK000123 AJO')
      expect(generateMemberPaymentReference('CK000123', 'WAL')).toBe('CK000123 WAL')
    })

    it('maps product purpose keys to canonical 3-letter codes', () => {
      expect(generateMemberPaymentReference('CK-000045', 'SAVINGS_FIRST_DEPOSIT')).toBe('CK-000045 SAV')
      expect(generateMemberPaymentReference('CK-000045', 'LOAN_REPAYMENT')).toBe('CK-000045 LOAN')
      expect(generateMemberPaymentReference('CK-000045', 'EAJO_CONTRIBUTION')).toBe('CK-000045 AJO')
      expect(generateMemberPaymentReference('CK-000045', 'WALLET_TOPUP')).toBe('CK-000045 WAL')
    })
  })
})
