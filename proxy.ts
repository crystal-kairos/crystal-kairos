import { NextResponse } from 'next/server'
import { auth } from './auth'
import { loggedInRestrictedRoutes, publicRoutes } from './routes-def'
import { prisma } from './lib/prisma'

export const proxy = auth(async (req) => {
  const pathname = req.nextUrl.pathname
  const session = req.auth
  const sessionUser = session?.user as
    | {
        id?: string
        role?: string
        hasSetPassword?: boolean
        mfaEnabled?: boolean
        mfaVerified?: boolean
      }
    | undefined
  const userRole = sessionUser?.role
  const userId = sessionUser?.id

  const isPublicRoute = publicRoutes.includes(pathname)
  const isAdminRoute = pathname.startsWith('/admin')
  const isUserRoute = pathname.startsWith('/dashboard')
  const isAdminUser = userRole === 'ADMIN' || userRole === 'OWNER'

  // Redirect to admin or user page if user is logged in and trying to visit login/register
  if (loggedInRestrictedRoutes.includes(pathname) && session) {
    if (isAdminUser) {
      return NextResponse.redirect(new URL('/admin', req.url))
    } else {
      return NextResponse.redirect(new URL(`/dashboard/${userId}`, req.url))
    }
  }

  // If user is on /set-password but has already set their password, redirect them
  if (pathname === '/set-password' && session && sessionUser?.hasSetPassword) {
    if (isAdminUser) {
      return NextResponse.redirect(new URL('/admin', req.url))
    } else {
      return NextResponse.redirect(new URL(`/dashboard/${userId}`, req.url))
    }
  }

  // Redirect to login page if user is not logged in and not a public route
  if (!session && !isPublicRoute) {
    const newUrl = new URL('/login', req.url)
    return NextResponse.redirect(newUrl)
  }

  // Redirect to unauthorized page if user is not an admin/owner
  if (isAdminRoute && !isAdminUser) {
    return NextResponse.redirect(new URL('/unauthorized', req.url))
  }

  // P1-07: Staff users (OWNER and ADMIN) must enrol in MFA before opening any /admin page
  if (isAdminRoute && isAdminUser) {
    let mfaEnabled = sessionUser?.mfaEnabled
    if (!mfaEnabled && sessionUser?.id) {
      const dbUser = await prisma.user.findUnique({
        where: { id: sessionUser.id },
        select: { mfaEnabled: true },
      })
      mfaEnabled = dbUser?.mfaEnabled ?? false
    }

    if (!mfaEnabled && pathname !== '/security' && !pathname.startsWith('/security/')) {
      const securityUrl = new URL('/security', req.url)
      securityUrl.searchParams.set('reason', 'mfa_required')
      securityUrl.searchParams.set('callbackUrl', req.nextUrl.pathname)
      return NextResponse.redirect(securityUrl)
    }
  }

  // Redirect to unauthorized page if user is not a regular member attempting user dashboard
  if (session && isUserRoute) {
    if (userRole !== 'USER') {
      return NextResponse.redirect(new URL('/unauthorized', req.url))
    }

    // Check if user has set their password
    if (
      sessionUser &&
      !sessionUser.hasSetPassword &&
      pathname !== '/set-password'
    ) {
      return NextResponse.redirect(new URL('/set-password', req.url))
    }
  }

  return NextResponse.next()
})

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
