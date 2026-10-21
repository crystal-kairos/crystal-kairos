import { NextRequest, NextResponse } from 'next/server'
import { AuthzError } from '@/lib/authz/guards'
import { authorizeAndResolveStoredFile } from '@/lib/storage/cloudinary'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
}

/**
 * Legacy receipt route replaced with Cloudinary-only authenticated delivery.
 * Never reads from local filesystem or returns public cache headers.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  try {
    const { filename } = await params
    if (!filename) {
      return new NextResponse('Filename is required', {
        status: 400,
        headers: NO_STORE_HEADERS,
      })
    }

    const { signedUrl } = await authorizeAndResolveStoredFile(filename)

    if (request.nextUrl.searchParams.get('format') === 'json') {
      return NextResponse.json(
        { success: true, url: signedUrl },
        { status: 200, headers: NO_STORE_HEADERS },
      )
    }

    return NextResponse.redirect(signedUrl, {
      status: 302,
      headers: NO_STORE_HEADERS,
    })
  } catch (error) {
    if (error instanceof AuthzError) {
      const status =
        error.code === 'UNAUTHENTICATED'
          ? 401
          : error.code === 'NOT_FOUND'
            ? 404
            : 403
      return new NextResponse(error.message, {
        status,
        headers: NO_STORE_HEADERS,
      })
    }

    return new NextResponse('Unable to retrieve receipt.', {
      status: 500,
      headers: NO_STORE_HEADERS,
    })
  }
}
