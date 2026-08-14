import nodeFs from 'node:fs'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { CapabilityInvocationError, trustedInvocationValueFromJsonV1 } from '../../../dist/capability-runtime/index.js'

import {
  assertReadLimit,
  assertWriteLimit,
  atomicWrite,
  inputData,
  output,
  selectedFilesystemRoot,
  statSnapshot
} from './capability-fs-support.mjs'

export class NodeFilesystemPathOperationsV1 {
  #paths
  #resources

  constructor(paths, resources) {
    this.#paths = paths
    this.#resources = resources
  }

  invoke(context, authority, resource) {
    const target = this.#paths.target(resource, context.operation)
    if (context.operation === 'filesystem.file.read') {
      const bytes = nodeFs.readFileSync(target)
      assertReadLimit(context, bytes.byteLength)
      return authority.complete(trustedInvocationValueFromJsonV1(
        output(bytes, context.arguments.options?.encoding ?? null),
        'result'
      ))
    }
    if (context.operation === 'filesystem.file.write') {
      const data = inputData(context.arguments.data)
      assertWriteLimit(context, data)
      atomicWrite(target, data, context.arguments.options)
      return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
    }
    if (context.operation === 'filesystem.file.open') {
      return this.#resources.open(context, authority, resource, target)
    }
    if (context.operation === 'filesystem.metadata.stat') {
      return authority.complete(trustedInvocationValueFromJsonV1(
        statSnapshot(nodeFs.statSync(target)),
        'result'
      ))
    }
    if (context.operation === 'filesystem.metadata.lstat') {
      return authority.complete(trustedInvocationValueFromJsonV1(
        statSnapshot(nodeFs.lstatSync(target)),
        'result'
      ))
    }
    if (context.operation === 'filesystem.directory.read') {
      return this.#readDirectory(context, authority, resource, target)
    }
    if (context.operation === 'filesystem.directory.create') {
      const created = nodeFs.mkdirSync(target, {
        recursive: context.arguments.options?.recursive === true
      })
      const result = context.arguments.options?.recursive === true
        ? created == null
          ? { kind: 'undefined' }
          : { kind: 'path', value: this.#paths.virtualPath(resource.rootId, created) }
        : {}
      return authority.complete(trustedInvocationValueFromJsonV1(result, 'result'))
    }
    if (context.operation === 'filesystem.entry.rename') {
      const destination = this.#paths.targetFromUrl(context.arguments.to, context.operation, resource.rootId)
      const destinationSegments = context.arguments.to
        .slice(`holo-fs://${resource.rootId}/`.length)
        .split('/')
      if (!selectedFilesystemRoot(authority, { ...resource, pathSegments: destinationSegments }, 'move')) {
        throw new CapabilityInvocationError(
          'capability.denied',
          context.operation,
          resource.semanticResourceDigest
        )
      }
      nodeFs.renameSync(target, destination)
      return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
    }
    if (context.operation === 'filesystem.entry.unlink') {
      nodeFs.unlinkSync(target)
      return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
    }
    if (context.operation === 'filesystem.watch.subscribe') {
      return this.#resources.watch(context, authority, resource, target)
    }
    throw new CapabilityInvocationError(
      'provider.unavailable',
      context.operation,
      resource.semanticResourceDigest
    )
  }

  #readDirectory(context, authority, resource, target) {
    const entries = nodeFs.readdirSync(target, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    const maximum = context.authorityBindings[0]?.constraints?.limits?.maxDirectoryEntries
    if (typeof maximum !== 'number' || entries.length > maximum) {
      throw new CapabilityInvocationError(
        'provider.quota',
        context.operation,
        resource.semanticResourceDigest
      )
    }
    const value = context.arguments.options?.withFileTypes === true
      ? entries.map(entry => ({
        kind: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
        name: entry.name
      }))
      : entries.map(entry => entry.name)
    return authority.complete(trustedInvocationValueFromJsonV1(value, 'result'))
  }
}
