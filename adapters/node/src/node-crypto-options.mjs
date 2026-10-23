import { types } from 'node:util'

// Host-only fixed installation switch. No provider, principal or algorithm
// selection is accepted, and no foreign getter or Proxy trap is evaluated.
export function normalizeNodeCryptoOptions(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || types.isProxy(value)) {
    throw new TypeError('Invalid Node crypto options')
  }
  const prototype = Object.getPrototypeOf(value)
  const keys = Reflect.ownKeys(value)
  const descriptor = Object.getOwnPropertyDescriptor(value, 'enabled')
  if (
    (prototype !== Object.prototype && prototype !== null) || keys.length !== 1 || keys[0] !== 'enabled' ||
    descriptor == null || !descriptor.enumerable || !('value' in descriptor) || descriptor.value !== true
  ) throw new TypeError('Invalid Node crypto options')
  return Object.freeze({ enabled: true })
}
