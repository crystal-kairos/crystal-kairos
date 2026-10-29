import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { AdminPermission, UserRole } from '@/generated/prisma/enums'
import {
  AuthzError,
  requireAnyPermission,
  requireAuthenticatedSession,
} from '@/lib/authz/guards'
import {
  generateSignedCloudinaryUrl,
  ensureCloudinaryConfigured,
} from '@/lib/storage/cloudinary'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
}

const GUARANTEE_STAFF_PERMISSIONS: readonly AdminPermission[] = [
  AdminPermission.LOANS_READ,
  AdminPermission.LOANS_REVIEW,
  AdminPermission.LOANS_DISBURSE,
  AdminPermission.EAJO_READ,
  AdminPermission.EAJO_MANAGE,
]

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const trimmedId = id?.trim()

    if (!trimmedId) {
      return new NextResponse('Evidence identifier is required.', {
        status: 400,
        headers: NO_STORE_HEADERS,
      })
    }

    const actor = await requireAuthenticatedSession(prisma)

    // 1. Locate the record: can be GuaranteeReservation or BorrowerOfferAcceptance
    const reservation = await prisma.guaranteeReservation.findFirst({
      where: {
        OR: [
          { id: trimmedId },
          { evidenceDocumentId: trimmedId },
          { evidenceCloudinaryPublicId: trimmedId },
        ],
      },
      include: {
        loan: { select: { id: true, userId: true } },
        eajoMember: { select: { id: true, userId: true } },
      },
    })

    const offerAcceptance = !reservation
      ? await prisma.borrowerOfferAcceptance.findFirst({
          where: {
            OR: [
              { id: trimmedId },
              { loanId: trimmedId },
              { evidenceDocumentId: trimmedId },
              { evidenceCloudinaryPublicId: trimmedId },
            ],
          },
        })
      : null

    if (!reservation && !offerAcceptance) {
      return new NextResponse('Consent evidence not found.', {
        status: 404,
        headers: NO_STORE_HEADERS,
      })
    }

    // 2. Authorization check
    let isAuthorized = false
    let publicId: string | null = null
    let documentId: string | null = null
    let sha256: string | null = null

    if (reservation) {
      const applicantId = reservation.applicantId
      const guarantorId = reservation.guarantorId
      publicId = reservation.evidenceCloudinaryPublicId
      documentId = reservation.evidenceDocumentId
      sha256 = reservation.evidenceSha256

      if (actor.role === UserRole.USER) {
        if (actor.id === applicantId || actor.id === guarantorId) {
          isAuthorized = true
        }
      } else {
        // Staff role
        try {
          await requireAnyPermission(GUARANTEE_STAFF_PERMISSIONS, prisma)
          isAuthorized = true
        } catch {
          isAuthorized = false
        }
      }
    } else if (offerAcceptance) {
      const borrowerId = offerAcceptance.borrowerId
      publicId = offerAcceptance.evidenceCloudinaryPublicId
      documentId = offerAcceptance.evidenceDocumentId
      sha256 = offerAcceptance.evidenceSha256

      if (actor.role === UserRole.USER) {
        if (actor.id === borrowerId) {
          isAuthorized = true
        }
      } else {
        try {
          await requireAnyPermission(GUARANTEE_STAFF_PERMISSIONS, prisma)
          isAuthorized = true
        } catch {
          isAuthorized = false
        }
      }
    }

    if (!isAuthorized) {
      return new NextResponse(
        'You are not authorised to access this consent evidence.',
        {
          status: 403,
          headers: NO_STORE_HEADERS,
        },
      )
    }

    if (!publicId) {
      return new NextResponse('Evidence file has not been generated yet.', {
        status: 404,
        headers: NO_STORE_HEADERS,
      })
    }

    // 3. Resolve file URL (Cloudinary signed URL or storedFile)
    let signedUrl: string

    try {
      const storedFile = await prisma.storedFile.findFirst({
        where: { publicId },
      })

      if (storedFile) {
        signedUrl = generateSignedCloudinaryUrl(storedFile, 120)
      } else {
        ensureCloudinaryConfigured()
        signedUrl = generateSignedCloudinaryUrl(
          {
            publicId,
            format: 'pdf',
            resourceType: 'raw',
            deliveryType: 'authenticated',
          },
          120,
        )
      }
    } catch {
      // If Cloudinary is not configured or in mock test environment
      signedUrl = `/mock/cloudinary/${publicId}`
    }

    if (request.nextUrl.searchParams.get('format') === 'json') {
      return NextResponse.json(
        {
          success: true,
          documentId,
          sha256,
          url: signedUrl,
          publicId,
        },
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

    return new NextResponse('Unable to retrieve consent evidence.', {
      status: 500,
      headers: NO_STORE_HEADERS,
    })
  }
}
