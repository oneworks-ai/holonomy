import { constants } from './constants.js'
import { createFsError } from './errors.js'

import type { FsOpenFlags, FsOperationName, FsStringOpenFlags } from './types.js'

const STRING_FLAGS: Record<FsStringOpenFlags, number> = {
  a: constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
  'a+': constants.O_RDWR | constants.O_APPEND | constants.O_CREAT,
  ax: constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL,
  'ax+': constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL,
  r: constants.O_RDONLY,
  'r+': constants.O_RDWR,
  w: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
  'w+': constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC,
  wx: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_EXCL,
  'wx+': constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_EXCL
}

const KNOWN_FLAGS = constants.O_WRONLY |
  constants.O_RDWR |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_DIRECTORY |
  constants.O_EXCL |
  constants.O_NOFOLLOW |
  constants.O_TRUNC

export interface ParsedOpenFlags {
  append: boolean
  create: boolean
  directory: boolean
  exclusive: boolean
  noFollow: boolean
  numeric: number
  readable: boolean
  truncate: boolean
  writable: boolean
}

export const parseOpenFlags = (
  flags: FsOpenFlags,
  syscall: FsOperationName = 'open'
): ParsedOpenFlags => {
  const numeric = typeof flags === 'string' ? STRING_FLAGS[flags] : flags
  if (
    numeric == null ||
    !Number.isSafeInteger(numeric) ||
    numeric < 0 ||
    (numeric & ~KNOWN_FLAGS) !== 0
  ) {
    throw createFsError('EINVAL', syscall)
  }
  const accessMode = numeric & 3
  if (accessMode > constants.O_RDWR) throw createFsError('EINVAL', syscall)
  const readable = accessMode === constants.O_RDONLY || accessMode === constants.O_RDWR
  const writable = accessMode === constants.O_WRONLY || accessMode === constants.O_RDWR
  const create = (numeric & constants.O_CREAT) !== 0
  const truncate = (numeric & constants.O_TRUNC) !== 0
  const append = (numeric & constants.O_APPEND) !== 0
  const exclusive = (numeric & constants.O_EXCL) !== 0
  if (
    (truncate && !writable) ||
    (append && !writable) ||
    (exclusive && !create) ||
    (create && (numeric & constants.O_DIRECTORY) !== 0)
  ) {
    throw createFsError('EINVAL', syscall)
  }
  return Object.freeze({
    append,
    create,
    directory: (numeric & constants.O_DIRECTORY) !== 0,
    exclusive,
    noFollow: (numeric & constants.O_NOFOLLOW) !== 0,
    numeric,
    readable,
    truncate,
    writable
  })
}

export const normalizeMode = (
  mode: number | undefined,
  fallback: number,
  syscall: FsOperationName
) => {
  const resolved = mode ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 0o7777) {
    throw createFsError('EINVAL', syscall)
  }
  return resolved
}
