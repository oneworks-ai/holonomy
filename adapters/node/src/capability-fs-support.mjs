import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import process from 'node:process'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { CapabilityInvocationError } from '../../../dist/capability-runtime/index.js'

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

export const flagRights = flag =>
  flag.includes('+')
    ? ['read', 'write']
    : flag.startsWith('r')
    ? ['read']
    : ['write']

export const rightFor = (context, resource) => {
  const operation = context.operation
  if (operation === 'filesystem.file.read' || operation.startsWith('filesystem.metadata.')) return 'read'
  if (operation === 'filesystem.file.write') return 'write'
  if (operation === 'filesystem.directory.read') return 'list'
  if (operation === 'filesystem.directory.create') return 'create'
  if (operation === 'filesystem.entry.rename') return 'move'
  if (operation === 'filesystem.entry.unlink') return 'delete'
  if (operation === 'filesystem.watch.subscribe' || operation === 'filesystem.watch.close') return 'watch'
  if (operation === 'filesystem.file.open') return flagRights(context.arguments.flag)
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

export const statSnapshot = value => ({
  birthtimeMs: Math.max(0, value.birthtimeMs),
  ctimeMs: Math.max(0, value.ctimeMs),
  kind: value.isDirectory() ? 'directory' : value.isSymbolicLink() ? 'symlink' : 'file',
  mtimeMs: Math.max(0, value.mtimeMs),
  size: value.size
})

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
