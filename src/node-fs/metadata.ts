import { createFsError } from './errors.js'

import type { FsDirent, FsDirentRecord, FsOperationName, FsStatRecord, FsStats } from './types.js'

const hasExactKeys = (
  value: object,
  expected: readonly string[]
) => {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && keys.every(key => typeof key === 'string' && expected.includes(key))
}

const ownData = (value: object, key: string) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor != null && descriptor.enumerable && 'value' in descriptor
    ? descriptor.value
    : undefined
}

const isRecord = (value: unknown): value is object => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const readSafeNonNegative = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : undefined

export class MobileFsStats implements FsStats {
  readonly birthtimeMs: number
  readonly ctimeMs: number
  readonly mode: number
  readonly mtimeMs: number
  readonly size: number
  readonly #kind: 'directory' | 'file' | 'symlink'

  constructor(record: FsStatRecord) {
    this.#kind = record.kind
    this.birthtimeMs = record.birthtimeMs
    this.ctimeMs = record.ctimeMs
    this.mode = record.mode
    this.mtimeMs = record.mtimeMs
    this.size = record.size
    Object.freeze(this)
  }

  isDirectory() {
    return this.#kind === 'directory'
  }

  isFile() {
    return this.#kind === 'file'
  }

  isSymbolicLink() {
    return this.#kind === 'symlink'
  }
}

export class MobileFsDirent implements FsDirent {
  readonly name: string
  readonly #kind: 'directory' | 'file' | 'symlink'

  constructor(record: FsDirentRecord) {
    this.#kind = record.kind
    this.name = record.name
    Object.freeze(this)
  }

  isDirectory() {
    return this.#kind === 'directory'
  }

  isFile() {
    return this.#kind === 'file'
  }

  isSymbolicLink() {
    return this.#kind === 'symlink'
  }
}

export const parseStatRecord = (
  value: unknown,
  syscall?: FsOperationName
) => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'birthtimeMs',
      'ctimeMs',
      'kind',
      'mode',
      'mtimeMs',
      'size'
    ])
  ) {
    throw createFsError('EIO', syscall)
  }
  const kind = ownData(value, 'kind')
  const mode = readSafeNonNegative(ownData(value, 'mode'))
  const size = readSafeNonNegative(ownData(value, 'size'))
  const birthtimeMs = readSafeNonNegative(ownData(value, 'birthtimeMs'))
  const ctimeMs = readSafeNonNegative(ownData(value, 'ctimeMs'))
  const mtimeMs = readSafeNonNegative(ownData(value, 'mtimeMs'))
  if (
    (kind !== 'directory' && kind !== 'file' && kind !== 'symlink') ||
    mode == null ||
    mode > 0o7777 ||
    size == null ||
    birthtimeMs == null ||
    ctimeMs == null ||
    mtimeMs == null
  ) {
    throw createFsError('EIO', syscall)
  }
  return new MobileFsStats({
    birthtimeMs,
    ctimeMs,
    kind,
    mode,
    mtimeMs,
    size
  })
}

export const parseDirentRecords = (
  value: unknown,
  syscall?: FsOperationName
) => {
  if (!Array.isArray(value) || value.length > 4096) {
    throw createFsError('EIO', syscall)
  }
  return value.map((item) => {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ['kind', 'name'])
    ) {
      throw createFsError('EIO', syscall)
    }
    const kind = ownData(item, 'kind')
    const name = ownData(item, 'name')
    if (
      (kind !== 'directory' && kind !== 'file' && kind !== 'symlink') ||
      typeof name !== 'string' ||
      name.length === 0 ||
      name.length > 255 ||
      name === '.' ||
      name === '..' ||
      name.includes('/') ||
      name.includes('\\') ||
      name.includes('\0')
    ) {
      throw createFsError('EIO', syscall)
    }
    return new MobileFsDirent({ kind, name })
  })
}
