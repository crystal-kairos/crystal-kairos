import RegisterPageHead from '@/components/auth/RegisterPageHead'
import RegisterStepsHeader from '@/components/auth/RegisterStepsHeader'
import RegistrationForm from '@/components/auth/RegistrationForm'
import { AuthShowcase } from '@/components/auth/AuthShowcase'

const RegisterPage = () => {
  return (
    <div className='min-h-screen md:grid md:grid-cols-[1fr_1.3fr] lg:grid-cols-[1fr_1.5fr] flex flex-col bg-surface-container-lowest'>
      <AuthShowcase />

      <div className='flex flex-col items-center justify-center p-6 sm:p-10 xl:p-16 h-full overflow-y-auto'>
        <div className='w-full max-w-175 flex flex-col gap-8'>
          <RegisterPageHead />
          <RegisterStepsHeader />
          <RegistrationForm />
        </div>
      </div>
    </div>
  )
}

export default RegisterPage
