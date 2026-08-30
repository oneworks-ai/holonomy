import { Buffer } from '../node-compat/buffer.js'

import { createHttpServerError } from './errors.js'

import type { NativeJsonValue } from '../native-port/types.js'
import type { HttpIncomingHeaders, HttpServerAddress, HttpServerLimits } from './types.js'

export interface DecodedIncomingRequest {
  readonly headers: HttpIncomingHeaders
  readonly httpVersion: string
  readonly kind: 'request' | 'upgrade'
  readonly method: string
  readonly rawHeaders: readonly string[]
  readonly url: string
}

const recordValue = (value: NativeJsonValue | undefined): Record<string, NativeJsonValue> => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL')
  }
  return value as Record<string, NativeJsonValue>
}

const requiredString = (record: Record<string, NativeJsonValue>, key: string) => {
  const value = record[key]
  if (typeof value !== 'string') throw createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL')
  return value
}

export const decodeAddress = (value: NativeJsonValue | undefined): HttpServerAddress => {
  const record = recordValue(value)
  const address = requiredString(record, 'address')
  const family = requiredString(record, 'family')
  const port = record.port
  if (
    address !== '127.0.0.1' || family !== 'IPv4' || !Number.isSafeInteger(port) ||
    (port as number) <= 0 || (port as number) > 65_535
  ) {
    throw createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL')
  }
  return Object.freeze({ address, family, port: port as number })
}

const headerBytes = (name: string, value: string) => Buffer.byteLength(name) + Buffer.byteLength(value) + 4

export const normalizeHeaderEntries = (
  source: readonly (readonly [string, string])[],
  limits: Readonly<HttpServerLimits>
) => {
  if (source.length > limits.maxHeaders) throw createHttpServerError('ERR_HOLONOMY_HTTP_LIMIT_EXCEEDED')
  const headers: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>
  const rawHeaders: string[] = []
  let bytes = 0
  for (const entry of source) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
      throw createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL')
    }
    const name = entry[0].trim().toLowerCase()
    const value = entry[1]
    if (name === '' || /[^!#$%&'*+.^_`|~0-9a-z-]/u.test(name) || /[\0\r\n]/u.test(value)) {
      throw createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL')
    }
    bytes += headerBytes(name, value)
    if (bytes > limits.maxHeaderBytes) throw createHttpServerError('ERR_HOLONOMY_HTTP_LIMIT_EXCEEDED')
    rawHeaders.push(name, value)
    const previous = headers[name]
    if (previous === undefined) headers[name] = value
    else if (Array.isArray(previous)) previous.push(value)
    else headers[name] = [previous, value]
  }
  return {
    entries: Object.freeze(source.map(entry => Object.freeze([entry[0], entry[1]] as const))),
    headers: Object.freeze(headers) as HttpIncomingHeaders,
    rawHeaders: Object.freeze(rawHeaders)
  }
}

export const decodeIncomingRequest = (
  value: NativeJsonValue | undefined,
  limits: Readonly<HttpServerLimits>
): DecodedIncomingRequest => {
  const record = recordValue(value)
  const kind = requiredString(record, 'kind')
  const headerValue = record.headers
  if ((kind !== 'request' && kind !== 'upgrade') || !Array.isArray(headerValue)) {
    throw createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL')
  }
  const entries = headerValue.map(entry => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
      throw createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL')
    }
    return [entry[0], entry[1]] as const
  })
  const normalized = normalizeHeaderEntries(entries, limits)
  const method = requiredString(record, 'method')
  const url = requiredString(record, 'url')
  const httpVersion = requiredString(record, 'httpVersion')
  if (
    method === '' || method.length > 32 || /[^!#$%&'*+.^`|~\w-]/u.test(method) ||
    url === '' || url.length > 8_192 || /[\0\r\n]/u.test(url) || httpVersion !== '1.1'
  ) {
    throw createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL')
  }
  return Object.freeze({
    headers: normalized.headers,
    httpVersion,
    kind,
    method,
    rawHeaders: normalized.rawHeaders,
    url
  })
}

export const normalizeOutgoingHeaders = (
  source: ReadonlyMap<string, string | readonly string[]>,
  limits: Readonly<HttpServerLimits>
) => {
  const entries: Array<readonly [string, string]> = []
  for (const [name, rawValue] of source) {
    for (const value of typeof rawValue === 'string' ? [rawValue] : rawValue) entries.push([name, value])
  }
  return normalizeHeaderEntries(entries, limits).entries
}
