import { FS_ROOT_AUTHORITIES, FS_VIRTUAL_SCHEME } from './constants.js'
import { createFsError } from './errors.js'

import type { FsOperationName, FsRootAuthority, ParsedFsPath } from './types.js'

const ENCODED_SEPARATOR = /%(?:2f|5c)/iu
const VALID_PERCENT_ESCAPE = /%[0-9a-f]{2}/giu

const isRootAuthority = (value: string): value is FsRootAuthority =>
  (FS_ROOT_AUTHORITIES as readonly string[]).includes(value)

const decodeSegment = (segment: string, syscall?: FsOperationName) => {
  if (ENCODED_SEPARATOR.test(segment)) throw createFsError('EINVAL', syscall)
  const withoutEscapes = segment.replace(VALID_PERCENT_ESCAPE, '')
  if (withoutEscapes.includes('%')) throw createFsError('EINVAL', syscall)

  let decoded: string
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    throw createFsError('EINVAL', syscall)
  }
  if (
    decoded.length === 0 ||
    decoded === '.' ||
    decoded === '..' ||
    decoded.includes('/') ||
    decoded.includes('\\') ||
    decoded.includes('\0')
  ) {
    throw createFsError('EINVAL', syscall)
  }
  return decoded
}

export const formatFsPath = (
  authority: FsRootAuthority,
  segments: readonly string[]
) => `${FS_VIRTUAL_SCHEME}://${authority}/${segments.map(encodeURIComponent).join('/')}`

export const fsRootUrl = (authority: FsRootAuthority) => formatFsPath(authority, [])

export const parseFsPath = (
  path: string,
  syscall?: FsOperationName
): ParsedFsPath => {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > 4096 ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#')
  ) {
    throw createFsError('EINVAL', syscall)
  }

  const prefix = `${FS_VIRTUAL_SCHEME}://`
  if (!path.startsWith(prefix)) throw createFsError('EACCES', syscall)
  const remainder = path.slice(prefix.length)
  const slashIndex = remainder.indexOf('/')
  if (slashIndex < 0) throw createFsError('EINVAL', syscall)
  const authority = remainder.slice(0, slashIndex)
  if (!isRootAuthority(authority)) throw createFsError('EACCES', syscall)

  const rawPath = remainder.slice(slashIndex + 1)
  if (rawPath.endsWith('/') && rawPath.length > 0) {
    throw createFsError('EINVAL', syscall)
  }
  const segments = rawPath.length === 0
    ? []
    : rawPath.split('/').map(segment => decodeSegment(segment, syscall))
  return Object.freeze({
    authority,
    href: formatFsPath(authority, segments),
    segments: Object.freeze(segments)
  })
}

export const joinFsPath = (
  base: ParsedFsPath,
  name: string,
  syscall?: FsOperationName
) => {
  const segment = decodeSegment(encodeURIComponent(name), syscall)
  return formatFsPath(base.authority, [...base.segments, segment])
}
