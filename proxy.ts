import { NextResponse } from 'next/server'
import { auth } from './auth'
import { loggedInRestrictedRoutes, publicRoutes } from './routes-def'

export const proxy = auth((req) => {
  const pathname = req.nextUrl.pathname
  const session = req.auth
  const sessionUser = session?.user as
    | { id?: string; role?: string; hasSetPassword?: boolean }
    | undefined
  const userRole = sessionUser?.role
  const userId = sessionUser?.id

  const isPublicRoute = publicRoutes.includes(pathname)
  const isAdminRoute = pathname.startsWith('/admin')
  const isUserRoute = pathname.startsWith('/dashboard')
  const isAdminUser = userRole === 'ADMIN' || userRole === 'OWNER'

  // Redirect to admin or user page if user is logged in
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

  // Redirect to unauthorized page if user is not a regular member
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
