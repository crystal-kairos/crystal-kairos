import { NextRequest, NextResponse } from 'next/server'
import { AuthzError } from '@/lib/authz/guards'
import { authorizeAndResolveStoredFile } from '@/lib/storage/cloudinary'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> },
) {
  try {
    const { fileId } = await params
    if (!fileId) {
      return new NextResponse('File ID is required', {
        status: 400,
        headers: NO_STORE_HEADERS,
      })
    }

    const { signedUrl } = await authorizeAndResolveStoredFile(fileId)

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

    return new NextResponse('Unable to retrieve file.', {
      status: 500,
      headers: NO_STORE_HEADERS,
    })
  }
}
