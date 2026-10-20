import NextAuth, { CredentialsSignin } from 'next-auth'
import { PrismaAdapter } from '@auth/prisma-adapter'
import { prisma } from './lib/prisma'
import Credentials from 'next-auth/providers/credentials'
import { MembershipStatus, UserRole } from './generated/prisma/enums'
import bcrypt from 'bcryptjs'

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
        if (!credentials.email || !credentials.password) {
          throw new InvalidCredentialsError()
        }

        const user = await prisma.user.findUnique({
          where: {
            email: credentials.email as string,
          },
          include: {
            membership: true,
          },
        })

        // Generic error on all login failures to prevent email or status enumeration
        if (
          !user ||
          user.membership?.status === MembershipStatus.PENDING ||
          user.membership?.status === MembershipStatus.REJECTED ||
          !user.passwordHash ||
          !user.hasSetPassword
        ) {
          throw new InvalidCredentialsError()
        }

        const isMatch = await bcrypt.compare(
          credentials.password as string,
          user.passwordHash,
        )

        if (!isMatch) {
          throw new InvalidCredentialsError()
        }

        return user
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const typedUser = user as {
          id?: string
          role?: UserRole
          hasSetPassword?: boolean
        }
        token.role = typedUser.role
        token.id = typedUser.id
        token.hasSetPassword = typedUser.hasSetPassword
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        const sessionUser = session.user as {
          id?: string
          role?: unknown
          hasSetPassword?: unknown
        }
        sessionUser.role = token.role
        session.user.id = token.id as string
        sessionUser.hasSetPassword = token.hasSetPassword
      }
      return session
    },
  },
})
