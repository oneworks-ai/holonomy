/* eslint-disable max-lines -- rule admission and deterministic matching share one schema boundary. */

import { decodeUtf8, encodeUtf8 } from './utf8.js'

import type { NetworkMockRequest, NetworkMockRule, NetworkMockRuleSet, NetworkMockRuleSetSnapshot } from './types.js'

const MAX_RULES = 256
const MAX_RULE_SET_BYTES = 1024 * 1024
const MAX_MATCH_BODY_BYTES = 1024 * 1024
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'set-cookie'])
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export class NetworkRuleError extends Error {
  readonly code: 'network.rules_invalid' | 'network.rules_revision_conflict'

  constructor(code: NetworkRuleError['code']) {
    super(code === 'network.rules_invalid' ? 'Invalid network rule set' : 'Network rule revision conflict')
    this.name = 'NetworkRuleError'
    this.code = code
  }
}

const invalid = (): never => {
  throw new NetworkRuleError('network.rules_invalid')
}

const cloneJson = <T>(value: T): T => {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return invalid()
  }
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalid()
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value == null || typeof value !== 'object') return invalid()
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

const normalizeEntries = (entries: readonly (readonly [string, string])[], header: boolean) => {
  if (!Array.isArray(entries)) return invalid()
  return entries.map(entry => {
    if (!Array.isArray(entry) || entry.length !== 2) return invalid()
    const [rawName, value] = entry
    if (typeof rawName !== 'string' || typeof value !== 'string') return invalid()
    const name = header ? rawName.toLowerCase() : rawName
    if (header && (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) || /[\0\r\n]/u.test(value))) invalid()
    return Object.freeze([name, value] as const)
  })
}

const normalizeAbsent = (values: readonly string[] | undefined, header: boolean) => {
  if (values == null) return Object.freeze([])
  if (!Array.isArray(values)) return invalid()
  return Object.freeze(values.map(value => {
    if (typeof value !== 'string' || value === '') return invalid()
    const normalized = header ? value.toLowerCase() : value
    if (header && !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(normalized)) invalid()
    return normalized
  }))
}

const validateBody = (body: NetworkMockRule['match']['body']) => {
  if (body == null) return undefined
  if (!['base64', 'empty', 'json', 'jsonSubset', 'sha256', 'utf8'].includes(body.kind)) invalid()
  if (body.kind === 'empty') {
    if (body.value != null) invalid()
  } else if (body.kind === 'json' || body.kind === 'jsonSubset') {
    canonicalJson(body.value)
  } else if (typeof body.value !== 'string') invalid()
  if (body.kind === 'sha256' && !/^[0-9a-f]{64}$/u.test(body.value as string)) invalid()
  if (
    body.kind === 'base64' &&
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(body.value as string)
  ) invalid()
  return Object.freeze(cloneJson(body))
}

const validateRule = (input: NetworkMockRule, sequence: number): NetworkMockRule => {
  if (input == null || typeof input !== 'object' || typeof input.id !== 'string' || input.id.length === 0) invalid()
  if (!Number.isSafeInteger(input.priority) || Math.abs(input.priority) > 1_000_000) invalid()
  const match = input.match
  if (match == null || typeof match !== 'object') invalid()
  if (match.method != null && !/^[A-Z]+$/u.test(match.method)) invalid()
  if (match.origin != null) {
    const url = new URL(match.origin)
    if (url.origin !== match.origin || url.pathname !== '/' || url.search !== '' || url.hash !== '') invalid()
  }
  if (
    match.path != null &&
    (match.path.op !== 'exact' && match.path.op !== 'prefix' ||
      match.path.value === '' || !match.path.value.startsWith('/'))
  ) invalid()
  const headers = match.headers == null
    ? undefined
    : Object.freeze({
      absent: normalizeAbsent(match.headers.absent, true),
      entries: Object.freeze(normalizeEntries(match.headers.entries ?? [], true)),
      mode: match.headers.mode
    })
  if (headers != null && headers.mode !== 'exact' && headers.mode !== 'subset') invalid()
  for (const [name, value] of headers?.entries ?? []) {
    if (SENSITIVE_HEADERS.has(name) && value !== '<present>' && !/^sha256:[0-9a-f]{64}$/u.test(value)) invalid()
  }
  const query = match.query == null
    ? undefined
    : Object.freeze({
      absent: normalizeAbsent(match.query.absent, false),
      entries: Object.freeze(normalizeEntries(match.query.entries ?? [], false)),
      mode: match.query.mode
    })
  if (query != null && query.mode !== 'exact' && query.mode !== 'subset') invalid()
  const body = validateBody(match.body)
  const action = cloneJson(input.action)
  if (action.type === 'respond') {
    if (!Number.isInteger(action.status) || action.status < 200 || action.status > 599) invalid()
    action.headers = Object.freeze(normalizeEntries(action.headers ?? [], true))
    if (action.body != null) {
      if (!['base64', 'json', 'utf8'].includes(action.body.kind)) invalid()
      if (action.body.chunks != null) {
        if (!Array.isArray(action.body.chunks) || action.body.kind === 'json' || action.body.value != null) invalid()
        for (const chunk of action.body.chunks) {
          if (typeof chunk !== 'string') invalid()
          if (
            action.body.kind === 'base64' &&
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(chunk)
          ) invalid()
        }
      } else if (action.body.kind === 'json') canonicalJson(action.body.value)
      else if (typeof action.body.value !== 'string') invalid()
    }
  } else if (action.type === 'fail') {
    if (!['connection_refused', 'timeout', 'unavailable'].includes(action.code)) invalid()
  } else if (action.type !== 'passthrough') invalid()
  if (
    'delayMs' in action && action.delayMs != null &&
    (!Number.isSafeInteger(action.delayMs) || action.delayMs < 0 || action.delayMs > 60_000)
  ) invalid()
  const lifetime = input.lifetime == null ? undefined : Object.freeze(cloneJson(input.lifetime))
  if (lifetime?.maxMatches != null && (!Number.isSafeInteger(lifetime.maxMatches) || lifetime.maxMatches <= 0)) {
    invalid()
  }
  if (lifetime?.expiresAt != null && !Number.isFinite(Date.parse(lifetime.expiresAt))) invalid()
  return Object.freeze({
    action: Object.freeze(action),
    id: input.id,
    lifetime,
    match: Object.freeze({
      body,
      headers,
      method: match.method,
      origin: match.origin,
      path: match.path == null ? undefined : Object.freeze(cloneJson(match.path)),
      query
    }),
    priority: input.priority,
    sequence
  })
}

const countEntries = (
  haystack: readonly (readonly [string, string])[],
  needle: readonly (readonly [string, string])[],
  sensitiveHeaderSha256: readonly (readonly [string, string])[] | undefined
) => {
  const remaining = haystack.map(entry => [...entry] as [string, string])
  return needle.every(([name, value]) => {
    const index = remaining.findIndex(entry => {
      if (entry[0] !== name) return false
      if (!SENSITIVE_HEADERS.has(name)) return entry[1] === value
      if (value === '<present>') return true
      if (!value.startsWith('sha256:')) return false
      const digest = value.slice('sha256:'.length)
      return sensitiveHeaderSha256?.some(item => item[0] === name && item[1] === digest) === true
    })
    if (index < 0) return false
    remaining.splice(index, 1)
    return true
  })
}

const matchEntries = (
  actual: readonly (readonly [string, string])[],
  expected: { absent?: readonly string[]; entries: readonly (readonly [string, string])[]; mode: 'exact' | 'subset' },
  sensitiveHeaderSha256?: readonly (readonly [string, string])[]
) => {
  if (expected.absent?.some(name => actual.some(entry => entry[0] === name)) === true) return false
  if (!countEntries(actual, expected.entries, sensitiveHeaderSha256)) return false
  return expected.mode === 'subset' || actual.length === expected.entries.length
}

const isJsonSubset = (expected: unknown, actual: unknown): boolean => {
  if (expected === null || typeof expected !== 'object') return Object.is(expected, actual)
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length &&
      expected.every((item, index) => isJsonSubset(item, actual[index]))
  }
  if (actual == null || typeof actual !== 'object' || Array.isArray(actual)) return false
  return Object.entries(expected).every(([key, value]) =>
    Object.hasOwn(actual, key) && isJsonSubset(value, (actual as Record<string, unknown>)[key])
  )
}

const encodeBase64 = (bytes: Uint8Array) => {
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    output += BASE64[first >> 2]
    output += BASE64[((first & 3) << 4) | ((second ?? 0) >> 4)]
    output += second == null ? '=' : BASE64[((second & 15) << 2) | ((third ?? 0) >> 6)]
    output += third == null ? '=' : BASE64[third & 63]
  }
  return output
}

const matchBody = (rule: NonNullable<NetworkMockRule['match']['body']>, request: NetworkMockRequest) => {
  const body = request.body
  const bodyLength = request.bodyLength ?? body.byteLength
  if (rule.kind === 'empty') return bodyLength === 0
  if (rule.kind === 'sha256') return request.bodySha256 === (rule.value as string).toLowerCase()
  if (bodyLength > MAX_MATCH_BODY_BYTES || body.byteLength !== bodyLength) return false
  if (rule.kind === 'base64') return encodeBase64(body) === rule.value
  let text: string
  try {
    text = decodeUtf8(body)
  } catch {
    return false
  }
  if (rule.kind === 'utf8') return text === rule.value
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  return rule.kind === 'json' ? canonicalJson(parsed) === canonicalJson(rule.value) : isJsonSubset(rule.value, parsed)
}

const ruleMatches = (rule: NetworkMockRule, request: NetworkMockRequest, now: number) => {
  if (rule.lifetime?.expiresAt != null && Date.parse(rule.lifetime.expiresAt) <= now) return false
  const url = new URL(request.url)
  const match = rule.match
  if (match.method != null && match.method !== request.method) return false
  if (match.origin != null && match.origin !== url.origin) return false
  if (match.path != null) {
    const matched = match.path.op === 'exact'
      ? url.pathname === match.path.value
      : url.pathname.startsWith(match.path.value)
    if (!matched) return false
  }
  if (match.query != null && !matchEntries([...url.searchParams.entries()], match.query)) return false
  if (match.headers != null) {
    const headers = request.headers.map(([name, value]) => [name.toLowerCase(), value] as const)
    if (!matchEntries(headers, match.headers, request.sensitiveHeaderSha256)) return false
  }
  return match.body == null || matchBody(match.body, request)
}

export class NetworkMockRuleStore {
  private matches = new Map<string, number>()
  private revision = 0
  private rules: readonly NetworkMockRule[] = Object.freeze([])
  private mode: NetworkMockRuleSet['mode'] = 'passthrough'

  getSnapshot(): NetworkMockRuleSetSnapshot {
    return Object.freeze({ mode: this.mode, revision: String(this.revision), rules: this.rules })
  }

  replace(input: NetworkMockRuleSet, expectedRevision?: string) {
    if (expectedRevision != null && expectedRevision !== String(this.revision)) {
      throw new NetworkRuleError('network.rules_revision_conflict')
    }
    if (input.mode !== 'passthrough' && input.mode !== 'failClosed') invalid()
    if (!Array.isArray(input.rules) || input.rules.length > MAX_RULES) invalid()
    let serialized: string
    try {
      serialized = JSON.stringify(input)
    } catch {
      return invalid()
    }
    if (encodeUtf8(serialized).byteLength > MAX_RULE_SET_BYTES) invalid()
    const ids = new Set<string>()
    const rules = input.rules.map((rule, sequence) => {
      const validated = validateRule(rule, sequence)
      if (ids.has(validated.id)) invalid()
      ids.add(validated.id)
      return validated
    }).sort((left, right) => right.priority - left.priority || (left.sequence ?? 0) - (right.sequence ?? 0))
    this.rules = Object.freeze(rules)
    this.mode = input.mode
    this.revision += 1
    if (this.matches.size > MAX_RULES * 1024) this.matches.clear()
    return this.getSnapshot()
  }

  match(
    request: NetworkMockRequest,
    now = Date.now(),
    snapshot: NetworkMockRuleSetSnapshot = this.getSnapshot()
  ) {
    for (const rule of snapshot.rules) {
      const matchKey = `${snapshot.revision}:${rule.id}`
      const count = this.matches.get(matchKey) ?? 0
      if (rule.lifetime?.maxMatches != null && count >= rule.lifetime.maxMatches) continue
      if (!ruleMatches(rule, request, now)) continue
      this.matches.set(matchKey, count + 1)
      return Object.freeze({ action: rule.action, revision: snapshot.revision, ruleId: rule.id })
    }
    return Object.freeze({
      action: snapshot.mode === 'passthrough'
        ? { type: 'passthrough' as const }
        : { code: 'unavailable' as const, type: 'fail' as const },
      revision: snapshot.revision
    })
  }
}
