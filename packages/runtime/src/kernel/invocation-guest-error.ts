import { translateCapabilityErrorV1 } from './guest-errors.js'

export type GuestErrorFamilyV1 = 'childProcess' | 'holo' | 'nodeFs' | 'nodeSystem'

export const guestInvocationErrorV1 = (error: unknown, family: GuestErrorFamilyV1) => {
  const translated = translateCapabilityErrorV1(error, family)
  return Object.freeze({
    code: translated.code,
    message: translated.message,
    name: translated.name,
    retryable: translated.retryable
  })
}
