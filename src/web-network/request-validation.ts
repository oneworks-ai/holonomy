import { createWebNetworkError } from './errors.js'
import { encodeUtf8 } from './utf8.js'
import { assertRequestHeaders } from './web-headers.js'

import type { ResolvedNetworkAuthority, WebBodyInit } from './types.js'
import type { WebHeaders } from './web-headers.js'

const METHOD_TOKEN = /^[!#$%&'*+\-.^`|~\w]+$/u
const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK'])
const NORMALIZED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'])

export const normalizeMethod = (input: string | undefined) => {
  const raw = input ?? 'GET'
  if (!METHOD_TOKEN.test(raw)) throw new TypeError('Invalid HTTP method')
  const upper = raw.toUpperCase()
  if (FORBIDDEN_METHODS.has(upper)) throw new TypeError('Forbidden HTTP method')
  return NORMALIZED_METHODS.has(upper) ? upper : raw
}

export const cloneBodyBytes = (body: WebBodyInit | null | undefined) => {
  if (body == null) return undefined
  if (typeof body === 'string') return encodeUtf8(body)
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0))
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength))
  }
  throw new TypeError('Unsupported request body')
}

export const validateRequestShape = (
  method: string,
  headers: WebHeaders,
  body: Uint8Array | undefined,
  authority: ResolvedNetworkAuthority
) => {
  assertRequestHeaders(headers)
  const measured = headers.getInputMetrics()
  if (
    measured.count > authority.limits.maxHeaders ||
    measured.bytes > authority.limits.maxHeaderBytes ||
    (body?.byteLength ?? 0) > authority.limits.maxRequestBodyBytes
  ) throw createWebNetworkError('network.protocol_error')
  if ((method === 'GET' || method === 'HEAD') && body != null) {
    throw new TypeError('GET and HEAD requests cannot have a body')
  }
}
