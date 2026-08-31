import type { ProcessBackendSpawnRequestV1 } from '@holonomyjs/capability-process'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

const invalid = (): never => {
  throw new TypeError('Invalid HoloUV supervisor payload')
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((size, value) => size + value.byteLength, 0))
  let offset = 0
  for (const value of parts) {
    output.set(value, offset)
    offset += value.byteLength
  }
  return output
}

const writer = () => {
  const parts: Uint8Array[] = []
  return Object.freeze({
    bytes(value: Uint8Array) {
      parts.push(Uint8Array.from(value))
    },
    finish() {
      return concat(parts)
    },
    string(value: string) {
      if (typeof value !== 'string' || value.includes('\0')) return invalid()
      const bytes = encoder.encode(value)
      const length = new Uint8Array(4)
      new DataView(length.buffer).setUint32(0, bytes.byteLength)
      parts.push(length, bytes)
    },
    u16(value: number) {
      if (!Number.isInteger(value) || value < 0 || value > 0xFFFF) return invalid()
      const bytes = new Uint8Array(2)
      new DataView(bytes.buffer).setUint16(0, value)
      parts.push(bytes)
    },
    u32(value: number) {
      if (!Number.isInteger(value) || value < 0 || value > 0xFFFFFFFF) return invalid()
      const bytes = new Uint8Array(4)
      new DataView(bytes.buffer).setUint32(0, value)
      parts.push(bytes)
    }
  })
}

export interface HoloUvEnvironmentHostV1 {
  readonly address: string
  readonly hostname: string
}

export interface HoloUvEnvironmentConfigurationV1 {
  readonly execGateTimeoutMs: number
  readonly hosts: readonly HoloUvEnvironmentHostV1[]
  readonly version: 1
}

const ipv4 = (value: string): boolean => {
  const parts = value.split('.')
  return parts.length === 4 && parts.every(part => /^(?:0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255)
}

const hostname = (value: string): boolean =>
  value.length >= 1 && value.length <= 253 && value === value.toLowerCase() &&
  value.split('.').every(label =>
    label.length >= 1 && label.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/u.test(label)
  )

export const encodeHoloUvEnvironmentConfigurationV1 = (
  value: HoloUvEnvironmentConfigurationV1
): Uint8Array => {
  if (
    value == null || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.hosts) ||
    value.hosts.length > 256 || !Number.isInteger(value.execGateTimeoutMs) ||
    value.execGateTimeoutMs < 1 || value.execGateTimeoutMs > 120_000
  ) return invalid()
  const hosts = value.hosts.map(item => {
    if (
      item == null || typeof item !== 'object' || Object.keys(item).length !== 2 ||
      !Object.hasOwn(item, 'address') || !Object.hasOwn(item, 'hostname') ||
      typeof item.address !== 'string' || typeof item.hostname !== 'string' ||
      !ipv4(item.address) || !hostname(item.hostname)
    ) return invalid()
    return Object.freeze({ address: item.address, hostname: item.hostname })
  })
  hosts.sort((left, right) => left.hostname.localeCompare(right.hostname))
  if (
    new Set(hosts.map(item => item.hostname)).size !== hosts.length ||
    new Set(hosts.map(item => item.address)).size !== hosts.length
  ) return invalid()
  const output = writer()
  output.bytes(Uint8Array.of(1, 0))
  output.u16(hosts.length)
  output.u32(value.execGateTimeoutMs)
  for (const host of hosts) {
    output.string(host.address)
    output.string(host.hostname)
  }
  return output.finish()
}

const reader = (value: Uint8Array) => {
  if (!(value instanceof Uint8Array)) return invalid()
  const bytes = Uint8Array.from(value)
  const view = new DataView(bytes.buffer)
  let offset = 0
  return Object.freeze({
    done() {
      if (offset !== bytes.byteLength) return invalid()
    },
    i32() {
      if (offset + 4 > bytes.byteLength) return invalid()
      const output = view.getInt32(offset)
      offset += 4
      return output
    },
    u8() {
      if (offset + 1 > bytes.byteLength) return invalid()
      return bytes[offset++]!
    },
    u16() {
      if (offset + 2 > bytes.byteLength) return invalid()
      const output = view.getUint16(offset)
      offset += 2
      return output
    },
    string() {
      if (offset + 4 > bytes.byteLength) return invalid()
      const length = view.getUint32(offset)
      offset += 4
      if (offset + length > bytes.byteLength) return invalid()
      const source = bytes.slice(offset, offset + length)
      offset += length
      let output: string
      try {
        output = decoder.decode(source)
      } catch {
        return invalid()
      }
      const encoded = Uint8Array.from(encoder.encode(output))
      if (
        output.includes('\0') || encoded.byteLength !== source.byteLength ||
        !encoded.every((byte, index) => byte === source[index])
      ) {
        return invalid()
      }
      return output
    }
  })
}

export interface HoloUvCapabilityRequestV1 {
  readonly command: readonly string[]
  readonly version: 1
}

export type HoloUvCapabilityResponseV1 =
  | Readonly<{ error: string; ok: false; version: 1 }>
  | Readonly<{ json: string; ok: true; version: 1 }>

const capabilityToken = (value: string): boolean =>
  value.length >= 1 && value.length <= 4096 && /^[\w.:/-]+$/u.test(value)

export const encodeHoloUvCapabilityRequestV1 = (value: HoloUvCapabilityRequestV1): Uint8Array => {
  if (
    value == null || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.command) ||
    value.command.length < 2 || value.command.length > 8 || value.command.some(item => !capabilityToken(item))
  ) return invalid()
  const output = writer()
  output.bytes(Uint8Array.of(1, value.command.length, 0, 0))
  for (const item of value.command) output.string(item)
  const bytes = output.finish()
  return bytes.byteLength <= 64 * 1024 ? bytes : invalid()
}

export const decodeHoloUvCapabilityRequestV1 = (value: Uint8Array): HoloUvCapabilityRequestV1 => {
  const input = reader(value)
  const version = input.u8()
  const count = input.u8()
  if (version !== 1 || count < 2 || count > 8 || input.u16() !== 0) return invalid()
  const command = Object.freeze(Array.from({ length: count }, () => input.string()))
  input.done()
  if (command.some(item => !capabilityToken(item))) return invalid()
  return Object.freeze({ command, version: 1 })
}

export const encodeHoloUvCapabilityResponseV1 = (value: HoloUvCapabilityResponseV1): Uint8Array => {
  if (value == null || typeof value !== 'object' || value.version !== 1 || typeof value.ok !== 'boolean') {
    return invalid()
  }
  const text = value.ok ? value.json : value.error
  if (
    typeof text !== 'string' || text.includes('\0') || encoder.encode(text).byteLength > 256 * 1024 ||
    !value.ok && !/^[a-z][a-z\d_.-]{0,63}$/u.test(text)
  ) return invalid()
  if (value.ok) {
    try {
      JSON.parse(text)
    } catch {
      return invalid()
    }
  }
  const output = writer()
  output.bytes(Uint8Array.of(1, value.ok ? 1 : 0, 0, 0))
  output.string(text)
  return output.finish()
}

export const decodeHoloUvCapabilityResponseV1 = (value: Uint8Array): HoloUvCapabilityResponseV1 => {
  const input = reader(value)
  const version = input.u8()
  const status = input.u8()
  if (version !== 1 || status > 1 || input.u16() !== 0) return invalid()
  const text = input.string()
  input.done()
  if (status === 1) {
    try {
      JSON.parse(text)
    } catch {
      return invalid()
    }
    return Object.freeze({ json: text, ok: true, version: 1 })
  }
  if (!/^[a-z][a-z\d_.-]{0,63}$/u.test(text)) return invalid()
  return Object.freeze({ error: text, ok: false, version: 1 })
}

export const decodeHoloUvCompletionPayloadV1 = (value: Uint8Array) => {
  const input = reader(value)
  const code = input.i32()
  const signal = input.string()
  input.done()
  if (code < -1 || code > 255 || signal !== '' && !/^SIG[A-Z\d]{1,24}$/u.test(signal)) return invalid()
  return Object.freeze({ code: code === -1 ? null : code, signal: signal === '' ? null : signal })
}

export const decodeHoloUvErrorPayloadV1 = (value: Uint8Array): Error => {
  const input = reader(value)
  const code = input.string()
  input.done()
  if (!/^[a-z][a-z\d_.-]{0,63}$/u.test(code)) return invalid()
  const error = new Error('HoloUV supervisor operation failed')
  Object.defineProperty(error, 'code', { enumerable: true, value: code })
  return error
}

export const decodeHoloUvSpawnedPayloadV1 = (value: Uint8Array, frameProcessId: number) => {
  if (!Number.isInteger(frameProcessId) || frameProcessId <= 0) return invalid()
  const input = reader(value)
  const linuxPid = input.i32()
  input.done()
  if (linuxPid <= 0) return invalid()
  return Object.freeze({ linuxPid, processId: frameProcessId })
}

export const encodeHoloUvSignalPayloadV1 = (signal: string): Uint8Array => {
  if (typeof signal !== 'string' || !/^SIG[A-Z\d]{1,24}$/u.test(signal)) return invalid()
  const output = writer()
  output.string(signal)
  return output.finish()
}

export const encodeHoloUvCompletionPayloadV1 = (code: number | null, signal: string | null): Uint8Array => {
  if (
    code != null && (!Number.isInteger(code) || code < 0 || code > 255) ||
    signal != null && !/^SIG[A-Z\d]{1,24}$/u.test(signal)
  ) return invalid()
  const head = new Uint8Array(4)
  new DataView(head.buffer).setInt32(0, code ?? -1)
  const tail = writer()
  tail.string(signal ?? '')
  return concat([head, tail.finish()])
}

export const encodeHoloUvSpawnedPayloadV1 = (linuxPid: number): Uint8Array => {
  if (!Number.isInteger(linuxPid) || linuxPid <= 0 || linuxPid > 0x7FFF_FFFF) return invalid()
  const output = new Uint8Array(4)
  new DataView(output.buffer).setInt32(0, linuxPid)
  return output
}

export const encodeHoloUvSpawnPayloadV1 = <TExecutable extends { readonly kind: string; readonly path: string }>(
  request: ProcessBackendSpawnRequestV1<TExecutable>
): Uint8Array => {
  if (
    request.executable?.kind !== 'guestPath' || !Array.isArray(request.stdio) || request.stdio.length !== 3 ||
    request.stdio.some(mode => mode !== 'ignore' && mode !== 'pipe')
  ) return invalid()
  const entries = Object.entries(request.env).sort(([left], [right]) => left < right ? -1 : 1)
  if (request.args.length > 0xFFFF || entries.length > 0xFFFF) return invalid()
  const output = writer()
  output.bytes(Uint8Array.of(
    1,
    request.stdio.reduce((mask, mode, index) => mode === 'pipe' ? mask | (1 << index) : mask, 0),
    0,
    0
  ))
  for (const value of [request.executable.path, request.cwd, request.executableId, request.processResourceId]) {
    output.string(value)
  }
  output.u16(request.args.length)
  output.u16(entries.length)
  for (const value of request.args) output.string(value)
  for (const [key, value] of entries) {
    output.string(key)
    output.string(value)
  }
  return output.finish()
}

export const requireEmptyHoloUvPayloadV1 = (value: Uint8Array): void => {
  if (!(value instanceof Uint8Array) || value.byteLength !== 0) return invalid()
}
