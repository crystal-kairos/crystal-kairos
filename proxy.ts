import { NextResponse } from 'next/server'
import { auth } from './auth'
import { loggedInRestrictedRoutes, publicRoutes } from './routes-def'
import { prisma } from './lib/prisma'

function clearAuthCookies(res: NextResponse) {
  res.cookies.delete('authjs.session-token')
  res.cookies.delete('__Secure-authjs.session-token')
  res.cookies.delete('next-auth.session-token')
  res.cookies.delete('__Secure-next-auth.session-token')
}

export const proxy = auth(async (req) => {
  const pathname = req.nextUrl.pathname
  const session = req.auth
  const sessionUser = session?.user as
    | {
        id?: string
        role?: string
        hasSetPassword?: boolean
        sessionVersion?: number
        sid?: string
        mfaEnabled?: boolean
        mfaVerified?: boolean
      }
    | undefined
  const userRole = sessionUser?.role
  const userId = sessionUser?.id

  // Validate live session from database if session token is presented
  let dbUser = null
  let isSessionValid = false

  if (session && sessionUser?.id) {
    try {
      dbUser = await prisma.user.findUnique({
        where: { id: sessionUser.id },
        select: {
          id: true,
          role: true,
          sessionVersion: true,
          isActive: true,
          mfaEnabled: true,
        },
      })

      if (
        dbUser &&
        dbUser.isActive !== false &&
        dbUser.role === userRole &&
        (sessionUser.sessionVersion === undefined ||
          dbUser.sessionVersion === sessionUser.sessionVersion)
      ) {
        isSessionValid = true
      }
    } catch {
      isSessionValid = false
    }
  }

  const isPublicRoute = publicRoutes.includes(pathname)
  const isAdminRoute = pathname.startsWith('/admin')
  const isUserRoute = pathname.startsWith('/dashboard')
  const isSwitchAccount = req.nextUrl.searchParams.get('switch') === 'true'

  // If a stale or invalidated session cookie is present
  if (session && !isSessionValid) {
    // If accessing login/restricted public routes, allow the login form and purge the stale cookies
    if (loggedInRestrictedRoutes.includes(pathname) || isPublicRoute) {
      const res = NextResponse.next()
      clearAuthCookies(res)
      return res
    }
    // If attempting to access any protected route with an invalid session, bounce to login with cleared cookies
    const redirectRes = NextResponse.redirect(new URL('/login', req.url))
    clearAuthCookies(redirectRes)
    return redirectRes
  }

  // Redirect to admin or user page if user is validly logged in and trying to visit login/register (unless switching accounts)
  if (loggedInRestrictedRoutes.includes(pathname) && session && isSessionValid) {
    if (isSwitchAccount) {
      const res = NextResponse.next()
      clearAuthCookies(res)
      return res
    }
    const isAdminUser = userRole === 'ADMIN' || userRole === 'OWNER'
    if (isAdminUser) {
      return NextResponse.redirect(new URL('/admin', req.url))
    } else {
      return NextResponse.redirect(new URL(`/dashboard/${userId}`, req.url))
    }
  }

  // If user is on /set-password but has already set their password, redirect them
  if (pathname === '/set-password' && session && sessionUser?.hasSetPassword && isSessionValid) {
    const isAdminUser = userRole === 'ADMIN' || userRole === 'OWNER'
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

  const isAdminUser = userRole === 'ADMIN' || userRole === 'OWNER'

  // Redirect to unauthorized page if user is not an admin/owner
  if (isAdminRoute && !isAdminUser) {
    return NextResponse.redirect(new URL('/unauthorized', req.url))
  }

  // P1-07: Staff users (OWNER and ADMIN) must enrol in MFA before opening any /admin page
  if (isAdminRoute && isAdminUser) {
    const mfaEnabled = dbUser?.mfaEnabled ?? sessionUser?.mfaEnabled ?? false

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
