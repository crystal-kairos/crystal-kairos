import { Gender } from '@/generated/prisma/enums'

export const userInfos = [
  {
    address: '123 Main Street, Lagos',
    dateOfBirth: new Date('1990-01-15'),
    gender: Gender.MALE,
    occupation: 'Software Engineer',
    phoneNumber: '+2348012345678',
    stateOfOrigin: 'Lagos',
  },
  {
    address: '456 Oak Avenue, Abuja',
    dateOfBirth: new Date('1985-06-20'),
    gender: Gender.FEMALE,
    occupation: 'Teacher',
    phoneNumber: '+2348098765432',
    stateOfOrigin: 'Abuja',
  },
  {
    address: '789 Pine Road, Port Harcourt',
    dateOfBirth: new Date('1985-06-20'),
    gender: Gender.FEMALE,
    occupation: 'Doctor',
    phoneNumber: '+2348023456789',
    stateOfOrigin: 'Rivers',
  },
  {
    address: '101 Elm Street, Enugu',
    dateOfBirth: new Date('1985-06-20'),
    gender: Gender.MALE,
    occupation: 'Software Engineer',
    phoneNumber: '+2348034567890',
    stateOfOrigin: 'Enugu',
  },
]
