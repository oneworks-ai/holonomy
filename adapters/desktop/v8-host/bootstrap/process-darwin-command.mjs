/* eslint-disable max-lines -- The private process wire validates one bounded command/event protocol. */
import {
  decodeBase64,
  decodeUtf8,
  encodeBase64,
  encodeUtf8
} from '../../../../packages/runtime/src/node-compat/encoding.ts'

const MAX_REQUEST_BYTES = 24 * 1024 * 1024
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_EVENT_BYTES = 64 * 1024
export const MAX_DARWIN_STDIN_CHUNK_BYTES_V1 = 256 * 1024
const ERROR_CODES = new Set(['invalid', 'unavailable', 'limit', 'generation', 'io'])
const EVENT_KINDS = new Set([
  'spawn',
  'error',
  'exit',
  'close',
  'stdout',
  'stdoutEnd',
  'stdoutError',
  'stdoutClose',
  'stderr',
  'stderrEnd',
  'stderrError',
  'stderrClose',
  'stdinError',
  'stdinClose',
  'stdinCallback'
])
const EVENT_PAYLOAD_KEYS = Object.freeze({
  stdout: ['base64'],
  stderr: ['base64'],
  exit: ['status', 'signal'],
  close: ['status', 'signal'],
  stdinCallback: ['callbackId', 'code'],
  error: ['code'],
  stdoutError: ['code'],
  stderrError: ['code'],
  stdinError: ['code']
})
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const RESULT_SIGNAL = /^SIG[A-Z0-9]{1,16}$/u
const RESULT_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u

const invalid = () => {
  throw new TypeError('Invalid private native Darwin Process response')
}
const nativeError = code => {
  const error = new Error('Native Darwin Process operation failed')
  Object.defineProperty(error, 'code', { value: `darwin.${code}`, enumerable: true })
  throw error
}
const exact = (value, keys) =>
  value != null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key))
const unsigned = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][\w.-]{0,127}$/u.test(value)

export const decodeDarwinProcessBytesV1 = (value, maximum) => {
  if (
    typeof value !== 'string' || !BASE64.test(value) ||
    value.length > Math.ceil(maximum / 3) * 4
  ) return invalid()
  const bytes = decodeBase64(value)
  if (bytes.byteLength > maximum || encodeBase64(bytes, false) !== value) return invalid()
  return bytes
}

export class NativeDarwinProcessCommandV1 {
  #call
  #lastSequence = 0

  constructor(call) {
    if (typeof call !== 'function') throw new TypeError('Native Darwin Process binding is unavailable')
    this.#call = call
  }

  command(kind, fields = {}) {
    const request = JSON.stringify({ schemaVersion: 1, kind, ...fields })
    if (encodeUtf8(request).byteLength > MAX_REQUEST_BYTES) return invalid()
    let encoded
    try {
      encoded = this.#call(request)
    } catch {
      return nativeError('io')
    }
    if (typeof encoded !== 'string' || encodeUtf8(encoded).byteLength > MAX_RESPONSE_BYTES) return invalid()
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
      return nativeError(result.code)
    }
    if (result.ok !== true || result.code !== undefined) return invalid()
    return result.value
  }

  install(generation, profile, policy) {
    const value = this.command('install', { generation, profile, policy })
    if (!exact(value, ['installed']) || value.installed !== true) return invalid()
  }

  spawn(fields) {
    const value = this.command('spawn', fields)
    if (!exact(value, ['handle']) || !identifier(value.handle)) return invalid()
    return value.handle
  }

  spawnSync(fields) {
    const value = this.command('spawnSync', fields)
    if (!exact(value, ['status', 'signal', 'stdoutBase64', 'stderrBase64', 'errorCode'])) return invalid()
    if (value.status !== null && (!Number.isSafeInteger(value.status) || value.status < 0 || value.status > 255)) {
      return invalid()
    }
    if (
      value.signal !== null &&
      (typeof value.signal !== 'string' || !RESULT_SIGNAL.test(value.signal))
    ) return invalid()
    if (
      value.errorCode !== undefined && value.errorCode !== null &&
      !['ENOBUFS', 'ETIMEDOUT', 'EIO'].includes(value.errorCode)
    ) return invalid()
    const maximum = Math.min(fields.maxBuffer, MAX_OUTPUT_BYTES)
    const stdout = decodeDarwinProcessBytesV1(value.stdoutBase64, maximum)
    const stderr = decodeDarwinProcessBytesV1(value.stderrBase64, maximum)
    return Object.freeze({
      ...(value.errorCode == null ? {} : { error: Object.freeze({ code: value.errorCode }) }),
      signal: value.signal,
      status: value.status,
      stderr: fields.encoding === 'utf8' ? decodeUtf8(stderr) : stderr,
      stdout: fields.encoding === 'utf8' ? decodeUtf8(stdout) : stdout
    })
  }

  poll(generation, maxEvents = 64) {
    if (!unsigned(maxEvents, 64) || maxEvents === 0) return invalid()
    const value = this.command('poll', { generation, maxEvents })
    if (
      !exact(value, ['events', 'remaining']) || !Array.isArray(value.events) ||
      value.events.length > maxEvents || !unsigned(value.remaining, 1024)
    ) return invalid()
    const events = []
    for (const event of value.events) {
      const payloadKeys = EVENT_PAYLOAD_KEYS[event?.kind] ?? []
      if (
        !exact(event, [
          'sequence',
          'generation',
          'handle',
          'processResourceId',
          'kind',
          ...payloadKeys
        ]) ||
        !identifier(event.handle) || !identifier(event.processResourceId) ||
        !EVENT_KINDS.has(event.kind) ||
        payloadKeys.some(key => !Object.hasOwn(event, key)) ||
        (event.sequence !== undefined &&
          (!unsigned(event.sequence, Number.MAX_SAFE_INTEGER) || event.sequence <= this.#lastSequence)) ||
        (event.generation !== undefined &&
          (!unsigned(event.generation, Number.MAX_SAFE_INTEGER) || event.generation === 0))
      ) return invalid()
      if (event.sequence !== undefined) this.#lastSequence = event.sequence
      if (event.kind === 'exit' || event.kind === 'close') {
        if (
          event.status !== null && (!unsigned(event.status, 255)) ||
          event.signal !== null &&
            (typeof event.signal !== 'string' || !RESULT_SIGNAL.test(event.signal))
        ) return invalid()
      }
      if (
        event.kind === 'stdinCallback' &&
        (event.callbackId !== null &&
            (!unsigned(event.callbackId, Number.MAX_SAFE_INTEGER) || event.callbackId === 0) ||
          event.code !== null && (typeof event.code !== 'string' || !RESULT_CODE.test(event.code)))
      ) return invalid()
      if (
        ['error', 'stdoutError', 'stderrError', 'stdinError'].includes(event.kind) &&
        (typeof event.code !== 'string' || !RESULT_CODE.test(event.code))
      ) return invalid()
      if (event.kind === 'stdout' || event.kind === 'stderr') {
        if (event.base64 == null) return invalid()
        events.push(Object.freeze({ ...event, bytes: decodeDarwinProcessBytesV1(event.base64, MAX_EVENT_BYTES) }))
      } else {
        if (event.base64 !== undefined) return invalid()
        events.push(event)
      }
    }
    return events
  }

  write(generation, handle, bytes, callbackId) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_DARWIN_STDIN_CHUNK_BYTES_V1) return invalid()
    const value = this.command('write', {
      generation,
      handle,
      base64: encodeBase64(bytes, false),
      callbackId: callbackId ?? null
    })
    if (!exact(value, ['accepted']) || typeof value.accepted !== 'boolean') return invalid()
    return value.accepted
  }

  end(generation, handle, callbackId) {
    const value = this.command('end', { generation, handle, callbackId: callbackId ?? null })
    if (!exact(value, [])) return invalid()
  }

  destroy(generation, handle, index) {
    const value = this.command('destroy', { generation, handle, index })
    if (!exact(value, [])) return invalid()
  }

  signal(generation, handle, signal) {
    const value = this.command('signal', { generation, handle, signal })
    if (!exact(value, [])) return invalid()
  }

  close(generation) {
    const value = this.command('close', { generation })
    if (!exact(value, [])) return invalid()
  }
}
