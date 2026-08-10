import { invalidArgument } from './errors.js'
import { basenamePosix } from './path-basename.js'
import { parsePosixPath } from './path-parse.js'
import type { PathCompatApi, PathSyntheticModule } from './path-types.js'

export { basenamePosix } from './path-basename.js'
export { parsePosixPath } from './path-parse.js'
export type { PathCompatApi, PathParseResult, PathSyntheticModule } from './path-types.js'

const assertPath = (path: string, name = 'path') => {
  if (typeof path !== 'string') {
    invalidArgument(name, `${name} must be a string`)
  }
}

const trimTrailingSeparators = (path: string) => {
  let end = path.length
  while (end > 1 && path.charCodeAt(end - 1) === 47) {
    end -= 1
  }
  return path.slice(0, end)
}

export const normalizePosixPath = (path: string): string => {
  assertPath(path)
  if (path.length === 0) {
    return '.'
  }
  const absolute = path.startsWith('/')
  const trailingSeparator = path.endsWith('/')
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment.length === 0 || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (segments.length > 0 && segments.at(-1) !== '..') {
        segments.pop()
      } else if (!absolute) {
        segments.push(segment)
      }
      continue
    }
    segments.push(segment)
  }
  let normalized = `${absolute ? '/' : ''}${segments.join('/')}`
  if (normalized.length === 0) {
    normalized = absolute ? '/' : '.'
  }
  if (trailingSeparator && normalized !== '/' && !normalized.endsWith('/')) {
    normalized += '/'
  }
  return normalized
}

export const dirnamePosix = (path: string): string => {
  assertPath(path)
  if (path.length === 0) {
    return '.'
  }
  const trimmed = trimTrailingSeparators(path)
  const slashIndex = trimmed.lastIndexOf('/')
  if (slashIndex < 0) {
    return '.'
  }
  if (slashIndex === 0) {
    return '/'
  }
  if (slashIndex === 1 && trimmed.startsWith('//')) {
    return '//'
  }
  return trimmed.slice(0, slashIndex)
}

export const extnamePosix = (path: string): string => {
  const base = basenamePosix(path)
  const dotIndex = base.lastIndexOf('.')
  if (dotIndex <= 0 || base === '..') {
    return ''
  }
  return base.slice(dotIndex)
}

export const isAbsolutePosix = (path: string): boolean => {
  assertPath(path)
  return path.startsWith('/')
}

export const joinPosix = (...paths: string[]): string => {
  for (const path of paths) {
    assertPath(path)
  }
  const joined = paths.filter(path => path.length > 0).join('/')
  return normalizePosixPath(joined)
}

export const resolvePosixPath = (cwd: string, ...paths: string[]): string => {
  assertPath(cwd, 'cwd')
  if (!isAbsolutePosix(cwd)) {
    invalidArgument('cwd', 'mobile runtime cwd must be an absolute POSIX path')
  }
  let resolved = ''
  let absolute = false
  for (let index = paths.length - 1; index >= -1 && !absolute; index -= 1) {
    const path = index >= 0 ? paths[index]! : cwd
    assertPath(path)
    if (path.length === 0) {
      continue
    }
    resolved = `${path}/${resolved}`
    absolute = path.startsWith('/')
  }
  const normalized = normalizePosixPath(resolved)
  return trimTrailingSeparators(normalized)
}

export const relativePosixPath = (
  cwd: string,
  from: string,
  to: string
): string => {
  const fromParts = resolvePosixPath(cwd, from).split('/').filter(Boolean)
  const toParts = resolvePosixPath(cwd, to).split('/').filter(Boolean)
  let shared = 0
  while (
    shared < fromParts.length &&
    shared < toParts.length &&
    fromParts[shared] === toParts[shared]
  ) {
    shared += 1
  }
  return [
    ...fromParts.slice(shared).map(() => '..'),
    ...toParts.slice(shared)
  ].join('/')
}

export const createPathSyntheticModule = (cwd: string): PathSyntheticModule => {
  const api: PathCompatApi = Object.freeze({
    basename: basenamePosix,
    delimiter: ':',
    dirname: dirnamePosix,
    extname: extnamePosix,
    isAbsolute: isAbsolutePosix,
    join: joinPosix,
    normalize: normalizePosixPath,
    parse: parsePosixPath,
    relative: (from: string, to: string) => relativePosixPath(cwd, from, to),
    resolve: (...paths: string[]) => resolvePosixPath(cwd, ...paths),
    sep: '/'
  })
  const defaultApi = Object.freeze({ ...api, posix: api })
  return Object.freeze({ ...api, default: defaultApi, posix: api })
}
