export interface ResendEmailRecipient {
  email: string
  name?: string
}

export interface ResendSendEmailPayload {
  from: string
  to: string[]
  subject: string
  html: string
  replyTo?: string
  tags?: Array<{ name: string; value: string }>
}

export interface ResendWebhookVerificationParams {
  payload: string
  headers: {
    id: string
    timestamp: string
    signature: string
  }
  webhookSecret: string
}
