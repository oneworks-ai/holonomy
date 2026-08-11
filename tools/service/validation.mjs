import { Buffer } from 'node:buffer'
import { createHash, timingSafeEqual } from 'node:crypto'

import { serviceError } from './errors.mjs'

const IDENTIFIER = /^[\w:.-]{1,160}$/u
const IDEMPOTENCY_KEY = /^[\u0021-\u007E]{1,200}$/u

export const requireRecord = (value, label = 'value') => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError('service.invalid_request', `${label} must be an object`)
  }
  return value
}

export const requireString = (value, label, options = {}) => {
  if (typeof value !== 'string' || value.length < (options.min ?? 1) || value.length > (options.max ?? 4_096)) {
    throw serviceError('service.invalid_request', `${label} is invalid`)
  }
  return value
}

export const requireIdentifier = (value, label = 'identifier') => {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw serviceError('service.invalid_request', `${label} is invalid`)
  }
  return value
}

export const requireInteger = (value, label, options = {}) => {
  if (
    !Number.isSafeInteger(value) || value < (options.min ?? Number.MIN_SAFE_INTEGER) ||
    value > (options.max ?? Number.MAX_SAFE_INTEGER)
  ) {
    throw serviceError('service.invalid_request', `${label} is invalid`)
  }
  return value
}

export const requireEnum = (value, allowed, label) => {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw serviceError('service.invalid_request', `${label} is invalid`)
  }
  return value
}

export const requireAbsoluteUrl = (value, label = 'URL') => {
  requireString(value, label)
  try {
    const parsed = new URL(value)
    if (parsed.protocol === '') throw new TypeError('missing protocol')
    return parsed.toString()
  } catch {
    throw serviceError('service.invalid_request', `${label} must be absolute`)
  }
}

export const requireIdempotencyKey = value => {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw serviceError('service.invalid_request', 'Idempotency-Key is required')
  }
  return value
}

const normalizeJson = (value, seen) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(item => normalizeJson(item, seen))
  if (value == null || typeof value !== 'object' || seen.has(value)) {
    throw serviceError('service.invalid_request', 'Value must be finite JSON')
  }
  seen.add(value)
  const output = {}
  for (const key of Object.keys(value).sort()) output[key] = normalizeJson(value[key], seen)
  seen.delete(value)
  return output
}

export const canonicalJson = value => JSON.stringify(normalizeJson(value, new Set()))
export const cloneJson = value => JSON.parse(canonicalJson(value))
export const fingerprintJson = value => createHash('sha256').update(canonicalJson(value)).digest('hex')

export const tokensEqual = (presented, expected) => {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false
  const left = Buffer.from(presented)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export const requireLoopbackHost = host => {
  if (host !== '127.0.0.1' && host !== '::1') {
    throw serviceError('service.invalid_request', 'Holonomy Service must bind to a loopback IP address')
  }
  return host
}

export const isLoopbackHostname = hostname => (
  hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1' || hostname === 'localhost'
)
