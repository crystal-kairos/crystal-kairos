export { sendEmail, retryNotification } from './channels/email.channel'
export { EmailDeliveryError } from './errors'
export {
  resend,
  getResendClient,
  setResendClient,
  getEmailFrom,
  getEmailReplyTo,
  redactErrorMessage,
} from './providers/resend.provider'
export type { SendEmailOptions, SendEmailResult, TemplateVariables } from './types'
