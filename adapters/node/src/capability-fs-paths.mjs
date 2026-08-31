import nodeFs from 'node:fs'
import nodePath from 'node:path'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import {
  CapabilityInvocationError,
  canonicalDigest,
  canonicalizeFilesystemResource
} from '../../../dist/capability-runtime/index.js'

const inside = (root, target) => target === root || target.startsWith(`${root}${nodePath.sep}`)
const kind = value => value.isDirectory() ? 'directory' : value.isSymbolicLink() ? 'symlink' : 'file'
const identity = value =>
  canonicalDigest([
    'filesystemIdentity',
    String(value.dev),
    String(value.ino),
    String(value.mode),
    String(value.size),
    String(value.mtimeNs),
    String(value.ctimeNs)
  ])

export class NodeFilesystemPathsV1 {
  #roots

  constructor(roots) {
    this.#roots = new Map(roots.map(root => {
      const real = nodeFs.realpathSync(root.hostPath)
      if (!nodeFs.statSync(real).isDirectory()) throw new TypeError('Filesystem root must be a directory')
      return [root.rootId, real]
    }))
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
    return `holo-fs://${rootId}/${segments.join('/')}`
  }

  #resolutionSnapshot(resource, operation, symlinks) {
    const root = this.#roots.get(resource.rootId)
    if (root == null) {
      throw new CapabilityInvocationError('resource.not_found', operation, resource.semanticResourceDigest)
    }
    const lexical = nodePath.resolve(root, ...resource.pathSegments)
    if (!inside(root, lexical)) {
      throw new CapabilityInvocationError('resource.cross_root', operation, resource.semanticResourceDigest)
    }
    const followFinal = operation !== 'filesystem.metadata.lstat'
    const requestedChain = this.#identityChain(root, resource.pathSegments, symlinks, operation, resource)
    const target = this.#resolvedTarget(root, lexical, followFinal, operation, resource)
    if (!inside(root, target)) {
      throw new CapabilityInvocationError('resource.cross_root', operation, resource.semanticResourceDigest)
    }
    const pathSegments = nodePath.relative(root, target).split(nodePath.sep).filter(Boolean)
    const resolved = canonicalizeFilesystemResource(
      `holo-fs://${resource.rootId}/${pathSegments.join('/')}`,
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
