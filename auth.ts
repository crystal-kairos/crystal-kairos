import NextAuth, { CredentialsSignin } from 'next-auth'
import { PrismaAdapter } from '@auth/prisma-adapter'
import { prisma } from './lib/prisma'
import Credentials from 'next-auth/providers/credentials'
import { MembershipStatus, UserRole } from './generated/prisma/enums'
import bcrypt from 'bcryptjs'

class InvalidCredentialsError extends CredentialsSignin {
  code = 'invalid_credentials'
}

class AccountNotActivatedError extends CredentialsSignin {
  code = 'account_not_activated'
}

class PasswordNotSetError extends CredentialsSignin {
  code = 'password_not_set'
}

class UserNotFoundError extends CredentialsSignin {
  code = 'user_not_found'
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
        if (!credentials.email) return null
        if (!credentials.password) return null

        const user = await prisma.user.findUnique({
          where: {
            email: credentials.email as string,
          },
          include: {
            membership: true,
          },
        })

        if (!user) {
          throw new UserNotFoundError()
        }

        if (user.membership?.status === MembershipStatus.PENDING) {
          throw new AccountNotActivatedError()
        }

        if (!user.passwordHash) {
          throw new PasswordNotSetError()
        }

        const isMatch = await bcrypt.compare(
          credentials.password as string,
          user.passwordHash as string,
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
        token.role = (user as any).role as UserRole
        token.id = user.id
        token.hasSetPassword = (user as any).hasSetPassword
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        ;(session.user as any).role = token.role
        session.user.id = token.id as string
        ;(session.user as any).hasSetPassword = token.hasSetPassword
      }
      return session
    },
  },
})
