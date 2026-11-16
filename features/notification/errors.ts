import { AppError } from '@/lib/errors/app-error'

export class EmailDeliveryError extends AppError {
  constructor(code: string, message: string, cause?: unknown) {
    super(code, message, { statusCode: 502, cause, isOperational: true })
    this.name = 'EmailDeliveryError'
  }
}
