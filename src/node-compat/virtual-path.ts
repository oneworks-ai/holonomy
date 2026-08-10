import { invalidArgument, outOfBounds } from './errors.js'
import { isAbsolutePosix, normalizePosixPath } from './path.js'

const ANDROID_HOST_PATH_PREFIXES = [
  '/apex',
  '/data',
  '/dev',
  '/mnt',
  '/proc',
  '/sdcard',
  '/storage',
  '/sys',
  '/system',
  '/vendor'
]

export const normalizeVirtualRoot = (virtualRoot: string): string => {
  if (typeof virtualRoot !== 'string' || !isAbsolutePosix(virtualRoot)) {
    invalidArgument('virtualRoot', 'virtualRoot must be an absolute POSIX path')
  }
  if (virtualRoot.includes('\0') || virtualRoot.includes('\\')) {
    invalidArgument('virtualRoot', 'virtualRoot must be a portable POSIX path')
  }
  const normalized = normalizePosixPath(virtualRoot)
  if (
    normalized === '/' ||
    ANDROID_HOST_PATH_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`))
  ) {
    invalidArgument(
      'virtualRoot',
      'virtualRoot must be a dedicated virtual namespace, not an Android host path'
    )
  }
  return normalized === '/' ? normalized : normalized.replace(/\/$/u, '')
}

export const assertPathWithinVirtualRoot = (
  path: string,
  virtualRoot: string,
  name = 'path'
): string => {
  if (typeof path !== 'string' || !isAbsolutePosix(path)) {
    invalidArgument(name, `${name} must be an absolute POSIX path`)
  }
  if (path.includes('\0') || path.includes('\\')) {
    invalidArgument(name, `${name} must not contain NUL or backslash`)
  }
  const normalizedRoot = normalizeVirtualRoot(virtualRoot)
  const normalizedPath = normalizePosixPath(path)
  const comparisonPath = normalizedPath.replace(/\/$/u, '') || '/'
  const withinRoot = normalizedRoot === '/' ||
    comparisonPath === normalizedRoot ||
    comparisonPath.startsWith(`${normalizedRoot}/`)
  if (!withinRoot) {
    outOfBounds(`${name} escapes the mobile runtime virtual root`)
  }
  return normalizedPath
}
