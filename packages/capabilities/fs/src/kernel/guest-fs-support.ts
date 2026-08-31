import { capabilityTextEncodingV1, capabilityTextPathV1 } from '@holonomyjs/runtime/kernel/guest-facade-support'
import type { CapabilityGuestAbortSignalV1 } from '@holonomyjs/runtime/kernel/guest-facade-support'
import type { JsonValueV1 } from '@holonomyjs/runtime/kernel/json-types'
import { sha256Hex } from '@holonomyjs/runtime/module-loader/sha256'
import { encodeBase64 } from '@holonomyjs/runtime/node-compat/encoding'

export type FsCapabilityFieldsV1 = Readonly<Record<string, string>>
export interface FsPreparedOptionsV1 {
  readonly options: JsonValueV1
  readonly signal?: CapabilityGuestAbortSignalV1
}

export const invalidFsValueV1 = (message: string): never => {
  const error = new TypeError(message)
  Object.defineProperty(error, 'code', { enumerable: true, value: 'EINVAL' })
  throw error
}
export const fsObjectV1 = (value: unknown): Record<string, unknown> => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidFsValueV1('Options must be an object')
  }
  return value as Record<string, unknown>
}
export const fsJsonObjectV1 = (value: unknown): Readonly<Record<string, JsonValueV1>> =>
  fsObjectV1(value) as Readonly<Record<string, JsonValueV1>>
export const fsFunctionV1 = (value: unknown): (...args: unknown[]) => unknown =>
  typeof value === 'function'
    ? value as (...args: unknown[]) => unknown
    : invalidFsValueV1('Callback must be a function')
export const fsDataV1 = (value: unknown): JsonValueV1 => {
  if (typeof value === 'string') return value
  if (!(value instanceof Uint8Array)) return invalidFsValueV1('Data must be a string or Uint8Array')
  const bytes = new Uint8Array(value)
  return { base64: encodeBase64(bytes, false), byteLength: bytes.byteLength, sha256: sha256Hex(bytes) }
}
export const fsTargetV1 = (value: unknown): { fields: FsCapabilityFieldsV1; value: JsonValueV1 } => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return {
      fields: { bindingId: `fd-${String(value)}`, resourceType: 'filesystem.file-handle' },
      value: { binding: 'opaque', fd: value }
    }
  }
  const path = capabilityTextPathV1(value)
  return { fields: { path }, value: path }
}
export const fsAbortSignalV1 = (value: unknown): CapabilityGuestAbortSignalV1 | undefined => {
  if (value === undefined) return undefined
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidFsValueV1('Invalid filesystem AbortSignal')
  }
  const source = value as { aborted?: unknown; addEventListener?: unknown; removeEventListener?: unknown }
  const addEventListener = source.addEventListener
  const removeEventListener = source.removeEventListener
  if (
    typeof source.aborted !== 'boolean' || typeof addEventListener !== 'function' ||
    typeof removeEventListener !== 'function'
  ) return invalidFsValueV1('Invalid filesystem AbortSignal')
  return Object.freeze({
    add(listener: () => void) {
      addEventListener.call(value, 'abort', listener, { once: true })
    },
    readAborted() {
      if (typeof source.aborted !== 'boolean') return invalidFsValueV1('Invalid filesystem AbortSignal')
      return source.aborted
    },
    remove(listener: () => void) {
      removeEventListener.call(value, 'abort', listener)
    }
  })
}
export const fsReadOptionsV1 = (value: unknown, async: boolean): FsPreparedOptionsV1 => {
  const source = value === undefined || value === null
    ? {}
    : typeof value === 'string'
    ? { encoding: value }
    : fsObjectV1(value)
  const output: Record<string, JsonValueV1> = { encoding: capabilityTextEncodingV1(source) }
  if (source.flag !== undefined) output.flag = source.flag as JsonValueV1
  if (!async && source.signal !== undefined) return invalidFsValueV1('Sync filesystem methods do not accept signal')
  const signal = async ? fsAbortSignalV1(source.signal) : undefined
  return Object.freeze({ options: output, ...(signal == null ? {} : { signal }) })
}
export const fsWriteOptionsV1 = (value: unknown, async: boolean): FsPreparedOptionsV1 => {
  const source = value === undefined || value === null
    ? {}
    : typeof value === 'string'
    ? { encoding: value }
    : fsObjectV1(value)
  const output: Record<string, JsonValueV1> = { encoding: capabilityTextEncodingV1(source) ?? 'utf8' }
  if (source.flag !== undefined) output.flag = source.flag as JsonValueV1
  if (!async && source.signal !== undefined) return invalidFsValueV1('Sync filesystem methods do not accept signal')
  const signal = async ? fsAbortSignalV1(source.signal) : undefined
  return Object.freeze({ options: output, ...(signal == null ? {} : { signal }) })
}
export const fsStatsV1 = (value: unknown) => {
  const source = fsObjectV1(value)
  const kind = source.kind
  return Object.freeze({
    birthtimeMs: source.birthtimeMs,
    ctimeMs: source.ctimeMs,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
    mtimeMs: source.mtimeMs,
    size: source.size
  })
}
export const fsDirentsV1 = (value: unknown) =>
  Array.isArray(value) && value.some(item => typeof item === 'object' && item != null)
    ? value.map(item => {
      const source = fsObjectV1(item)
      const kind = source.kind
      return Object.freeze({
        isDirectory: () => kind === 'directory',
        isFile: () => kind === 'file',
        isSymbolicLink: () => kind === 'symlink',
        name: source.name
      })
    })
    : value
export const fsMkdirResultV1 = (value: unknown) => {
  const source = fsObjectV1(value)
  return source.kind === 'path' ? source.value : undefined
}
