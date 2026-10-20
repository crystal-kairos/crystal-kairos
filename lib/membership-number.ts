import crypto from 'node:crypto'

export const generateMembershipNumber = () => {
  const prefix = 'CRK'
  const timestamp = Date.now().toString(36).toUpperCase()
  const random = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4)
  return `${prefix}-${timestamp}-${random}`
}
