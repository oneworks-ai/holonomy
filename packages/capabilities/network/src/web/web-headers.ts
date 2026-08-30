import { encodeUtf8 } from './utf8.js'

export type WebHeadersInit =
  | Iterable<readonly [string, string]>
  | Readonly<Record<string, string>>
  | WebHeaders

const HEADER_NAME = /^[!#$%&'*+\-.^`|~\w]+$/u

const hasInvalidHeaderValue = (value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (
      code === 0 || code === 10 || code === 13 || (code >= 1 && code <= 8) || (code >= 11 && code <= 31) || code === 127
    ) {
      return true
    }
  }
  return false
}

export const PLATFORM_MANAGED_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

const normalizeName = (input: string) => {
  const value = String(input).toLowerCase()
  if (!HEADER_NAME.test(value)) throw new TypeError('Invalid header name')
  return value
}

const normalizeValue = (input: string) => {
  const value = String(input).replace(/^[\t ]+|[\t ]+$/gu, '')
  if (hasInvalidHeaderValue(value)) throw new TypeError('Invalid header value')
  return value
}

const isIterable = (value: unknown): value is Iterable<readonly [string, string]> => (
  value != null && typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'
)

export class WebHeaders implements Iterable<[string, string]> {
  private readonly entriesMap = new Map<string, string>()

  constructor(init?: WebHeadersInit) {
    if (init == null) return
    if (init instanceof WebHeaders) {
      for (const [name, value] of init) this.entriesMap.set(name, value)
      return
    }
    if (isIterable(init)) {
      for (const entry of init) {
        if (!Array.isArray(entry) || entry.length !== 2) {
          throw new TypeError('Header entry must contain a name and value')
        }
        this.append(entry[0], entry[1])
      }
      return
    }
    for (const [name, value] of Object.entries(init)) this.append(name, value)
  }

  append(name: string, value: string) {
    const key = normalizeName(name)
    const normalized = normalizeValue(value)
    const current = this.entriesMap.get(key)
    this.entriesMap.set(key, current == null ? normalized : `${current}, ${normalized}`)
  }

  delete(name: string) {
    this.entriesMap.delete(normalizeName(name))
  }

  get(name: string) {
    return this.entriesMap.get(normalizeName(name)) ?? null
  }

  has(name: string) {
    return this.entriesMap.has(normalizeName(name))
  }

  set(name: string, value: string) {
    const key = normalizeName(name)
    const normalized = normalizeValue(value)
    this.entriesMap.set(key, normalized)
  }

  entries() {
    return this.entriesMap.entries()
  }

  keys() {
    return this.entriesMap.keys()
  }

  values() {
    return this.entriesMap.values()
  }

  forEach(callback: (value: string, key: string, parent: WebHeaders) => void) {
    for (const [key, value] of this.entriesMap) callback(value, key, this)
  }

  [Symbol.iterator]() {
    return this.entries()
  }

  getInputMetrics() {
    return measureHeaders(this)
  }
}

export const assertRequestHeaders = (headers: WebHeaders) => {
  for (const [name] of headers) {
    if (
      PLATFORM_MANAGED_REQUEST_HEADERS.has(name) ||
      name.startsWith('proxy-') ||
      name.startsWith('sec-')
    ) throw new TypeError('Header is managed by the network provider')
  }
}

export const sanitizeResponseHeaders = (headers: WebHeaders) => {
  const sanitized = new WebHeaders()
  for (const [name, value] of headers) {
    if (name !== 'set-cookie' && name !== 'set-cookie2') sanitized.append(name, value)
  }
  return sanitized
}

export const measureHeaders = (headers: WebHeaders) => {
  let bytes = 0
  let count = 0
  for (const [name, value] of headers) {
    count += 1
    bytes += encodeUtf8(name).byteLength + encodeUtf8(value).byteLength + 4
  }
  return { bytes, count }
}

export const validateRawHeaderEntries = (
  input: unknown,
  limits: { maxHeaderBytes: number; maxHeaders: number },
  request: boolean
) => {
  if (!Array.isArray(input)) throw new TypeError('Headers must be an array')
  const headers = new WebHeaders()
  let rawBytes = 0
  let rawCount = 0
  for (const entry of input) {
    if (
      !Array.isArray(entry) || entry.length !== 2 ||
      typeof entry[0] !== 'string' || typeof entry[1] !== 'string'
    ) throw new TypeError('Invalid header entry')
    const single = new WebHeaders([[entry[0], entry[1]]])
    if (request) assertRequestHeaders(single)
    const metrics = single.getInputMetrics()
    if (
      rawCount + metrics.count > limits.maxHeaders ||
      rawBytes + metrics.bytes > limits.maxHeaderBytes
    ) throw new TypeError('Header limit exceeded')
    rawCount += metrics.count
    rawBytes += metrics.bytes
    headers.append(entry[0], entry[1])
  }
  return headers
}

export const headersToEntries = (headers: WebHeaders): string[][] => (
  [...headers].map(([name, value]) => [name, value])
)
