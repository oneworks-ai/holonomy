import { invalidPolicy } from '@holonomyjs/runtime/kernel/errors'
import type { NetworkSandboxV2 } from '@holonomyjs/runtime/kernel/policy-types'
import {
  array,
  boolean,
  exact,
  integer,
  literal,
  required,
  string,
  stringSet,
  utf8ByteLength
} from '@holonomyjs/runtime/kernel/validation'

const LIMIT_KEYS = [
  'maxChunkBytes',
  'maxConcurrentConnections',
  'maxHeaderBytes',
  'maxHeaders',
  'maxRedirects',
  'maxRequestBodyBytes',
  'maxResponseBodyBytes',
  'maxUrlBytes',
  'socketTimeoutMs'
] as const

const origin = (value: unknown): string => {
  const input = string(value, 2048)
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return invalidPolicy()
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' ||
    parsed.search !== '' || parsed.hash !== '' || parsed.origin !== input ||
    utf8ByteLength(input) > 2048
  ) return invalidPolicy()
  return input
}

const limits = (value: unknown) => {
  const input = exact(value, LIMIT_KEYS)
  const output = {
    maxChunkBytes: integer(required(input, 'maxChunkBytes'), 1, 1024 * 1024),
    maxConcurrentConnections: integer(required(input, 'maxConcurrentConnections'), 1, 128),
    maxHeaderBytes: integer(required(input, 'maxHeaderBytes'), 1, 1024 * 1024),
    maxHeaders: integer(required(input, 'maxHeaders'), 1, 1024),
    maxRedirects: integer(required(input, 'maxRedirects'), 0, 32),
    maxRequestBodyBytes: integer(required(input, 'maxRequestBodyBytes'), 1, 64 * 1024 * 1024),
    maxResponseBodyBytes: integer(required(input, 'maxResponseBodyBytes'), 1, 256 * 1024 * 1024),
    maxUrlBytes: integer(required(input, 'maxUrlBytes'), 1, 1024 * 1024),
    socketTimeoutMs: integer(required(input, 'socketTimeoutMs'), 1, 120_000)
  }
  if (
    output.maxRequestBodyBytes < output.maxChunkBytes ||
    output.maxResponseBodyBytes < output.maxChunkBytes ||
    output.maxConcurrentConnections * output.maxRequestBodyBytes > 64 * 1024 * 1024
  ) return invalidPolicy()
  return Object.freeze(output)
}

const requestBodyInspection = (value: unknown) => {
  const input = exact(value, ['access', 'maxBytes', 'maxReadsPerRuntime'])
  const access = literal(required(input, 'access'), ['bounded', 'none'] as const)
  if (access === 'none') {
    if (Object.keys(input).length !== 1) return invalidPolicy()
    return Object.freeze({ access })
  }
  return Object.freeze({
    access,
    maxBytes: integer(required(input, 'maxBytes'), 1, 1024 * 1024),
    maxReadsPerRuntime: integer(required(input, 'maxReadsPerRuntime'), 1, 1024)
  })
}

export const normalizeNetworkSandbox = (value: unknown): NetworkSandboxV2 => {
  const input = exact(value, [
    'access',
    'allowedOrigins',
    'allowedSchemes',
    'allowPrivateNetwork',
    'limits',
    'requestBodyInspection'
  ])
  const access = literal(required(input, 'access'), ['mockOnly', 'none', 'restricted'] as const)
  if (access === 'none') {
    if (Object.keys(input).length !== 1) return invalidPolicy()
    return Object.freeze({ access })
  }
  const allowedOrigins = array(required(input, 'allowedOrigins'), 0, 64).map(origin)
  if (new Set(allowedOrigins).size !== allowedOrigins.length) return invalidPolicy()
  allowedOrigins.sort()
  const allowedSchemes = stringSet(
    required(input, 'allowedSchemes'),
    ['http', 'https'] as const,
    0,
    2
  )
  const allowPrivateNetwork = boolean(required(input, 'allowPrivateNetwork'))
  if (access === 'mockOnly' && allowPrivateNetwork) return invalidPolicy()
  if (allowedOrigins.some(value => !allowedSchemes.includes(new URL(value).protocol.slice(0, -1) as never))) {
    return invalidPolicy()
  }
  return Object.freeze({
    access,
    allowedOrigins: Object.freeze(allowedOrigins),
    allowedSchemes,
    allowPrivateNetwork,
    limits: limits(required(input, 'limits')),
    requestBodyInspection: requestBodyInspection(required(input, 'requestBodyInspection'))
  })
}
