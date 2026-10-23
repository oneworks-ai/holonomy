/* eslint-disable max-lines -- One Node filesystem path owner keeps resolution and pinned fd walking together. */
import { Buffer } from 'node:buffer'
import nodeFs from 'node:fs'
import nodePath from 'node:path'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import {
  CapabilityInvocationError,
  canonicalDigest,
  canonicalizeFilesystemResource
} from '../../../dist/capability-runtime/index.js'
import { accessAt, accessDirectory, duplicateDirectoryFd, openAt } from './capability-fs-openat.mjs'

const inside = (root, target) => target === root || target.startsWith(`${root}${nodePath.sep}`)
const kind = value => value.isDirectory() ? 'directory' : value.isSymbolicLink() ? 'symlink' : 'file'
const nativeSegments = (resource, operation) => {
  if (!Array.isArray(resource.pathSegments)) throw new CapabilityInvocationError('resource.invalid', operation)
  return resource.pathSegments.map(part => {
    if (typeof part !== 'string' || part.length === 0 || part.length > 765) {
      throw new CapabilityInvocationError('resource.invalid', operation)
    }
    let name
    try {
      name = decodeURIComponent(part)
    } catch {
      throw new CapabilityInvocationError('resource.invalid', operation)
    }
    if (
      Buffer.byteLength(name, 'utf8') > 255 || name === '.' || name === '..' ||
      /[/\\\0]/u.test(name) || encodeURIComponent(name) !== part
    ) throw new CapabilityInvocationError('resource.invalid', operation)
    return name
  })
}
export const nodeFilesystemIdentityV1 = value =>
  canonicalDigest([
    'filesystemIdentity',
    String(value.dev),
    String(value.ino),
    String(value.mode),
    String(value.size),
    String(value.mtimeNs),
    String(value.ctimeNs)
  ])
const identity = nodeFilesystemIdentityV1

export class NodeFilesystemPathsV1 {
  #roots
  #rootFds = new Map()
  #closed = false

  constructor(roots) {
    this.#roots = new Map()
    try {
      if (
        !['O_RDONLY', 'O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK']
          .every(name => Number.isInteger(nodeFs.constants[name]))
      ) throw new TypeError('Filesystem directory flags are unavailable')
      const flags = nodeFs.constants.O_RDONLY | nodeFs.constants.O_DIRECTORY |
        nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK
      for (const root of roots) {
        if (this.#roots.has(root.rootId)) throw new TypeError('Duplicate filesystem root')
        const real = nodeFs.realpathSync(root.hostPath)
        const expected = nodeFs.statSync(real, { bigint: true })
        if (!expected.isDirectory()) throw new TypeError('Filesystem root must be a directory')
        const fd = nodeFs.openSync(real, flags)
        try {
          const opened = nodeFs.fstatSync(fd, { bigint: true })
          if (!opened.isDirectory() || identity(opened) !== identity(expected)) {
            throw new TypeError('Filesystem root changed during installation')
          }
        } catch (error) {
          nodeFs.closeSync(fd)
          throw error
        }
        this.#roots.set(root.rootId, real)
        this.#rootFds.set(root.rootId, fd)
      }
    } catch (error) {
      this.close()
      throw error
    }
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    let failure
    for (const fd of this.#rootFds.values()) {
      try {
        nodeFs.closeSync(fd)
      } catch (error) {
        failure ??= error
      }
    }
    this.#rootFds.clear()
    if (failure != null) throw failure
  }

  openPinned(resource, evidence, flags, allowDirectory = false) {
    if (this.#closed) throw new CapabilityInvocationError('resource.stale', 'filesystem.file.open')
    const rootFd = this.#rootFds.get(resource.rootId)
    const parts = nativeSegments(resource, 'filesystem.file.open')
    if (rootFd == null || parts.length === 0) {
      throw new CapabilityInvocationError('resource.invalid', 'filesystem.file.open')
    }
    const constants = nodeFs.constants
    const directories = []
    let parentFd = rootFd
    let leafFd
    let operationFailure
    try {
      for (const part of parts.slice(0, -1)) {
        try {
          parentFd = openAt(parentFd, part, constants.O_RDONLY | constants.O_DIRECTORY)
        } catch (error) {
          if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR') {
            throw new CapabilityInvocationError('resource.cross_root', 'filesystem.file.open')
          }
          throw error
        }
        directories.push(parentFd)
      }
      const leaf = parts.at(-1)
      if (evidence.targetType === 'missing') {
        if (!(flags & constants.O_CREAT)) {
          throw new CapabilityInvocationError('resource.not_found', 'filesystem.file.open')
        }
        const parent = nodeFs.fstatSync(parentFd, { bigint: true })
        const digest = canonicalDigest(['filesystemMissingTarget', identity(parent), leaf])
        if (digest !== evidence.targetIdentityDigest) {
          throw new CapabilityInvocationError('resource.stale', 'filesystem.file.open')
        }
        leafFd = openAt(parentFd, leaf, flags & ~constants.O_TRUNC | constants.O_CREAT | constants.O_EXCL)
      } else if (evidence.targetType === 'file' || allowDirectory && evidence.targetType === 'directory') {
        if (flags & constants.O_CREAT && flags & constants.O_EXCL) {
          throw new CapabilityInvocationError('resource.exists', 'filesystem.file.open')
        }
        leafFd = openAt(
          parentFd,
          leaf,
          (flags & ~(constants.O_CREAT | constants.O_EXCL | constants.O_TRUNC)) |
            (evidence.targetType === 'directory' ? constants.O_DIRECTORY : 0)
        )
      } else {
        throw new CapabilityInvocationError('provider.unavailable', 'filesystem.file.open')
      }
    } catch (error) {
      operationFailure = error
    }
    let closeFailure
    for (const fd of directories.reverse()) {
      try {
        nodeFs.closeSync(fd)
      } catch (error) {
        closeFailure ??= error
      }
    }
    if (operationFailure != null || closeFailure != null) {
      if (leafFd != null) {
        try {
          nodeFs.closeSync(leafFd)
        } catch { /* Already failing closed on owned fd cleanup. */ }
      }
      throw operationFailure ?? closeFailure
    }
    return leafFd
  }

  withPinnedExisting(resource, evidence, flags, run) {
    if (this.#closed) throw new CapabilityInvocationError('resource.stale', 'filesystem.resolve')
    if (evidence?.targetType !== 'file' && evidence?.targetType !== 'directory') {
      throw new CapabilityInvocationError('resource.not_found', 'filesystem.resolve')
    }
    if (resource.pathSegments.length === 0) {
      if (evidence.targetType !== 'directory') {
        throw new CapabilityInvocationError('resource.stale', 'filesystem.resolve')
      }
      const rootFd = this.#rootFds.get(resource.rootId)
      if (
        rootFd == null || nodeFilesystemIdentityV1(nodeFs.fstatSync(rootFd, { bigint: true })) !==
          evidence.targetIdentityDigest
      ) {
        throw new CapabilityInvocationError('resource.stale', 'filesystem.resolve')
      }
      return run(rootFd)
    }
    const fd = this.openPinned(resource, evidence, flags, true)
    try {
      const actual = nodeFs.fstatSync(fd, { bigint: true })
      if (
        nodeFilesystemIdentityV1(actual) !== evidence.targetIdentityDigest ||
        evidence.targetType === 'file' && !actual.isFile() ||
        evidence.targetType === 'directory' && !actual.isDirectory()
      ) {
        throw new CapabilityInvocationError('resource.stale', 'filesystem.resolve')
      }
      return run(fd)
    } finally {
      nodeFs.closeSync(fd)
    }
  }

  openPinnedDirectory(resource, evidence) {
    if (evidence?.targetType !== 'directory') {
      throw new CapabilityInvocationError('provider.unavailable', 'filesystem.directory.open')
    }
    let fd
    if (resource.pathSegments.length === 0) {
      const rootFd = this.#rootFds.get(resource.rootId)
      if (rootFd == null) throw new CapabilityInvocationError('resource.invalid', 'filesystem.directory.open')
      fd = duplicateDirectoryFd(rootFd)
    } else {
      fd = this.openPinned(resource, evidence, nodeFs.constants.O_RDONLY | nodeFs.constants.O_DIRECTORY, true)
    }
    try {
      const info = nodeFs.fstatSync(fd, { bigint: true })
      if (!info.isDirectory() || nodeFilesystemIdentityV1(info) !== evidence.targetIdentityDigest) {
        throw new CapabilityInvocationError('resource.stale', 'filesystem.directory.open')
      }
      return fd
    } catch (error) {
      nodeFs.closeSync(fd)
      throw error
    }
  }

  accessPinned(resource, evidence, mode) {
    if (this.#closed) throw new CapabilityInvocationError('resource.stale', 'filesystem.metadata.access')
    const rootFd = this.#rootFds.get(resource.rootId)
    const parts = nativeSegments(resource, 'filesystem.metadata.access')
    if (rootFd == null || evidence?.rootId !== resource.rootId) {
      throw new CapabilityInvocationError('resource.invalid', 'filesystem.metadata.access')
    }
    if (parts.length === 0) {
      if (
        evidence.targetType !== 'directory' ||
        nodeFilesystemIdentityV1(nodeFs.fstatSync(rootFd, { bigint: true })) !== evidence.targetIdentityDigest
      ) {
        throw new CapabilityInvocationError('resource.stale', 'filesystem.metadata.access')
      }
      accessDirectory(rootFd, mode)
      return
    }
    const directories = []
    let parentFd = rootFd
    try {
      for (const part of parts.slice(0, -1)) {
        parentFd = openAt(parentFd, part, nodeFs.constants.O_RDONLY | nodeFs.constants.O_DIRECTORY)
        directories.push(parentFd)
      }
      const value = accessAt(parentFd, parts.at(-1), mode)
      const current = {
        dev: value.dev,
        ino: value.ino,
        mode: value.mode,
        size: value.size,
        mtimeNs: BigInt(value.mtimeSec) * 1_000_000_000n + BigInt(value.mtimeNsec),
        ctimeNs: BigInt(value.ctimeSec) * 1_000_000_000n + BigInt(value.ctimeNsec)
      }
      if (nodeFilesystemIdentityV1(current) !== evidence.targetIdentityDigest) {
        throw new CapabilityInvocationError('resource.stale', 'filesystem.metadata.access')
      }
    } finally {
      for (const fd of directories.reverse()) nodeFs.closeSync(fd)
    }
  }

  resourceFromUrl(url, operation, rootId) {
    let resource
    try {
      resource = canonicalizeFilesystemResource(url, 'rename destination')
    } catch {
      throw new CapabilityInvocationError('resource.invalid', operation)
    }
    if (resource.rootId !== rootId) throw new CapabilityInvocationError('resource.cross_root', operation)
    return resource
  }

  resolution(resource, operation, symlinks) {
    const snapshot = this.#resolutionSnapshot(resource, operation, symlinks)
    return Object.freeze({
      evidence: snapshot.evidence,
      reason: 'filesystemTarget',
      resolved: snapshot.resolved,
      sideEffectCount: 0,
      target: snapshot.target,
      verify: () => {
        const current = this.#resolutionSnapshot(resource, operation, symlinks)
        return { evidence: current.evidence, resolved: current.resolved }
      }
    })
  }

  virtualPath(rootId, target) {
    const root = this.#roots.get(rootId)
    if (root == null) {
      throw new CapabilityInvocationError('resource.not_found', 'filesystem.directory.create')
    }
    const segments = nodePath.relative(root, target).split(nodePath.sep).filter(Boolean)
    return `holo-fs://${rootId}/${segments.map(encodeURIComponent).join('/')}`
  }

  #resolutionSnapshot(resource, operation, symlinks) {
    const root = this.#roots.get(resource.rootId)
    if (root == null) {
      throw new CapabilityInvocationError('resource.not_found', operation, resource.semanticResourceDigest)
    }
    const parts = nativeSegments(resource, operation)
    const lexical = nodePath.resolve(root, ...parts)
    if (!inside(root, lexical)) {
      throw new CapabilityInvocationError('resource.cross_root', operation, resource.semanticResourceDigest)
    }
    const followFinal = operation !== 'filesystem.metadata.lstat'
    const requestedChain = this.#identityChain(root, parts, symlinks, operation, resource)
    const target = this.#resolvedTarget(root, lexical, followFinal, operation, resource)
    if (!inside(root, target)) {
      throw new CapabilityInvocationError('resource.cross_root', operation, resource.semanticResourceDigest)
    }
    const pathSegments = nodePath.relative(root, target).split(nodePath.sep).filter(Boolean)
    const resolved = canonicalizeFilesystemResource(
      `holo-fs://${resource.rootId}/${pathSegments.map(encodeURIComponent).join('/')}`,
      resource.display.label
    )
    const targetStat = this.#lstat(target)
    const parentStat = this.#lstat(nodePath.dirname(target))
    const targetIdentityDigest = targetStat == null
      ? canonicalDigest([
        'filesystemMissingTarget',
        parentStat == null ? 'missing' : identity(parentStat),
        nodePath.basename(target)
      ])
      : identity(targetStat)
    return Object.freeze({
      evidence: Object.freeze({
        ancestorIdentityDigests: Object.freeze(requestedChain),
        kind: 'filesystemTarget',
        rootId: resource.rootId,
        targetIdentityDigest,
        targetType: targetStat == null ? 'missing' : kind(targetStat)
      }),
      resolved,
      target
    })
  }

  #identityChain(root, segments, symlinks, operation, resource) {
    const output = []
    let current = root
    const rootStat = this.#lstat(root)
    if (rootStat != null) output.push(identity(rootStat))
    for (const segment of segments) {
      current = nodePath.join(current, segment)
      const value = this.#lstat(current)
      if (value == null) break
      if (value.isSymbolicLink() && symlinks === 'deny') {
        throw new CapabilityInvocationError('resource.cross_root', operation, resource.semanticResourceDigest)
      }
      output.push(identity(value))
    }
    if (output.length > 256) {
      throw new CapabilityInvocationError('resource.invalid', operation, resource.semanticResourceDigest)
    }
    return output
  }

  #resolvedTarget(root, lexical, followFinal, operation, resource) {
    let existing = lexical
    const missing = []
    while (this.#lstat(existing) == null && existing !== root) {
      missing.unshift(nodePath.basename(existing))
      existing = nodePath.dirname(existing)
    }
    try {
      const base = followFinal || missing.length > 0
        ? nodeFs.realpathSync(existing)
        : nodePath.join(nodeFs.realpathSync(nodePath.dirname(existing)), nodePath.basename(existing))
      return nodePath.resolve(base, ...missing)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new CapabilityInvocationError('resource.not_found', operation, resource.semanticResourceDigest)
      }
      throw error
    }
  }

  #lstat(target) {
    try {
      return nodeFs.lstatSync(target, { bigint: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }
}
