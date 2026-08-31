import { validateCanonicalResourceV1 } from '@holonomyjs/runtime/kernel/canonical-resource-validation'
import { invalidPolicy } from '@holonomyjs/runtime/kernel/errors'
import { digest } from '@holonomyjs/runtime/kernel/resource-validation'
import {
  array,
  boolean,
  boundedText,
  exact,
  identifier,
  inspectJsonShape,
  integer,
  literal,
  required
} from '@holonomyjs/runtime/kernel/validation'
import type {
  NetworkHeaderViewV1,
  NetworkInvocationSnapshotV1,
  NetworkQueryViewV1,
  NetworkRedirectInvocationV1,
  NetworkRequestBodyMetadataV1
} from './network-invocation-types.js'
import { networkHeaderViewDigestV1, networkQueryViewDigestV1 } from './network-view-digest.js'

const normalizeEntry = (
  value: unknown,
  index: number,
  key: 'key' | 'name'
): NetworkHeaderViewV1 | NetworkQueryViewV1 => {
  const input = exact(value, ['index', key, 'value', 'visibility'])
  if (integer(required(input, 'index'), 0, 1023) !== index) return invalidPolicy()
  const visibility = literal(required(input, 'visibility'), ['redacted', 'visible'] as const)
  const name = boundedText(required(input, key), 4096, key === 'key')
  if (key === 'name' && (name !== name.toLowerCase() || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name))) {
    return invalidPolicy()
  }
  const common = { [key]: name, index, visibility } as const
  if (visibility === 'redacted') {
    if (Object.hasOwn(input, 'value')) return invalidPolicy()
    return Object.freeze(common) as NetworkHeaderViewV1 | NetworkQueryViewV1
  }
  const valueText = boundedText(required(input, 'value'), 65_536, true)
  if (key === 'name' && valueText !== valueText.replace(/^[\t ]+|[\t ]+$/gu, '')) {
    return invalidPolicy()
  }
  const result = { ...common, value: valueText }
  return Object.freeze(result) as NetworkHeaderViewV1 | NetworkQueryViewV1
}

const normalizeBody = (value: unknown): NetworkRequestBodyMetadataV1 => {
  const input = exact(value, ['kind', 'length', 'sha256'])
  const kind = literal(required(input, 'kind'), ['buffered', 'none'] as const)
  const length = integer(required(input, 'length'), 0, 64 * 1024 * 1024)
  if (kind === 'none') {
    if (length !== 0 || Object.hasOwn(input, 'sha256')) return invalidPolicy()
    return Object.freeze({ kind, length: 0 })
  }
  return Object.freeze({ kind, length, sha256: digest(required(input, 'sha256')) })
}

export const normalizeNetworkInvocationSnapshotV1 = (value: unknown): NetworkInvocationSnapshotV1 => {
  inspectJsonShape(value)
  const input = exact(value, [
    'body',
    'headerDigest',
    'headers',
    'hop',
    'logicalRequestId',
    'method',
    'query',
    'queryDigest',
    'resource',
    'schemaVersion'
  ])
  if (required(input, 'schemaVersion') !== 1) return invalidPolicy()
  const method = boundedText(required(input, 'method'), 32)
  if (!/^[A-Z]+$/u.test(method)) return invalidPolicy()
  const headers = array(required(input, 'headers'), 0, 1024)
    .map((item, index) => normalizeEntry(item, index, 'name') as NetworkHeaderViewV1)
  const query = array(required(input, 'query'), 0, 1024)
    .map((item, index) => normalizeEntry(item, index, 'key') as NetworkQueryViewV1)
  const headerDigest = digest(required(input, 'headerDigest'))
  const queryDigest = digest(required(input, 'queryDigest'))
  if (
    headerDigest !== networkHeaderViewDigestV1(headers) ||
    queryDigest !== networkQueryViewDigestV1(query)
  ) return invalidPolicy()
  const resource = validateCanonicalResourceV1(required(input, 'resource'))
  if (
    resource.kind !== 'network' || resource.method !== method ||
    resource.queryDigest !== queryDigest
  ) return invalidPolicy()
  return Object.freeze({
    body: normalizeBody(required(input, 'body')),
    headerDigest,
    headers: Object.freeze(headers),
    hop: integer(required(input, 'hop'), 0, 128),
    logicalRequestId: identifier(required(input, 'logicalRequestId')),
    method,
    query: Object.freeze(query),
    queryDigest,
    resource,
    schemaVersion: 1
  })
}

export const normalizeNetworkRedirectInvocationV1 = (value: unknown): NetworkRedirectInvocationV1 => {
  inspectJsonShape(value)
  const input = exact(value, [
    'bodyReplay',
    'fromHop',
    'fromRequest',
    'logicalRequestId',
    'methodRewritten',
    'status',
    'toHop',
    'toRequest'
  ])
  const fromHop = integer(required(input, 'fromHop'), 0, 127)
  const toHop = integer(required(input, 'toHop'), 1, 128)
  const logicalRequestId = identifier(required(input, 'logicalRequestId'))
  const fromRequest = normalizeNetworkInvocationSnapshotV1(required(input, 'fromRequest'))
  const toRequest = normalizeNetworkInvocationSnapshotV1(required(input, 'toRequest'))
  if (
    fromRequest.hop !== fromHop || fromRequest.logicalRequestId !== logicalRequestId ||
    toHop !== fromHop + 1 || toRequest.hop !== toHop ||
    toRequest.logicalRequestId !== logicalRequestId
  ) return invalidPolicy()
  const status = integer(required(input, 'status'), 301, 308)
  if (![301, 302, 303, 307, 308].includes(status)) return invalidPolicy()
  const rewritten = status === 303
    ? fromRequest.method !== 'GET' && fromRequest.method !== 'HEAD'
    : (status === 301 || status === 302) && fromRequest.method === 'POST'
  const expectedMethod = rewritten ? 'GET' : fromRequest.method
  const methodRewritten = boolean(required(input, 'methodRewritten'))
  if (methodRewritten !== rewritten || toRequest.method !== expectedMethod) return invalidPolicy()
  const expectedReplay = !rewritten && fromRequest.body.kind === 'buffered'
    ? 'same-buffered-body'
    : 'none'
  const bodyReplay = literal(required(input, 'bodyReplay'), ['none', 'same-buffered-body'] as const)
  if (bodyReplay !== expectedReplay) return invalidPolicy()
  if (expectedReplay === 'same-buffered-body') {
    if (fromRequest.body.kind !== 'buffered' || toRequest.body.kind !== 'buffered') {
      return invalidPolicy()
    }
    if (
      toRequest.body.length !== fromRequest.body.length ||
      toRequest.body.sha256 !== fromRequest.body.sha256
    ) return invalidPolicy()
  } else if (toRequest.body.kind !== 'none') return invalidPolicy()
  return Object.freeze({
    bodyReplay,
    fromHop,
    fromRequest,
    logicalRequestId,
    methodRewritten,
    status: status as 301 | 302 | 303 | 307 | 308,
    toHop,
    toRequest
  })
}
