// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { CapabilityInvocationError } from '../../../dist/capability-runtime/index.js'

import { NodeFilesystemPathOperationsV1 } from './capability-fs-path-operations.mjs'
import { NodeFilesystemPathsV1 } from './capability-fs-paths.mjs'
import { NodeFilesystemResourcesV1 } from './capability-fs-resources.mjs'
import {
  filesystemSymlinkMode,
  mapProviderError,
  rightFor,
  selectedFilesystemRoot,
  selectedFilesystemRootConstraint
} from './capability-fs-support.mjs'

export class NodeFilesystemProviderV1 {
  execution = 'sync'
  module = 'host.fs'
  #operations
  #paths
  #resources

  constructor(roots) {
    this.#paths = new NodeFilesystemPathsV1(roots)
    this.#resources = new NodeFilesystemResourcesV1()
    this.#operations = new NodeFilesystemPathOperationsV1(this.#paths, this.#resources)
  }

  close() {
    this.#paths.close()
  }

  #assertSource(context) {
    const linux = context.source?.kind === 'linuxProcess'
    if (
      context.operation !== 'filesystem.metadata.chmod' &&
      context.arguments != null && typeof context.arguments === 'object' &&
      Object.hasOwn(context.arguments, 'expectedKind')
    ) throw new CapabilityInvocationError('argument.invalid', context.operation)
    if (
      ['filesystem.directory.open', 'filesystem.directory.sync', 'filesystem.directory.close'].includes(
          context.operation
        ) && !linux ||
      (context.operation === 'filesystem.metadata.utimes' ||
          context.operation === 'filesystem.metadata.chmod' ||
          context.operation === 'filesystem.file.truncate') &&
        context.arguments?.readback === true && !linux ||
      context.operation === 'filesystem.metadata.utimes' &&
        [context.arguments?.atime?.kind, context.arguments?.mtime?.kind].some(kind => kind !== 'set') && !linux
    ) {
      throw new CapabilityInvocationError('capability.denied', context.operation)
    }
  }

  invoke(context, authority) {
    this.#assertSource(context)
    const resource = context.resource.requested
    if (resource.kind !== 'filesystem') {
      throw new CapabilityInvocationError('resource.invalid', context.operation)
    }
    if (context.resource.inheritedBindingId == null) {
      throw new CapabilityInvocationError('provider.protocol_error', context.operation)
    }
    const required = rightFor(context, resource, authority)
    const rights = Array.isArray(required) ? required : [required]
    if (
      selectedFilesystemRootConstraint(authority, resource, rights) == null ||
      !rights.every(right => selectedFilesystemRoot(authority, resource, right))
    ) {
      throw new CapabilityInvocationError(
        'capability.denied',
        context.operation,
        resource.semanticResourceDigest
      )
    }
    try {
      return this.#resources.invoke(context, authority, resource, context.resource.inheritedBindingId)
    } catch (error) {
      return mapProviderError(error, context.operation, resource.semanticResourceDigest)
    }
  }

  preflight(context, authority) {
    this.#assertSource(context)
    const resource = context.resource.requested
    if (context.resource.inheritedBindingId != null) return undefined
    if (resource.kind !== 'filesystem') {
      throw new CapabilityInvocationError('resource.invalid', context.operation)
    }
    const required = rightFor(context, resource, authority)
    const rights = Array.isArray(required) ? required : [required]
    if (
      selectedFilesystemRootConstraint(authority, resource, rights) == null ||
      !rights.every(right => selectedFilesystemRoot(authority, resource, right))
    ) {
      throw new CapabilityInvocationError('capability.denied', context.operation, resource.semanticResourceDigest)
    }
    try {
      const symlinks = filesystemSymlinkMode(authority, resource)
      const source = this.#paths.resolution(resource, context.operation, symlinks)
      const destinationResource = context.operation === 'filesystem.entry.rename'
        ? this.#paths.resourceFromUrl(context.arguments.to, context.operation, resource.rootId)
        : undefined
      const destination = destinationResource == null
        ? undefined
        : this.#paths.resolution(destinationResource, context.operation, symlinks)
      return Object.freeze({
        execute: (resolvedContext, authorities) => {
          try {
            return this.#operations.invoke(
              resolvedContext,
              authorities[0],
              source.resolved,
              {
                ...(destination == null
                  ? {}
                  : {
                    destination: destination.target,
                    destinationAuthority: authorities[1],
                    destinationResource: destination.resolved
                  }),
                target: source.target,
                targetEvidence: source.evidence
              }
            )
          } catch (error) {
            return mapProviderError(error, resolvedContext.operation, source.resolved.semanticResourceDigest)
          }
        },
        requests: Object.freeze([
          source,
          ...(destination == null ? [] : [destination])
        ])
      })
    } catch (error) {
      return mapProviderError(error, context.operation, resource.semanticResourceDigest)
    }
  }
}
