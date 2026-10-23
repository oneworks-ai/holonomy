import { sha256Hex } from '../../../../packages/runtime/src/module-loader/sha256.ts'
import { decodeBase64, encodeBase64, encodeUtf8 } from '../../../../packages/runtime/src/node-compat/encoding.ts'

const MAX_JSON_BYTES = 128 * 1024
const MAX_SERIAL_BYTES = 64 * 1024
const MAX_QUEUED_BYTES = 256 * 1024
const ERROR_CODES = new Set(['invalid', 'unavailable', 'limit', 'generation', 'artifact', 'engine'])
const STATUSES = new Set(['open', 'running', 'stopped', 'failed'])
const EVENT_KINDS = new Set(['open', 'running', 'serialReady', 'stopped', 'failed', 'closed'])
const NETWORK_KINDS = new Set([
  'tcpOpen',
  'tcpData',
  'tcpFin',
  'tcpClose',
  'udpFrame',
  'httpRequest',
  'httpPull',
  'httpCancel'
])
const NETWORK_ACTIONS = new Set([
  'tcpData',
  'tcpEnd',
  'tcpClose',
  'udpFrame',
  'httpHead',
  'httpChunk',
  'httpEnd',
  'httpError'
])
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

const invalid = () => {
  throw new TypeError('Invalid native v86 command result')
}
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum
const exact = (value, keys) =>
  value != null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key))

const binary = (value, maximum) => {
  if (typeof value !== 'string' || !BASE64.test(value) || value.length > Math.ceil(maximum / 3) * 4) {
    return invalid()
  }
  const bytes = decodeBase64(value)
  if (bytes.byteLength > maximum || encodeBase64(bytes, false) !== value) return invalid()
  return bytes
}

/** Host-only, synchronous, bounded bridge to NativeVmPort. */
export class NativeV86CommandPortV1 {
  #call
  #lastSequence = 0
  #networkSequences = new Map()

  constructor(call) {
    if (typeof call !== 'function') throw new TypeError('Native v86 command binding is unavailable')
    this.#call = call
  }

  command(kind, fields = {}) {
    const request = JSON.stringify({ schemaVersion: 1, kind, ...fields })
    if (encodeUtf8(request).byteLength > MAX_JSON_BYTES) return invalid()
    const encoded = this.#call(request)
    if (typeof encoded !== 'string' || encodeUtf8(encoded).byteLength > MAX_JSON_BYTES) return invalid()
    let result
    try {
      result = JSON.parse(encoded)
    } catch {
      return invalid()
    }
    if (!exact(result, ['schemaVersion', 'ok', 'value', 'code']) || result.schemaVersion !== 1) {
      return invalid()
    }
    if (result.ok === false) {
      if (result.value !== undefined || !ERROR_CODES.has(result.code)) return invalid()
      const error = new Error('Native v86 operation failed')
      Object.defineProperty(error, 'code', { value: `v86.${result.code}`, enumerable: true })
      throw error
    }
    if (result.ok !== true || result.code !== undefined) return invalid()
    return result.value
  }

  install(installation) {
    return this.command('install', installation)
  }

  open(id, generation, memoryBytes, networkEnabled = false) {
    if (typeof networkEnabled !== 'boolean') return invalid()
    return this.command('open', { id, generation, memoryBytes, ...(networkEnabled ? { networkEnabled } : {}) })
  }

  start(id, generation) {
    return this.command('start', { id, generation })
  }

  write(id, generation, bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_SERIAL_BYTES) return invalid()
    return this.command('serialWrite', {
      id,
      generation,
      uart: 1,
      base64: encodeBase64(bytes, false)
    })
  }

  poll(id, generation) {
    const value = this.command('poll', { id, generation })
    if (
      !exact(value, ['status', 'queuedBytes']) || !STATUSES.has(value.status) ||
      !integer(value.queuedBytes, MAX_QUEUED_BYTES)
    ) return invalid()
    return value
  }

  drain(id, generation, maxBytes = MAX_SERIAL_BYTES) {
    if (!integer(maxBytes, MAX_SERIAL_BYTES) || maxBytes === 0) return invalid()
    const value = this.command('drain', { id, generation, maxBytes })
    if (
      !exact(value, ['uart', 'base64', 'remainingBytes']) || value.uart !== 1 ||
      !integer(value.remainingBytes, MAX_QUEUED_BYTES)
    ) return invalid()
    return Object.freeze({ bytes: binary(value.base64, maxBytes), remainingBytes: value.remainingBytes })
  }

  drainEvents(limit = 32) {
    if (!integer(limit, 32) || limit === 0) return invalid()
    const value = this.command('drainEvents', { limit })
    if (
      !exact(value, ['events', 'remaining']) || !Array.isArray(value.events) ||
      value.events.length > limit || !integer(value.remaining, 256)
    ) return invalid()
    for (const event of value.events) {
      if (
        !exact(event, ['sequence', 'id', 'generation', 'kind']) ||
        !integer(event.sequence, Number.MAX_SAFE_INTEGER) || event.sequence <= this.#lastSequence ||
        typeof event.id !== 'string' || !/^vm-[1-9]\d{0,14}$/u.test(event.id) ||
        !integer(event.generation, Number.MAX_SAFE_INTEGER) || event.generation === 0 ||
        !EVENT_KINDS.has(event.kind)
      ) return invalid()
      this.#lastSequence = event.sequence
    }
    return value
  }

  networkDrain(id, generation, limit = 4) {
    if (!integer(limit, 4) || limit === 0) return invalid()
    const value = this.command('networkDrain', { id, generation, limit })
    if (
      !exact(value, ['events', 'remaining']) || !Array.isArray(value.events) ||
      value.events.length > limit || !integer(value.remaining, 96)
    ) return invalid()
    const key = `${id}:${generation}`
    let sequence = this.#networkSequences.get(key) ?? 0
    for (const event of value.events) {
      if (
        event == null || typeof event !== 'object' || Array.isArray(event) ||
        !NETWORK_KINDS.has(event.kind) || !integer(event.sequence, Number.MAX_SAFE_INTEGER) ||
        event.sequence <= sequence || !integer(event.streamId, Number.MAX_SAFE_INTEGER) || event.streamId === 0
      ) return invalid()
      if (event.base64 !== undefined) {
        binary(event.base64, event.kind === 'udpFrame' ? 2048 : 16 * 1024)
      }
      sequence = event.sequence
    }
    this.#networkSequences.set(key, sequence)
    return value
  }

  networkDeliver(id, generation, delivery) {
    if (
      delivery == null || typeof delivery !== 'object' || Array.isArray(delivery) ||
      !NETWORK_ACTIONS.has(delivery.action) ||
      !integer(delivery.streamId, Number.MAX_SAFE_INTEGER) || delivery.streamId === 0
    ) return invalid()
    if (delivery.base64 !== undefined) {
      binary(delivery.base64, delivery.action === 'udpFrame' ? 2048 : 16 * 1024)
    }
    return this.command('networkDeliver', { id, generation, delivery })
  }

  close(id, generation) {
    this.#networkSequences.delete(`${id}:${generation}`)
    return this.command('close', { id, generation })
  }
}

export const describeNativeProcessOutputV1 = bytes =>
  Object.freeze({
    base64: encodeBase64(bytes, false),
    byteLength: bytes.byteLength,
    sha256: sha256Hex(bytes)
  })

export const decodeNativeProcessInputV1 = value =>
  typeof value === 'string' ? encodeUtf8(value) : binary(value?.base64, MAX_QUEUED_BYTES)
