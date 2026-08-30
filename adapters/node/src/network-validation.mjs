import { Buffer } from 'node:buffer'
import { isIP } from 'node:net'

const MAX_BODY_BYTES = 64 * 1024 * 1024
const MAX_HEADER_BYTES = 1024 * 1024
const MAX_HEADERS = 1024
const MAX_URL_BYTES = 1024 * 1024
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Z-]+$/u
const HEADER_NAME = /^[!#$%&'*+.^`|~\w-]+$/u
const FORBIDDEN_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'transfer-encoding',
  'upgrade'
])

export const NODE_NETWORK_LIMITS = Object.freeze({
  maxBodyBytes: MAX_BODY_BYTES,
  maxHeaderBytes: MAX_HEADER_BYTES,
  maxHeaders: MAX_HEADERS,
  maxResponseBytes: 256 * 1024 * 1024,
  maxUrlBytes: MAX_URL_BYTES
})

export const NODE_NETWORK_DEFAULT_LIMITS = Object.freeze({
  maxHeaderBytes: 64 * 1024,
  maxHeaders: 128,
  maxRequestBodyBytes: 1024 * 1024,
  maxUrlBytes: 64 * 1024,
  socketTimeoutMs: 30_000
})

const invalid = message => {
  throw Object.assign(new TypeError(message), { code: 'invalid_request' })
}

const readHeaders = (input, limits) => {
  if (input == null) return Object.freeze([])
  if (!Array.isArray(input) || input.length > limits.maxHeaders) invalid('Invalid Node network headers')
  let bytes = 0
  const output = input.map(entry => {
    if (!Array.isArray(entry) || entry.length !== 2) invalid('Invalid Node network header')
    const [inputName, inputValue] = entry
    if (typeof inputName !== 'string' || typeof inputValue !== 'string') invalid('Invalid Node network header')
    const name = inputName.toLowerCase()
    if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(name) || /[\0\r\n]/u.test(inputValue)) {
      invalid('Invalid Node network header')
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(inputValue)
    if (bytes > limits.maxHeaderBytes) invalid('Node network headers exceed the limit')
    return Object.freeze([name, inputValue])
  })
  return Object.freeze(output)
}

export function normalizeNetworkRequest(input, limits = NODE_NETWORK_DEFAULT_LIMITS) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) invalid('Invalid Node network request')
  if (
    Object.keys(input).some(key =>
      !['body', 'capabilityBindingId', 'headers', 'method', 'signal', 'timeoutMs', 'url'].includes(key)
    )
  ) {
    invalid('Invalid Node network request')
  }
  if (typeof input.url !== 'string') invalid('Invalid Node network URL')
  if (Buffer.byteLength(input.url) > limits.maxUrlBytes) invalid('Node network URL exceeds the limit')
  let url
  try {
    url = new URL(input.url)
  } catch {
    invalid('Invalid Node network URL')
  }
  if (url.href !== input.url) invalid('Node network URL must be canonical')
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hash !== '') {
    invalid('Invalid Node network URL')
  }
  const method = input.method == null ? 'GET' : input.method
  if (typeof method !== 'string' || method !== method.toUpperCase() || !METHOD.test(method)) {
    invalid('Invalid Node network method')
  }
  let body
  if (input.body != null) {
    if (Object.getPrototypeOf(input.body) !== Uint8Array.prototype) invalid('Invalid Node network body')
    if (input.body.byteLength > limits.maxRequestBodyBytes) invalid('Node network body exceeds the limit')
    body = Uint8Array.from(input.body)
  }
  if (
    input.timeoutMs != null &&
    (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 300_000)
  ) {
    invalid('Invalid Node network timeout')
  }
  if (
    input.signal != null &&
    (typeof input.signal !== 'object' || typeof input.signal.aborted !== 'boolean' ||
      typeof input.signal.addEventListener !== 'function' || typeof input.signal.removeEventListener !== 'function')
  ) {
    invalid('Invalid Node network abort signal')
  }
  if (
    input.capabilityBindingId != null &&
    (typeof input.capabilityBindingId !== 'string' || !/^[A-Za-z0-9][\w.:-]{0,255}$/u.test(input.capabilityBindingId))
  ) invalid('Invalid Node capability network binding')
  return Object.freeze({
    body,
    capabilityBindingId: input.capabilityBindingId,
    headers: readHeaders(input.headers, limits),
    method,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    url
  })
}

export function normalizeResolvedAddress(input) {
  if (input == null || typeof input !== 'object') invalid('Invalid DNS result')
  const family = Number(input.family)
  if (![4, 6].includes(family) || isIP(input.address) !== family) invalid('Invalid DNS result')
  return Object.freeze({ address: input.address, family })
}
