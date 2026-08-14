// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { CapabilityInvocationError } from '../../../dist/capability-runtime/index.js'

import { NodeFilesystemPathOperationsV1 } from './capability-fs-path-operations.mjs'
import { NodeFilesystemPathsV1 } from './capability-fs-paths.mjs'
import { NodeFilesystemResourcesV1 } from './capability-fs-resources.mjs'
import { mapProviderError, rightFor, selectedFilesystemRoot } from './capability-fs-support.mjs'

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

  invoke(context, authority) {
    const resource = context.resource.requested
    if (resource.kind !== 'filesystem') {
      throw new CapabilityInvocationError('resource.invalid', context.operation)
    }
    const required = rightFor(context, resource)
    const rights = Array.isArray(required) ? required : [required]
    if (!rights.every(right => selectedFilesystemRoot(authority, resource, right))) {
      throw new CapabilityInvocationError(
        'capability.denied',
        context.operation,
        resource.semanticResourceDigest
      )
    }
    try {
      if (context.resource.inheritedBindingId != null) {
        return this.#resources.invoke(context, authority, resource, context.resource.inheritedBindingId)
      }
      return this.#operations.invoke(context, authority, resource)
    } catch (error) {
      return mapProviderError(error, context.operation, resource.semanticResourceDigest)
    }
  }
}
