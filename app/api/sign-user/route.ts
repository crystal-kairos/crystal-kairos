import { NextResponse } from 'next/server'

/**
 * Unauthenticated token signing and verification via caller-supplied userId/userEmail
 * has been retired (PR P1-02). Password setup tokens are now cryptographically random,
 * single-use records issued only inside authenticated server workflows via `lib/authz/tokens.ts`.
 */
export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error: 'Direct token issuance is not permitted.',
    },
    { status: 403 },
  )
}

export async function GET() {
  return NextResponse.json(
    {
      success: false,
      error: 'Direct token verification is not permitted.',
    },
    { status: 403 },
  )
}
