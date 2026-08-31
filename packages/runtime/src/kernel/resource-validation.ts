import { canonicalVirtualPath } from '@holonomyjs/capability-fs/kernel/normalize-filesystem'
import { invalidPolicy } from './errors.js'
import {
  DEVICE_OPERATIONS_V1,
  DEVICE_OPERATION_PRIVACY_TIER_V1,
  SYSTEM_INFORMATION_FIELDS_V1
} from './registry-types.js'
import type { SystemInformationFieldV1 } from './registry-types.js'
import { identifier, integer, string } from './validation.js'

export const digest = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[\da-f]{64}$/u.test(value)) return invalidPolicy()
  return value
}

export const resourceDisplay = (value: unknown): Readonly<{ label: string }> =>
  Object.freeze({ label: string(value, 256) })

export const filesystemParts = (value: unknown) => {
  const virtualUrl = canonicalVirtualPath(value)
  const separator = virtualUrl.indexOf('/', 'holo-fs://'.length)
  const rootId = virtualUrl.slice('holo-fs://'.length, separator)
  const suffix = virtualUrl.slice(separator + 1)
  return Object.freeze({
    pathSegments: Object.freeze(suffix === '' ? [] : suffix.split('/')),
    rootId,
    virtualUrl: virtualUrl as `holo-fs://${string}/${string}`
  })
}

export const networkParts = (urlValue: unknown, methodValue: unknown) => {
  const input = string(urlValue, 65_536)
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return invalidPolicy()
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' ||
    url.password !== '' || url.hash !== '' || input !== url.href
  ) return invalidPolicy()
  const method = string(methodValue, 32)
  if (!/^[A-Z]+$/u.test(method)) return invalidPolicy()
  return Object.freeze({ method, origin: url.origin, pathname: url.pathname })
}

export const deviceField = (operation: unknown, field: unknown, privacyTier: unknown) => {
  if (typeof operation !== 'string' || !DEVICE_OPERATIONS_V1.includes(operation as never)) {
    return invalidPolicy()
  }
  const tier = integer(privacyTier, 0, 3) as 0 | 1 | 2 | 3
  if (tier !== DEVICE_OPERATION_PRIVACY_TIER_V1[operation as keyof typeof DEVICE_OPERATION_PRIVACY_TIER_V1]) {
    return invalidPolicy()
  }
  return Object.freeze({
    field: identifier(field),
    operation: operation as keyof typeof DEVICE_OPERATION_PRIVACY_TIER_V1,
    privacyTier: tier
  })
}

export const systemField = (value: unknown): SystemInformationFieldV1 => {
  if (typeof value !== 'string' || !SYSTEM_INFORMATION_FIELDS_V1.includes(value as never)) {
    return invalidPolicy()
  }
  return value as SystemInformationFieldV1
}
