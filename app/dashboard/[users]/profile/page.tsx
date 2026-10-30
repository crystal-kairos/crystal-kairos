import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { getMemberById } from '@/models/members/query'
import { StatusPill } from '@/components/ui/StatusPill'
import { NextOfKinCard } from '@/components/members/NextOfKinCard'
import { EditNextOfKinDialog } from '@/components/members/EditNextOfKinDialog'
import { getMemberPendingProfileChangesAction } from '@/models/members/profile-change-actions'
import { ProfileChangeType } from '@/generated/prisma/enums'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  User,
  Phone,
  Mail,
  MapPin,
  Calendar,
  Briefcase,
  Award,
  ShieldAlert,
  Landmark,
  ArrowRight,
} from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

interface PageProps {
  params: Promise<{ users: string }>
}

export default async function ProfilePage({ params }: PageProps) {
  const session = await auth()
  if (!session) {
    redirect('/login')
  }

  const profileId = (await params).users
  const isSelf = session.user.id === profileId
  const isAdmin = session.user.role === 'ADMIN' || session.user.role === 'OWNER'

  // Access Control: Only self or admin/owner can view
  if (!isSelf && !isAdmin) {
    return (
      <div className='flex flex-col items-center justify-center min-h-[50vh] gap-3'>
        <ShieldAlert className='w-12 h-12 text-error' />
        <h3 className='font-bold text-lg text-primary'>Access Denied</h3>
        <p className='text-muted-foreground text-sm max-w-sm text-center'>
          You do not have permission to view this next-of-kin or profile record.
        </p>
      </div>
    )
  }

  const memberResult = await getMemberById(profileId)
  if (!memberResult.success || !memberResult.data) {
    return (
      <div className='p-6 text-center text-muted-foreground font-semibold'>
        Member not found.
      </div>
    )
  }

  const member = memberResult.data
  const info = member.userInfo
  const membership = member.membership

  const pendingChangesRes = await getMemberPendingProfileChangesAction(member.id)
  const isNokPending =
    pendingChangesRes.success &&
    Boolean(
      pendingChangesRes.data?.some(
        (r) => r.changeType === ProfileChangeType.NEXT_OF_KIN,
      ),
    )

  return (
    <div className='w-[90%] mx-auto py-8 max-w-4xl flex flex-col gap-8'>
      {/* 1. Header Profile Banner */}
      <div className='relative rounded-md bg-primary p-6 md:p-8 text-on-primary flex flex-col md:flex-row items-center md:items-start justify-between gap-6 overflow-hidden'>
        {/* Decorative subtle gradient background */}
        <div className='absolute inset-0 bg-linear-to-r from-primary-container/40 to-transparent pointer-events-none' />

        <div className='relative z-10 flex flex-col md:flex-row items-center gap-5 text-center md:text-left'>
          <div className='w-20 h-20 rounded-full bg-on-primary/10 border-2 border-on-primary/20 flex items-center justify-center text-on-primary font-bold text-3xl select-none'>
            {member.name.charAt(0).toUpperCase()}
          </div>
          <div className='flex flex-col gap-1.5'>
            <div className='flex items-center gap-2 flex-wrap justify-center md:justify-start'>
              <h2 className='text-2xl font-bold font-heading tracking-tight'>
                {member.name}
              </h2>
              <Badge className='bg-secondary text-on-secondary rounded-full border-0 px-2.5 py-0.5 text-[10px] font-bold'>
                {member.role}
              </Badge>
            </div>
            <p className='text-sm text-on-primary/80 flex items-center gap-1 justify-center md:justify-start'>
              <Mail className='w-4 h-4' />
              <span>{member.email}</span>
            </p>
            {membership?.membershipNumber && (
              <p className='text-xs text-on-primary/70 font-mono font-medium tracking-wide'>
                Coop ID: {membership.membershipNumber}
              </p>
            )}
          </div>
        </div>

        {membership && (
          <div className='relative z-10 flex flex-col items-center md:items-end gap-2 shrink-0'>
            <span className='text-xs text-on-primary/70 font-semibold tracking-wider uppercase'>
              Membership Status
            </span>
            <StatusPill
              status={membership.status}
              className='bg-white/10 text-white'
            />
          </div>
        )}
      </div>

      {/* 2. Content Grid */}
      <div className='grid grid-cols-1 md:grid-cols-[1.3fr_1fr] gap-6'>
        {/* Left Column: Personal and Membership info */}
        <div className='flex flex-col gap-6'>
          <Card className='border-0 bg-surface-container rounded-md shadow-none'>
            <CardHeader className='pb-3 border-b border-outline-variant/30'>
              <CardTitle className='text-sm font-semibold flex items-center gap-2'>
                <User className='w-4 h-4 text-secondary' />
                <span>Personal Profile Info</span>
              </CardTitle>
            </CardHeader>
            <CardContent className='p-5 flex flex-col gap-4 text-sm'>
              <div className='grid grid-cols-1 sm:grid-cols-2 gap-4'>
                <div className='flex items-start gap-2.5'>
                  <Phone className='w-4 h-4 text-muted-foreground mt-0.5' />
                  <div className='flex flex-col gap-0.5'>
                    <span className='text-xs text-muted-foreground'>
                      Phone Number
                    </span>
                    <span className='font-medium font-mono'>
                      {info?.phoneNumber}
                    </span>
                  </div>
                </div>

                <div className='flex items-start gap-2.5'>
                  <Calendar className='w-4 h-4 text-muted-foreground mt-0.5' />
                  <div className='flex flex-col gap-0.5'>
                    <span className='text-xs text-muted-foreground'>
                      Date of Birth
                    </span>
                    <span className='font-medium'>
                      {info?.dateOfBirth
                        ? new Date(info.dateOfBirth).toLocaleDateString()
                        : 'N/A'}
                    </span>
                  </div>
                </div>

                <div className='flex items-start gap-2.5'>
                  <User className='w-4 h-4 text-muted-foreground mt-0.5' />
                  <div className='flex flex-col gap-0.5'>
                    <span className='text-xs text-muted-foreground'>
                      Gender
                    </span>
                    <span className='font-medium capitalize'>
                      {info?.gender?.toLowerCase() || 'N/A'}
                    </span>
                  </div>
                </div>

                <div className='flex items-start gap-2.5'>
                  <Briefcase className='w-4 h-4 text-muted-foreground mt-0.5' />
                  <div className='flex flex-col gap-0.5'>
                    <span className='text-xs text-muted-foreground'>
                      Occupation
                    </span>
                    <span className='font-medium'>{info?.occupation}</span>
                  </div>
                </div>
              </div>

              <div className='flex items-start gap-2.5 border-t border-outline-variant/20 pt-3'>
                <MapPin className='w-4 h-4 text-muted-foreground mt-0.5' />
                <div className='flex flex-col gap-0.5'>
                  <span className='text-xs text-muted-foreground'>
                    Residential Address
                  </span>
                  <span className='font-medium'>{info?.address}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Membership Tier & Interests */}
          {membership && (
            <Card className='border-0 bg-surface-container rounded-md shadow-none'>
              <CardHeader className='pb-3 border-b border-outline-variant/30'>
                <CardTitle className='text-sm font-semibold flex items-center gap-2'>
                  <Award className='w-4 h-4 text-secondary' />
                  <span>Membership Details</span>
                </CardTitle>
              </CardHeader>
              <CardContent className='p-5 flex flex-col gap-4 text-sm'>
                <div className='grid grid-cols-1 sm:grid-cols-2 gap-4'>
                  <div className='flex flex-col gap-1'>
                    <span className='text-xs text-muted-foreground'>
                      Membership Tier
                    </span>
                    <span className='font-semibold text-primary capitalize'>
                      {membership.tier.toLowerCase()} Tier
                    </span>
                  </div>
                  <div className='flex flex-col gap-1'>
                    <span className='text-xs text-muted-foreground'>
                      Referral Name
                    </span>
                    <span className='font-medium'>
                      {membership.referralName || 'None'}
                    </span>
                  </div>
                </div>

                <div className='flex flex-col gap-2 border-t border-outline-variant/20 pt-3'>
                  <span className='text-xs text-muted-foreground'>
                    Registered Interests
                  </span>
                  <div className='flex gap-2 flex-wrap'>
                    {membership.interests.map((interest) => (
                      <Badge
                        key={interest}
                        variant='outline'
                        className='border-outline-variant/40 bg-surface px-2.5 py-0.5 rounded-full capitalize text-xs'
                      >
                        {interest.replace('_', ' ').toLowerCase()}
                      </Badge>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right Column: Next of Kin & Bank Routing Link */}
        <div className='flex flex-col gap-6'>
          <div className='flex flex-col gap-3'>
            <div className='flex items-center justify-between'>
              <h3 className='font-bold text-sm text-primary uppercase tracking-wide'>
                Next of Kin
              </h3>
              {isSelf && (
                <EditNextOfKinDialog
                  userId={member.id}
                  defaultValues={member.nextOfKin}
                  isPendingReview={isNokPending}
                />
              )}
            </div>

            {member.nextOfKin ? (
              <NextOfKinCard
                name={member.nextOfKin.name}
                phoneNumber={member.nextOfKin.phoneNumber}
                relationship={member.nextOfKin.relationship}
                occupation={member.nextOfKin.occupation}
                address={member.nextOfKin.address}
                bankName={member.nextOfKin.bankName}
                accountNumber={member.nextOfKin.accountNumber}
                accountName={member.nextOfKin.accountName}
                isPendingReview={isNokPending}
              />
            ) : (
              <div className='p-6 bg-surface-container rounded-md border border-dashed border-outline-variant text-center flex flex-col gap-2'>
                <span className='text-xs text-muted-foreground font-medium'>
                  No Next of Kin details recorded.
                </span>
              </div>
            )}
          </div>

          {/* Quick Bank Setup Link */}
          {isSelf && (
            <Card className='border-0 bg-secondary/5 rounded-md shadow-none hover:bg-secondary/10 transition-colors duration-200'>
              <CardContent className='p-5 flex items-center justify-between gap-4'>
                <div className='flex items-center gap-3'>
                  <div className='w-10 h-10 rounded-full bg-secondary/10 flex items-center justify-center text-secondary shrink-0'>
                    <Landmark className='w-5 h-5' />
                  </div>
                  <div className='flex flex-col min-w-0'>
                    <span className='font-semibold text-sm'>
                      Nominated Bank Accounts
                    </span>
                    <span className='text-xs text-muted-foreground truncate'>
                      Manage payout routing bank cards
                    </span>
                  </div>
                </div>
                <Button
                  asChild
                  variant='ghost'
                  size='icon'
                  className='text-secondary shrink-0 cursor-pointer'
                >
                  <Link href={`/dashboard/${member.id}/banks`}>
                    <ArrowRight className='w-5 h-5' />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
