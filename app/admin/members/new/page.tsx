import NewMemberClient from '@/components/admin/members/NewMemberClient'
import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Add New Member | Crystal Kairos Admin',
}

export default function NewMemberPage() {
  return <NewMemberClient />
}
