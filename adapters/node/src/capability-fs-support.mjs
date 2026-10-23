/* eslint-disable max-lines -- Node Provider filesystem authorization and flag translation share one boundary. */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import process from 'node:process'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { guestInvocationErrorV1 } from '@holonomyjs/runtime/kernel/invocation-guest-error'
import { CapabilityInvocationError } from '../../../dist/capability-runtime/index.js'

export const watchErrorSnapshot = error => {
  const code = error?.code === 'ENOENT'
    ? 'resource.not_found'
    : error?.code === 'ENOSPC'
    ? 'resource.event_limit'
    : 'provider.unavailable'
  return guestInvocationErrorV1(new CapabilityInvocationError(code, 'filesystem.watch.subscribe'), 'nodeFs')
}

export const mapProviderError = (error, operation, digest) => {
  if (error instanceof CapabilityInvocationError) throw error
  const code = error?.code === 'ENOENT'
    ? 'resource.not_found'
    : error?.code === 'EEXIST'
    ? 'resource.exists'
    : error?.code === 'EMFILE'
    ? 'resource.handle_limit'
    : error?.code === 'EACCES' || error?.code === 'EPERM'
    ? 'provider.permission_denied'
    : error?.code === 'EXDEV'
    ? 'resource.cross_root'
    : error?.code === 'ESTALE'
    ? 'resource.stale'
    : error?.code === 'EOVERFLOW'
    ? 'provider.quota'
    : error?.code === 'ELOOP'
    ? 'resource.cross_root'
    : 'provider.unavailable'
  throw new CapabilityInvocationError(code, operation, digest)
}

export const selectedFilesystemRootConstraint = (authority, resource, rights, requirePrefix = true) => {
  const required = Array.isArray(rights) ? rights : [rights]
  for (const binding of authority.bindings) {
    for (const root of binding.constraints.roots ?? []) {
      if (
        root.rootId === resource.rootId && required.every(right => root.rights?.includes(right)) &&
        (!requirePrefix || (root.pathPrefixSegments ?? []).every(
          (part, index) => resource.pathSegments[index] === part
        ))
      ) return root
    }
  }
}

export const selectedFilesystemRoot = (authority, resource, right) =>
  selectedFilesystemRootConstraint(authority, resource, right) != null

export const filesystemSymlinkMode = (authority, resource) => {
  const root = selectedFilesystemRootConstraint(authority, resource, [], false)
  if (root?.symlinks !== 'deny' && root?.symlinks !== 'withinRoot') {
    throw new CapabilityInvocationError(
      'capability.denied',
      'filesystem.resolve',
      resource.semanticResourceDigest
    )
  }
  return root.symlinks
}

const portableOpenFlag = flag => {
  if (
    flag == null || typeof flag !== 'object' || Array.isArray(flag) ||
    Object.keys(flag).length !== 6 ||
    Object.keys(flag).some(key => !['kind', 'access', 'create', 'exclusive', 'truncate', 'append'].includes(key)) ||
    flag.kind !== 'portable-open-v1' || !['read', 'write', 'readWrite'].includes(flag.access) ||
    !['create', 'exclusive', 'truncate', 'append'].every(key => typeof flag[key] === 'boolean') ||
    flag.exclusive && !flag.create ||
    flag.access === 'read' && (flag.truncate || flag.append)
  ) throw new CapabilityInvocationError('argument.invalid', 'filesystem.file.open')
  return flag
}

export const handleFlagRights = flag => {
  if (typeof flag === 'string') {
    return flag.includes('+') ? ['read', 'write'] : flag.startsWith('r') ? ['read'] : ['write']
  }
  const value = portableOpenFlag(flag)
  return value.access === 'read' ? ['read'] : value.access === 'write' ? ['write'] : ['read', 'write']
}

export const flagRights = flag => {
  const rights = handleFlagRights(flag)
  return typeof flag === 'object' && flag.create && !rights.includes('write') ? [...rights, 'write'] : rights
}

export const nodeOpenFlag = flag => {
  const constants = nodeFs.constants
  if (typeof flag === 'string') {
    const strings = {
      r: constants.O_RDONLY,
      'r+': constants.O_RDWR,
      w: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
      'w+': constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC,
      wx: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_EXCL,
      'wx+': constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_EXCL,
      a: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
      'a+': constants.O_RDWR | constants.O_CREAT | constants.O_APPEND,
      ax: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_EXCL,
      'ax+': constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_EXCL
    }
    if (!Object.hasOwn(strings, flag)) throw new CapabilityInvocationError('argument.invalid', 'filesystem.file.open')
    return strings[flag]
  }
  const value = portableOpenFlag(flag)
  let native = value.access === 'read' ? constants.O_RDONLY : value.access === 'write'
    ? constants.O_WRONLY
    : constants.O_RDWR
  if (value.create) native |= constants.O_CREAT
  if (value.exclusive) native |= constants.O_EXCL
  if (value.truncate) native |= constants.O_TRUNC
  if (value.append) native |= constants.O_APPEND
  return native
}

export const rightFor = (context, resource, authority) => {
  const operation = context.operation
  if (operation === 'filesystem.metadata.access') {
    const mode = context.arguments.mode
    if (!Number.isInteger(mode) || mode < 0 || mode > 7) {
      throw new CapabilityInvocationError('argument.invalid', operation)
    }
    if (mode === 0) return ['read']
    const fixed = [...(mode & 2 ? ['write'] : []), ...(mode & 1 ? ['list'] : [])]
    const candidates = mode & 4
      ? [['read', ...fixed], ['list', ...fixed]]
      : [fixed]
    return candidates.find(candidate => selectedFilesystemRootConstraint(authority, resource, candidate) != null) ??
      candidates[0]
  }
  if (operation === 'filesystem.metadata.chmod') return 'chmod'
  if (operation === 'filesystem.metadata.utimes' || operation === 'filesystem.file.truncate') return 'write'
  if (operation === 'filesystem.file.sync' || operation === 'filesystem.file.datasync') return []
  if (operation === 'filesystem.directory.open') return 'list'
  if (operation === 'filesystem.directory.sync' || operation === 'filesystem.directory.close') return []
  if (operation === 'filesystem.file.read' || operation.startsWith('filesystem.metadata.')) return 'read'
  if (operation === 'filesystem.file.write') return 'write'
  if (operation === 'filesystem.directory.read') return 'list'
  if (operation === 'filesystem.directory.create') return 'create'
  if (operation === 'filesystem.entry.rename') return 'move'
  if (operation === 'filesystem.entry.unlink') return 'delete'
  if (operation === 'filesystem.watch.subscribe' || operation === 'filesystem.watch.close') return 'watch'
  if (operation === 'filesystem.file.open') {
    if (typeof context.arguments.flag === 'object' && context.source?.kind !== 'linuxProcess') {
      throw new CapabilityInvocationError('capability.denied', operation)
    }
    return flagRights(context.arguments.flag)
  }
  if (operation === 'filesystem.file.close') return 'read'
  throw new CapabilityInvocationError('capability.denied', operation, resource.semanticResourceDigest)
}

export const resultData = bytes => ({
  base64: bytes.toString('base64'),
  byteLength: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex')
})

export const output = (bytes, encoding) => encoding == null ? resultData(bytes) : bytes.toString(encoding)

export const inputData = value => {
  if (typeof value === 'string') return value
  if (
    value == null || typeof value !== 'object' || typeof value.base64 !== 'string' ||
    typeof value.byteLength !== 'number' || typeof value.sha256 !== 'string'
  ) throw new CapabilityInvocationError('argument.invalid', 'filesystem.file.write')
  const bytes = Buffer.from(value.base64, 'base64')
  if (
    bytes.byteLength !== value.byteLength ||
    createHash('sha256').update(bytes).digest('hex') !== value.sha256
  ) throw new CapabilityInvocationError('argument.invalid', 'filesystem.file.write')
  return bytes
}

export const statSnapshot = value => {
  const atimeNs = BigInt(value.atimeNs ?? Math.round(value.atimeMs * 1_000_000))
  const ctimeNs = BigInt(value.ctimeNs ?? Math.round(value.ctimeMs * 1_000_000))
  const mtimeNs = BigInt(value.mtimeNs ?? Math.round(value.mtimeMs * 1_000_000))
  const birthtimeNs = BigInt(value.birthtimeNs ?? Math.round(value.birthtimeMs * 1_000_000))
  return {
    atimeMs: Number(atimeNs) / 1_000_000,
    atimeNs: atimeNs.toString(),
    birthtimeMs: Math.max(0, Number(birthtimeNs) / 1_000_000),
    ctimeMs: Number(ctimeNs) / 1_000_000,
    ctimeNs: ctimeNs.toString(),
    kind: value.isDirectory() ? 'directory' : value.isSymbolicLink() ? 'symlink' : 'file',
    mode: Number(value.mode),
    mtimeMs: Number(mtimeNs) / 1_000_000,
    mtimeNs: mtimeNs.toString(),
    size: Number(value.size)
  }
}

export const chmodMode = (mode, operation) => {
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
    throw new CapabilityInvocationError('argument.invalid', operation)
  }
  return mode
}

export const chmodExpectedKind = context => {
  const expectedKind = context.arguments?.expectedKind
  if (expectedKind === undefined) return undefined
  if (
    context.source?.kind !== 'linuxProcess' || context.arguments?.readback !== true ||
    !['file', 'directory'].includes(expectedKind)
  ) throw new CapabilityInvocationError('argument.invalid', context.operation)
  return expectedKind
}

export const assertReadLimit = (context, length) => {
  const maximum = context.authorityBindings[0]?.constraints?.limits?.maxReadBytes
  if (typeof maximum !== 'number' || length > maximum) {
    throw new CapabilityInvocationError(
      'resource.byte_limit',
      context.operation,
      context.resource.requested.semanticResourceDigest
    )
  }
}

export const assertWriteLimit = (context, data) => {
  const length = typeof data === 'string' ? Buffer.byteLength(data) : data?.byteLength
  const maximum = context.authorityBindings[0]?.constraints?.limits?.maxWriteBytes
  if (typeof length !== 'number' || typeof maximum !== 'number' || length > maximum) {
    throw new CapabilityInvocationError(
      'resource.byte_limit',
      context.operation,
      context.resource.requested.semanticResourceDigest
    )
  }
}

export const watchQueueLimit = context => {
  const maximum = context.authorityBindings[0]?.constraints?.limits?.maxQueuedEvents
  const requested = context.arguments.options?.maxQueuedEvents
  if (
    !Number.isSafeInteger(maximum) || maximum < 1 ||
    requested != null && (!Number.isSafeInteger(requested) || requested < 1 || requested > maximum)
  ) {
    throw new CapabilityInvocationError(
      requested == null ? 'resource.handle_limit' : 'argument.invalid',
      context.operation,
      context.resource.requested.semanticResourceDigest
    )
  }
  return requested ?? maximum
}

export const atomicWrite = (target, data, options) => {
  const flag = options?.flag ?? 'w'
  if (flag === 'a' || flag === 'ax') {
    nodeFs.appendFileSync(target, data, { encoding: options?.encoding ?? 'utf8', flag })
    return
  }
  const temporary = nodePath.join(
    nodePath.dirname(target),
    `.holonomy-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  try {
    nodeFs.writeFileSync(temporary, data, { encoding: options?.encoding ?? 'utf8', flag: 'wx' })
    if (flag === 'wx') nodeFs.linkSync(temporary, target)
    else nodeFs.renameSync(temporary, target)
  } finally {
    try {
      nodeFs.unlinkSync(temporary)
    } catch {
      // Cleanup is best-effort and must not replace the authoritative write/rename failure.
    }
  }
}
