import { UserRole } from '@/generated/prisma/enums'

export const users = [
  {
    email: 'admin@crystalkairos.com',
    username: 'admin',
    name: 'Admin User',
    password: 'admin123!',
    role: UserRole.ADMIN,
    hasSetPassword: true,
    mfaEnabled: true,
  },
  {
    email: 'owner@crystalkairos.com',
    username: 'owner',
    name: 'Owner User',
    password: 'owner123!',
    role: UserRole.OWNER,
    hasSetPassword: true,
    mfaEnabled: true,
  },
  {
    email: 'member1@example.com',
    username: 'member1',
    name: 'John Doe',
    password: 'member123!',
    role: UserRole.USER,
    hasSetPassword: true,
  },
  {
    email: 'member2@example.com',
    username: 'member2',
    name: 'Jane Smith',
    password: 'member123!',
    role: UserRole.USER,
    hasSetPassword: true,
  },
  {
    email: 'member3@example.com',
    username: 'member3',
    name: 'Omotola Olaiya',
    password: 'member123!',
    role: UserRole.USER,
    hasSetPassword: true,
  },
  {
    email: 'member4@example.com',
    username: 'member4',
    name: 'Mike Adebayo',
    role: UserRole.USER,
    hasSetPassword: false,
  },
]
