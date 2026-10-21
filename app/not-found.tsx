import Link from 'next/link'
import { Button } from '@/components/ui/button'

const NotFound = () => {
  return (
    <div className='min-h-screen flex flex-col gap-4 justify-center items-center p-6 text-center'>
      <h1 className='text-2xl font-bold text-foreground'>Page Not Found</h1>
      <p className='text-sm text-muted-foreground max-w-md'>
        The page or record you are looking for does not exist or may have been
        moved.
      </p>
      <Button asChild variant='default'>
        <Link href='/'>Return Home</Link>
      </Button>
    </div>
  )
}

export default NotFound
