import nodeFs from 'node:fs'
import nodePath from 'node:path'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { CapabilityInvocationError } from '../../../dist/capability-runtime/index.js'

export class NodeFilesystemPathsV1 {
  #roots

  constructor(roots) {
    this.#roots = new Map(roots.map(root => {
      const real = nodeFs.realpathSync(root.hostPath)
      if (!nodeFs.statSync(real).isDirectory()) throw new TypeError('Filesystem root must be a directory')
      return [root.rootId, real]
    }))
  }

  target(resource, operation) {
    const root = this.#roots.get(resource.rootId)
    if (root == null) {
      throw new CapabilityInvocationError('resource.not_found', operation, resource.semanticResourceDigest)
    }
    return this.#targetFromSegments(root, resource.pathSegments, operation, resource.semanticResourceDigest)
  }

  targetFromUrl(url, operation, rootId) {
    if (typeof url !== 'string' || !url.startsWith(`holo-fs://${rootId}/`)) {
      throw new CapabilityInvocationError('resource.cross_root', operation)
    }
    const root = this.#roots.get(rootId)
    if (root == null) throw new CapabilityInvocationError('resource.not_found', operation)
    return this.#targetFromSegments(root, url.slice(`holo-fs://${rootId}/`.length).split('/'), operation)
  }

  virtualPath(rootId, target) {
    const root = this.#roots.get(rootId)
    if (root == null) {
      throw new CapabilityInvocationError('resource.not_found', 'filesystem.directory.create')
    }
    const segments = nodePath.relative(root, target).split(nodePath.sep).filter(Boolean)
    return `holo-fs://${rootId}/${segments.join('/')}`
  }

  #targetFromSegments(root, segments, operation, digest) {
    const target = nodePath.resolve(root, ...segments)
    if (target !== root && !target.startsWith(`${root}${nodePath.sep}`)) {
      throw new CapabilityInvocationError('resource.cross_root', operation, digest)
    }
    let current = root
    for (const segment of segments) {
      current = nodePath.join(current, segment)
      try {
        if (nodeFs.lstatSync(current).isSymbolicLink()) {
          throw new CapabilityInvocationError('resource.cross_root', operation, digest)
        }
      } catch (error) {
        if (error?.code === 'ENOENT') break
        throw error
      }
    }
    return target
  }
}
