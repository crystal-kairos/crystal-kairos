import NextAuth, { CredentialsSignin } from 'next-auth'
import { PrismaAdapter } from '@auth/prisma-adapter'
import { prisma } from './lib/prisma'
import Credentials from 'next-auth/providers/credentials'
import { MembershipStatus, UserRole } from './generated/prisma/enums'
import bcrypt from 'bcryptjs'
import { checkLockout, recordLoginAttempt } from '@/lib/authz/lockout'
import { createUserSession } from '@/lib/authz/sessions'

class InvalidCredentialsError extends CredentialsSignin {
  code = 'invalid_credentials'
}

export const { auth, signIn, signOut, handlers } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: {
    strategy: 'jwt',
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new InvalidCredentialsError()
        }

        const email = (credentials.email as string).trim().toLowerCase()
        const password = credentials.password as string

        // 1. Check account lockout (5 failures in 15 mins -> locked)
        const lockout = await checkLockout(email)
        if (lockout.isLocked) {
          // Do not reveal whether the email exists; always throw InvalidCredentialsError
          throw new InvalidCredentialsError()
        }

        const user = await prisma.user.findUnique({
          where: { email },
          include: {
            membership: true,
          },
        })

        // Generic error on all login failures to prevent email or status enumeration.
        // A member with MembershipStatus.PENDING is permitted to sign in to finish their profile (§1.1, P2-01).
        // Deactivated users (isActive === false) or rejected memberships are blocked.
        if (
          !user ||
          user.membership?.status === MembershipStatus.REJECTED ||
          !user.passwordHash ||
          !user.hasSetPassword ||
          user.isActive === false
        ) {
          await recordLoginAttempt({
            email,
            succeeded: false,
            userId: user?.id,
          })
          throw new InvalidCredentialsError()
        }

        const isMatch = await bcrypt.compare(password, user.passwordHash)

        if (!isMatch) {
          await recordLoginAttempt({
            email,
            succeeded: false,
            userId: user.id,
          })
          throw new InvalidCredentialsError()
        }

        // Record successful login attempt (clears failure counters)
        await recordLoginAttempt({
          email,
          succeeded: true,
          userId: user.id,
        })

        // Create database-backed UserSession
        const dbSession = await createUserSession({
          userId: user.id,
          role: user.role,
          mfaVerified: false,
        })

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          hasSetPassword: user.hasSetPassword,
          sessionVersion: user.sessionVersion,
          mfaEnabled: user.mfaEnabled,
          sessionId: dbSession.id,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        const typedUser = user as {
          id?: string
          role?: UserRole
          hasSetPassword?: boolean
          sessionVersion?: number
          mfaEnabled?: boolean
          sessionId?: string
        }
        token.role = typedUser.role
        token.id = typedUser.id
        token.hasSetPassword = typedUser.hasSetPassword
        token.sessionVersion = typedUser.sessionVersion ?? 0
        token.mfaEnabled = typedUser.mfaEnabled ?? false
        token.sid = typedUser.sessionId
      }

      if (trigger === 'update') {
        if (session && typeof session === 'object') {
          const sessionPayload = session as Record<string, unknown>
          if (typeof sessionPayload.mfaEnabled === 'boolean') {
            token.mfaEnabled = sessionPayload.mfaEnabled
          }
        }
        if (token.id) {
          const freshUser = await prisma.user.findUnique({
            where: { id: token.id as string },
            select: {
              mfaEnabled: true,
              sessionVersion: true,
              role: true,
              hasSetPassword: true,
            },
          })
          if (freshUser) {
            token.mfaEnabled = freshUser.mfaEnabled
            token.sessionVersion = freshUser.sessionVersion
            token.role = freshUser.role
            token.hasSetPassword = freshUser.hasSetPassword
          }
        }
      } else if (token.id && !token.mfaEnabled) {
        const freshUser = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: { mfaEnabled: true },
        })
        if (freshUser?.mfaEnabled) {
          token.mfaEnabled = true
        }
      }

      return token
    },
    async session({ session, token }) {
      if (session.user) {
        const sessionUser = session.user as {
          id?: string
          role?: unknown
          hasSetPassword?: unknown
          sessionVersion?: unknown
          mfaEnabled?: unknown
          sid?: unknown
        }
        sessionUser.role = token.role
        session.user.id = token.id as string
        sessionUser.hasSetPassword = token.hasSetPassword
        sessionUser.sessionVersion = token.sessionVersion ?? 0
        sessionUser.mfaEnabled = token.mfaEnabled ?? false
        sessionUser.sid = token.sid
      }
      return session
    },
  },
})
