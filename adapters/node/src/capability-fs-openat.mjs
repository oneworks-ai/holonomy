import { createRequire } from 'node:module'
import { constants as osConstants } from 'node:os'

// Host-only OS primitive. The Guest module graph must never expose this module
// or the returned raw fd; the filesystem Provider owns authority and lifetime.
const require = createRequire(import.meta.url)
const ADDON_PATH = '../native/filesystem-openat/build/Release/holonomy_filesystem_openat.node'

const loadAddon = () => {
  try {
    const addon = require(ADDON_PATH)
    return typeof addon?.openAt === 'function' &&
        typeof addon?.accessAt === 'function' &&
        typeof addon?.futimens === 'function' &&
        typeof addon?.accessDirectory === 'function' &&
        typeof addon?.readDirectoryFd === 'function' &&
        typeof addon?.duplicateDirectoryFd === 'function'
      ? Object.freeze(addon)
      : undefined
  } catch {
    return undefined
  }
}

const addon = loadAddon()

const unavailable = () => {
  const error = new Error('Node filesystem openat unavailable')
  error.code = 'ENOSYS'
  error.errno = osConstants.errno.ENOSYS
  return error
}

export const openAt = Object.freeze((parentFd, leafName, nativeFlags, mode = 0o600) => {
  if (addon == null) throw unavailable()
  return addon.openAt(parentFd, leafName, nativeFlags, mode)
})
export const accessAt = Object.freeze((parentFd, leafName, mode) => {
  if (addon == null) throw unavailable()
  return addon.accessAt(parentFd, leafName, mode)
})
export const futimens = Object.freeze((fd, atime, mtime) => {
  if (addon == null) throw unavailable()
  return addon.futimens(fd, atime, mtime)
})
export const accessDirectory = Object.freeze((fd, mode) => {
  if (addon == null) throw unavailable()
  return addon.accessDirectory(fd, mode)
})
export const readDirectoryFd = Object.freeze((fd, maximum) => {
  if (addon == null) throw unavailable()
  return addon.readDirectoryFd(fd, maximum)
})
export const duplicateDirectoryFd = Object.freeze(fd => {
  if (addon == null) throw unavailable()
  return addon.duplicateDirectoryFd(fd)
})
