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
export const fsDescriptorTargetV1 = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return invalidFsValueV1('File descriptor must be a nonnegative safe integer')
  }
  return { fd: value, fields: fsTargetV1(value).fields }
}
export const fsLengthV1 = (value: unknown): number => {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return invalidFsValueV1('Length must be a nonnegative safe integer')
  }
  return value
}
export const fsAccessModeV1 = (value: unknown): number => {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 7) {
    return invalidFsValueV1('Access mode must use F_OK, R_OK, W_OK or X_OK')
  }
  return value
}
export const fsChmodModeV1 = (value: unknown): number => {
  const mode = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[0-7]{1,4}$/u.test(value)
    ? Number.parseInt(value, 8)
    : Number.NaN
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
    return invalidFsValueV1('Mode must be a permission value from 0000 to 0777')
  }
  return mode
}
const fsTimeV1 = (value: unknown) => {
  let seconds: number
  if (typeof value === 'number') seconds = value
  else if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value)) seconds = Number(value)
  else return invalidFsValueV1('Time must be a finite number or numeric string')
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 253_402_300_799) {
    return invalidFsValueV1('Time is outside the supported range')
  }
  let whole = Math.floor(seconds)
  let nanoseconds = Math.round((seconds - whole) * 1_000_000_000)
  if (nanoseconds === 1_000_000_000) {
    whole++
    nanoseconds = 0
  }
  if (whole > 253_402_300_799) return invalidFsValueV1('Time is outside the supported range')
  return Object.freeze({ kind: 'set', nanoseconds, seconds: whole })
}
export const fsTimesV1 = (atime: unknown, mtime: unknown) =>
  Object.freeze({ atime: fsTimeV1(atime), mtime: fsTimeV1(mtime) })
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
    ...(source.atimeMs === undefined ? {} : { atimeMs: source.atimeMs }),
    birthtimeMs: source.birthtimeMs,
    ctimeMs: source.ctimeMs,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
    mtimeMs: source.mtimeMs,
    ...(source.mode === undefined ? {} : { mode: source.mode }),
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
