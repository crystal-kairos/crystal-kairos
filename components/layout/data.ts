import { FacebookIcon, InstagramIcon, TwitterIcon } from './Icons'
import {
  Banknote,
  Handshake,
  History,
  LayoutDashboard,
  Users,
  Wallet,
} from 'lucide-react'

export const navItems = [
  {
    id: 'about',
    label: 'header.nav_items.about_us',
    href: '/about',
  },
  {
    id: 'loans',
    label: 'header.nav_items.get_a_loan',
    href: '/loans',
  },
  {
    id: 'savings',
    label: 'header.nav_items.join_a_savings',
    href: '/savings',
  },
  {
    id: 'eajo',
    label: 'header.nav_items.start_eajo',
    href: '/eajo',
  },
  {
    id: 'login',
    label: 'header.nav_items.login',
    href: '/login',
  },
  {
    id: 'register',
    label: 'header.nav_items.become_a_member',
    href: '/register',
  },
]

export const socials = [
  {
    id: '1',
    href: 'https://www.facebook.com/crystalkairos',
    Icon: FacebookIcon,
  },
  {
    id: '2',
    href: 'https://www.twitter.com/crystalkairos',
    Icon: TwitterIcon,
  },
  {
    id: '3',
    href: 'https://www.instagram.com/crystalkairos',
    Icon: InstagramIcon,
  },
]

export const quickLinks = [
  {
    id: '1',
    label: 'footer.quick_links.about_us',
    href: '/about-us',
  },
  {
    id: '2',
    label: 'footer.quick_links.about_savings',
    href: '/about-savings',
  },
  {
    id: '3',
    label: 'footer.quick_links.about_eajo',
    href: '/about-eajo',
  },
]

export const support = [
  {
    id: '1',
    label: 'footer.support.help_center',
    href: '/help-center',
  },
  {
    id: '2',
    label: 'footer.support.privacy_policy',
    href: '/privacy-policy',
  },
  {
    id: '3',
    label: 'footer.support.terms_of_service',
    href: '/terms-of-service',
  },
  {
    id: '4',
    label: 'footer.support.faq',
    href: '/faq',
  },
]

export const mapLink =
  'https://www.google.com/maps/search/123,+financial+avenue,+victoria+island+lagos/@6.6834172,3.3559375,11z/data=!3m1!4b1?entry=ttu&g_ep=EgoyMDI2MDIxMS4wIKXMDSoASAFQAw%3D%3D'

export const adminNavItems = [
  {
    id: 'dashboard',
    label: 'layout.sidebar.menu-items.dashboard',
    href: '',
    icon: LayoutDashboard,
  },
  {
    id: 'members',
    label: 'layout.sidebar.menu-items.members',
    href: '/members',
    icon: Users,
  },
  {
    id: 'loans',
    label: 'layout.sidebar.menu-items.loans',
    href: '/loans',
    icon: Banknote,
  },
  {
    id: 'savings',
    label: 'layout.sidebar.menu-items.savings',
    href: '/savings',
    icon: Wallet,
  },
  {
    id: 'eajo',
    label: 'layout.sidebar.menu-items.eajo',
    href: '/eajo',
    icon: Handshake,
  },
  {
    id: 'activity',
    label: 'layout.sidebar.menu-items.activity',
    href: '/activity',
    icon: History,
  },
]

export const userNavItems = [
  {
    id: 'dashboard',
    label: 'layout.sidebar.menu-items.dashboard',
    href: '',
    icon: LayoutDashboard,
  },
  {
    id: 'savings',
    label: 'layout.sidebar.menu-items.my_savings',
    href: '/savings',
    icon: Wallet,
  },
  {
    id: 'loans',
    label: 'layout.sidebar.menu-items.loans',
    href: '/loans',
    icon: Banknote,
  },
  {
    id: 'eajo',
    label: 'layout.sidebar.menu-items.eajo',
    href: '/eajo',
    icon: Handshake,
  },
]
