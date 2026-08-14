import { sha256Hex } from '../module-loader/sha256.js'
import { canonicalizeNetworkResource } from './canonical-resources.js'
import { invalidPolicy } from './errors.js'
import type {
  NetworkHeaderViewV1,
  NetworkInvocationSnapshotV1,
  NetworkQueryViewV1
} from './network-invocation-types.js'
import { normalizeNetworkInvocationSnapshotV1 } from './network-invocation.js'
import { networkHeaderViewDigestV1, networkQueryViewDigestV1 } from './network-view-digest.js'
import { boundedText, identifier, integer } from './validation.js'

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key'
])
const SENSITIVE_QUERY = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'code',
  'key',
  'password',
  'secret',
  'sig',
  'signature',
  'token'
])

export interface NetworkInvocationBuilderInputV1 {
  readonly body?: Uint8Array
  readonly headers?: readonly (readonly [string, string])[]
  readonly hop: number
  readonly label: string
  readonly logicalRequestId: string
  readonly method: string
  readonly url: string
}

export const buildNetworkHeaderViewsV1 = (
  values: readonly (readonly [string, string])[]
): readonly NetworkHeaderViewV1[] =>
  Object.freeze(values.map(([rawName, rawValue], index) => {
    const name = boundedText(rawName, 4096).toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name)) return invalidPolicy()
    const value = boundedText(rawValue, 65_536, true).replace(/^[\t ]+|[\t ]+$/gu, '')
    return Object.freeze(
      SENSITIVE_HEADERS.has(name)
        ? { index, name, visibility: 'redacted' as const }
        : { index, name, value, visibility: 'visible' as const }
    )
  }))

const queryViews = (url: URL): readonly NetworkQueryViewV1[] => {
  const output: NetworkQueryViewV1[] = []
  let index = 0
  for (const [keyValue, valueValue] of url.searchParams) {
    const key = boundedText(keyValue, 4096, true)
    const value = boundedText(valueValue, 65_536, true)
    output.push(Object.freeze(
      SENSITIVE_QUERY.has(key.toLowerCase())
        ? { index, key, visibility: 'redacted' as const }
        : { index, key, value, visibility: 'visible' as const }
    ))
    index += 1
  }
  return Object.freeze(output)
}

export const buildNetworkInvocationSnapshotV1 = (
  input: NetworkInvocationBuilderInputV1
): NetworkInvocationSnapshotV1 => {
  let url: URL
  try {
    url = new URL(input.url)
  } catch {
    return invalidPolicy()
  }
  const headers = buildNetworkHeaderViewsV1(input.headers ?? [])
  const query = queryViews(url)
  const headerDigest = networkHeaderViewDigestV1(headers)
  const queryDigest = networkQueryViewDigestV1(query)
  const method = boundedText(input.method, 32).toUpperCase()
  const body = input.body === undefined
    ? { kind: 'none' as const, length: 0 as const }
    : Object.freeze({
      kind: 'buffered' as const,
      length: integer(input.body.byteLength, 0, 64 * 1024 * 1024),
      sha256: sha256Hex(new Uint8Array(input.body))
    })
  return normalizeNetworkInvocationSnapshotV1({
    body,
    headerDigest,
    headers,
    hop: integer(input.hop, 0, 128),
    logicalRequestId: identifier(input.logicalRequestId),
    method,
    query,
    queryDigest,
    resource: canonicalizeNetworkResource(url.href, method, queryDigest, input.label),
    schemaVersion: 1
  })
}
