import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'

import { DEFAULT_MAX_REQUEST_BYTES, HARD_MAX_REQUEST_BYTES } from './constants.mjs'
import { normalizeServiceError, publicErrorBody, serviceError } from './errors.mjs'
import { isLoopbackHostname, requireInteger, requireRecord, requireString, tokensEqual } from './validation.mjs'

const validateHostname = input => {
  const host = requireString(input, 'Service hostname', { max: 253 }).replace(/^\[|\]$/gu, '').toLowerCase()
  if (isIP(host) !== 0 || /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(host)) return host
  throw serviceError('service.invalid_request', 'Service hostname is invalid')
}

const validateListenHost = (input, secure) => {
  const host = validateHostname(input)
  if (!isLoopbackHostname(host) && !secure) {
    throw serviceError('service.invalid_request', 'Non-loopback Holonomy Service requires TLS')
  }
  return host
}

const validateAdvertiseHost = (input, listenHost) => {
  const host = validateHostname(input)
  if (['0.0.0.0', '::'].includes(host) && host === listenHost) {
    throw serviceError('service.invalid_request', 'Wildcard listen requires an advertise host')
  }
  return host
}

export const createServiceToken = () => randomBytes(32).toString('base64url')

export const validateHttpConfiguration = options => {
  const tls = options.tls
  if (tls != null) {
    const value = requireRecord(tls, 'TLS configuration')
    if (value.cert == null || value.key == null) {
      throw serviceError('service.invalid_request', 'TLS key and certificate must be configured together')
    }
  }
  const host = validateListenHost(options.host ?? '127.0.0.1', tls != null)
  const advertiseHost = validateAdvertiseHost(options.advertiseHost ?? host, host)
  const allowedHosts = Object.freeze([
    advertiseHost,
    ...(options.allowedHosts ?? [])
  ].map(value => validateHostname(value)))
  const port = requireInteger(options.port ?? 0, 'Service port', { max: 65_535, min: 0 })
  const token = requireString(options.token, 'Service token', { max: 4_096, min: 32 })
  if (/\s/u.test(token)) throw serviceError('service.invalid_request', 'Service token is invalid')
  const maxRequestBytes = requireInteger(
    options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
    'Request body limit',
    { max: HARD_MAX_REQUEST_BYTES, min: 1_024 }
  )
  return { advertiseHost, allowedHosts, host, maxRequestBytes, port, tls, token }
}

export const admitLoopbackRequest = request => {
  const host = request.headers.host
  if (typeof host !== 'string') throw serviceError('service.invalid_request', 'Host header is required')
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    throw serviceError('service.invalid_request', 'Host header is invalid')
  }
  if (!isLoopbackHostname(hostname)) {
    throw serviceError('service.invalid_request', 'Host header must identify loopback')
  }
}

export const admitRequestHost = (request, allowedHosts) => {
  if (allowedHosts == null) return admitLoopbackRequest(request)
  const host = request.headers.host
  if (typeof host !== 'string') throw serviceError('service.invalid_request', 'Host header is required')
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  } catch {
    throw serviceError('service.invalid_request', 'Host header is invalid')
  }
  if (!allowedHosts.some(allowed => allowed.toLowerCase() === hostname)) {
    throw serviceError('service.invalid_request', 'Host header is not admitted')
  }
}

export const admitHttpRequest = (request, expectedToken, allowedHosts) => {
  admitRequestHost(request, allowedHosts)
  const authorization = request.headers.authorization
  const match = typeof authorization === 'string' ? /^Bearer (\S+)$/u.exec(authorization) : null
  const token = typeof expectedToken === 'function' ? expectedToken() : expectedToken
  if (match == null || !tokensEqual(match[1], token)) {
    throw serviceError('service.unauthorized', 'Bearer token is invalid')
  }
}

export const readJsonRequest = async (request, maxBytes) => {
  const contentType = request.headers['content-type']
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw serviceError('service.invalid_request', 'Content-Type must be application/json')
  }
  const declared = request.headers['content-length']
  if (declared != null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0) {
      throw serviceError('service.invalid_request', 'Content-Length is invalid')
    }
    if (length > maxBytes) throw serviceError('service.limit_exceeded', 'Request body exceeds its limit')
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.byteLength
    if (bytes > maxBytes) {
      request.resume()
      throw serviceError('service.limit_exceeded', 'Request body exceeds its limit')
    }
    chunks.push(chunk)
  }
  if (bytes === 0) return {}
  try {
    return requireRecord(JSON.parse(Buffer.concat(chunks).toString('utf8')), 'Request body')
  } catch (error) {
    if (error?.code?.startsWith?.('service.')) throw error
    throw serviceError('service.invalid_request', 'Request body is not valid JSON')
  }
}

const responseHeaders = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'",
  'x-content-type-options': 'nosniff'
})

export const sendJson = (response, status, value) => {
  if (response.headersSent) return
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    ...responseHeaders,
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8'
  })
  response.end(body)
}

export const sendBytes = (response, status, body, contentType) => {
  if (response.headersSent) return
  response.writeHead(status, {
    ...responseHeaders,
    'content-length': body.byteLength,
    'content-type': contentType
  })
  response.end(body)
}

export const sendServiceError = (response, error) => {
  const normalized = normalizeServiceError(error)
  if (normalized.status === 401) response.setHeader('www-authenticate', 'Bearer')
  sendJson(response, normalized.status, publicErrorBody(normalized))
}

export const sseHeaders = responseHeaders
