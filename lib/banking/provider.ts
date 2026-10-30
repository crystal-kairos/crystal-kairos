/**
 * Bank Integration Provider Abstraction (§2.1, P3-02)
 * Defines standard interfaces for Nigerian bank listing, account number resolution,
 * and name-matching heuristics.
 */

export interface Bank {
  name: string
  code: string
  slug?: string
  id?: number
  active?: boolean
  country?: string
  currency?: string
  type?: string
}

export interface AccountResolutionResult {
  accountName: string
  accountNumber: string
  bankCode: string
  bankName?: string
}

export interface NameMatchResult {
  isMatch: boolean
  similarityScore: number
  reason?: string
}

export interface IBankProvider {
  listBanks(): Promise<Bank[]>
  resolveAccount(bankCode: string, accountNumber: string): Promise<AccountResolutionResult>
}

const NOISE_TITLES = new Set([
  'mr',
  'mrs',
  'ms',
  'miss',
  'dr',
  'prof',
  'professor',
  'chief',
  'alhaji',
  'alhaja',
  'pastor',
  'engr',
  'engineer',
  'barr',
  'barrister',
  'arc',
  'architect',
  'rev',
  'reverend',
])

/**
 * Normalizes a personal or account name for robust comparison:
 * Lowercases, strips punctuation, removes noise titles.
 */
export function normalizeNameTokens(name: string): string[] {
  if (!name) return []

  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !NOISE_TITLES.has(token))
}

/**
 * Checks similarity between a member's registered name and the bank account holder name (§2.1).
 * Passing requires a reasonable token overlap (e.g. first and last names matching,
 * even if middle name or token order differs).
 */
export function checkNameSimilarity(
  registeredName: string,
  resolvedName: string,
): NameMatchResult {
  const regTokens = normalizeNameTokens(registeredName)
  const resTokens = normalizeNameTokens(resolvedName)

  if (regTokens.length === 0 || resTokens.length === 0) {
    return {
      isMatch: false,
      similarityScore: 0,
      reason: 'One or both names could not be evaluated.',
    }
  }

  const resSet = new Set(resTokens)
  const regSet = new Set(regTokens)

  const commonInRes = regTokens.filter((t) => resSet.has(t))
  const commonInReg = resTokens.filter((t) => regSet.has(t))

  const uniqueMatches = new Set([...commonInRes, ...commonInReg]).size
  const totalUniqueTokens = new Set([...regTokens, ...resTokens]).size

  // Jaccard similarity index
  const similarityScore = Math.round((uniqueMatches / totalUniqueTokens) * 100) / 100

  // Match rule:
  // 1. If at least 2 distinct tokens match (e.g. first and last name match), OR
  // 2. All tokens of the shorter name are present in the longer name (e.g. "Ade Wale" inside "Ade Wale Samuel")
  const minTokenCount = Math.min(regTokens.length, resTokens.length)
  const allShorterMatch = commonInRes.length >= minTokenCount

  const isMatch = uniqueMatches >= 2 || (minTokenCount >= 1 && allShorterMatch) || similarityScore >= 0.5

  if (!isMatch) {
    return {
      isMatch: false,
      similarityScore,
      reason: `Account name "${resolvedName}" does not closely match registered name "${registeredName}".`,
    }
  }

  return {
    isMatch: true,
    similarityScore,
  }
}
