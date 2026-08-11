import { Buffer } from 'node:buffer'

import Ajv2020 from 'ajv/dist/2020.js'

import { copyJsonValue, freezeJsonValue } from './json-value.mjs'
import { NETWORK_RULE_SET_SCHEMA } from './network-rule-schema.mjs'

const MAX_BYTES = 1024 * 1024
const MAX_DEPTH = 16
const MAX_NODES = 4_096
const SENSITIVE = new Set(['authorization', 'cookie', 'proxy-authorization', 'set-cookie'])
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const HEADER = /^[!#$%&'*+.^`|~\w-]+$/u
const validator = new Ajv2020({ allErrors: false, strict: true }).compile(NETWORK_RULE_SET_SCHEMA)

export class NetworkRuleContractError extends TypeError {
  constructor(code = 'network.rules_invalid') {
    super(code === 'network.rules_limit' ? 'Network rule set exceeds its limit' : 'Invalid network rule set')
    this.code = code
    this.name = 'NetworkRuleContractError'
  }
}

const invalid = code => {
  throw new NetworkRuleContractError(code)
}

const boundJson = (value, depth = 0, state = { nodes: 0 }) => {
  state.nodes += 1
  if (depth > MAX_DEPTH || state.nodes > MAX_NODES) invalid('network.rules_limit')
  if (value == null || typeof value !== 'object') return
  for (const child of Array.isArray(value) ? value : Object.values(value)) boundJson(child, depth + 1, state)
}

const validateEntries = (entries, sensitive) => {
  for (const [rawName, value] of entries ?? []) {
    const name = rawName.toLowerCase()
    if (!HEADER.test(rawName) || /[\0\r\n]/u.test(value)) invalid()
    if (sensitive && SENSITIVE.has(name) && value !== '<present>' && !/^sha256:[0-9a-f]{64}$/u.test(value)) {
      invalid()
    }
    if (!sensitive && SENSITIVE.has(name)) invalid()
  }
}

const validateBodyMatch = body => {
  if (body == null) return
  if (body.kind === 'empty' && Object.hasOwn(body, 'value')) invalid()
  if (body.kind !== 'empty' && !Object.hasOwn(body, 'value')) invalid()
  if (body.kind === 'sha256' && (typeof body.value !== 'string' || !/^[0-9a-f]{64}$/u.test(body.value))) invalid()
  if (body.kind === 'base64' && (typeof body.value !== 'string' || !BASE64.test(body.value))) invalid()
  if (body.kind === 'utf8' && typeof body.value !== 'string') invalid()
}

const validateResponseBody = body => {
  if (body == null) return
  if (body.chunks != null) {
    if (body.kind === 'json' || Object.hasOwn(body, 'value')) invalid()
    if (body.kind === 'base64' && body.chunks.some(value => !BASE64.test(value))) invalid()
  } else if (!Object.hasOwn(body, 'value')) invalid()
  if (body.kind !== 'json' && body.chunks == null && typeof body.value !== 'string') invalid()
  if (body.kind === 'base64' && body.chunks == null && !BASE64.test(body.value)) invalid()
}

export const normalizeNetworkRuleSet = value => {
  const copied = copyJsonValue(value, 'network rules')
  if (!validator(copied)) invalid()
  const serialized = JSON.stringify(copied)
  if (Buffer.byteLength(serialized) > MAX_BYTES) invalid('network.rules_limit')
  boundJson(copied)
  const ids = new Set()
  for (const rule of copied.rules) {
    if (ids.has(rule.id)) invalid()
    ids.add(rule.id)
    if (rule.match.origin != null) {
      const url = new URL(rule.match.origin)
      if (url.origin !== rule.match.origin || url.pathname !== '/' || url.search !== '' || url.hash !== '') invalid()
    }
    validateEntries(rule.match.headers?.entries, true)
    validateEntries(rule.action.headers, false)
    validateBodyMatch(rule.match.body)
    if (rule.action.type === 'respond') validateResponseBody(rule.action.body)
    if (rule.lifetime?.expiresAt != null && !Number.isFinite(Date.parse(rule.lifetime.expiresAt))) invalid()
  }
  return freezeJsonValue(copied)
}
