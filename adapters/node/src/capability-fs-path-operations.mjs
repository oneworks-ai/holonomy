/* eslint-disable max-lines -- One pinned path operation owner covers all filesystem metadata mutations. */
import nodeFs from 'node:fs'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { CapabilityInvocationError, trustedInvocationValueFromJsonV1 } from '../../../dist/capability-runtime/index.js'

import { futimens } from './capability-fs-openat.mjs'

import {
  assertReadLimit,
  assertWriteLimit,
  atomicWrite,
  chmodExpectedKind,
  chmodMode,
  inputData,
  output,
  selectedFilesystemRoot,
  selectedFilesystemRootConstraint,
  statSnapshot
} from './capability-fs-support.mjs'

export class NodeFilesystemPathOperationsV1 {
  #paths
  #resources

  constructor(paths, resources) {
    this.#paths = paths
    this.#resources = resources
  }

  invoke(context, authority, resource, targets) {
    const target = targets.target
    if (context.operation === 'filesystem.directory.open') {
      return this.#resources.openDirectory(
        context,
        authority,
        resource,
        targets.targetEvidence,
        () => this.#paths.openPinnedDirectory(resource, targets.targetEvidence)
      )
    }
    if (context.operation === 'filesystem.metadata.utimes') {
      const flags = targets.targetEvidence.targetType === 'file'
        ? nodeFs.constants.O_WRONLY
        : nodeFs.constants.O_RDONLY
      return this.#paths.withPinnedExisting(resource, targets.targetEvidence, flags, fd => {
        futimens(fd, context.arguments.atime, context.arguments.mtime)
        return authority.complete(trustedInvocationValueFromJsonV1(
          context.arguments.readback === true ? statSnapshot(nodeFs.fstatSync(fd, { bigint: true })) : {},
          'result'
        ))
      })
    }
    if (context.operation === 'filesystem.metadata.chmod') {
      const mode = chmodMode(context.arguments.mode, context.operation)
      const expectedKind = chmodExpectedKind(context)
      if (expectedKind != null && targets.targetEvidence.targetType !== expectedKind) {
        throw new CapabilityInvocationError('resource.invalid', context.operation)
      }
      return this.#paths.withPinnedExisting(resource, targets.targetEvidence, nodeFs.constants.O_RDONLY, fd => {
        const pinned = nodeFs.fstatSync(fd, { bigint: true })
        if (expectedKind != null && !(expectedKind === 'file' ? pinned.isFile() : pinned.isDirectory())) {
          throw new CapabilityInvocationError('resource.invalid', context.operation)
        }
        nodeFs.fchmodSync(fd, mode)
        return authority.complete(trustedInvocationValueFromJsonV1(
          context.arguments.readback === true ? statSnapshot(nodeFs.fstatSync(fd, { bigint: true })) : {},
          'result'
        ))
      })
    }
    if (context.operation === 'filesystem.file.truncate') {
      const len = context.arguments.len
      const maximum = context.authorityBindings[0]?.constraints?.limits?.maxWriteBytes
      if (!Number.isSafeInteger(len) || len < 0 || !Number.isSafeInteger(maximum) || len > maximum) {
        throw new CapabilityInvocationError('resource.byte_limit', context.operation)
      }
      if (targets.targetEvidence.targetType !== 'file') {
        throw new CapabilityInvocationError('provider.unavailable', context.operation)
      }
      return this.#paths.withPinnedExisting(resource, targets.targetEvidence, nodeFs.constants.O_WRONLY, fd => {
        nodeFs.ftruncateSync(fd, len)
        return authority.complete(trustedInvocationValueFromJsonV1(
          context.arguments.readback === true ? statSnapshot(nodeFs.fstatSync(fd, { bigint: true })) : {},
          'result'
        ))
      })
    }
    if (context.operation === 'filesystem.metadata.access') {
      const mode = context.arguments.mode
      const directory = targets.targetEvidence.targetType === 'directory'
      const exactRights = [
        ...(mode === 0 ? ['read'] : []),
        ...(mode & 4 ? [directory ? 'list' : 'read'] : []),
        ...(mode & 2 ? ['write'] : []),
        ...(mode & 1 ? ['list'] : [])
      ]
      if (selectedFilesystemRootConstraint(authority, resource, exactRights) == null) {
        throw new CapabilityInvocationError('capability.denied', context.operation)
      }
      if (targets.targetEvidence.targetType === 'file' && (mode & 1)) {
        throw new CapabilityInvocationError('capability.denied', context.operation)
      }
      if (targets.targetEvidence.targetType === 'directory' || mode === 0) {
        this.#paths.accessPinned(resource, targets.targetEvidence, mode)
        return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
      }
      const flags = targets.targetEvidence.targetType === 'file' && (mode & 2)
        ? mode & 4 ? nodeFs.constants.O_RDWR : nodeFs.constants.O_WRONLY
        : nodeFs.constants.O_RDONLY
      return this.#paths.withPinnedExisting(resource, targets.targetEvidence, flags, fd => {
        return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
      })
    }
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
      return this.#resources.open(
        context,
        authority,
        resource,
        targets.targetEvidence,
        flags => this.#paths.openPinned(resource, targets.targetEvidence, flags)
      )
    }
    if (context.operation === 'filesystem.metadata.stat') {
      return authority.complete(trustedInvocationValueFromJsonV1(
        statSnapshot(nodeFs.statSync(target, { bigint: true })),
        'result'
      ))
    }
    if (context.operation === 'filesystem.metadata.lstat') {
      return authority.complete(trustedInvocationValueFromJsonV1(
        statSnapshot(nodeFs.lstatSync(target, { bigint: true })),
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
      if (
        targets.destination == null || targets.destinationResource == null ||
        !selectedFilesystemRoot(targets.destinationAuthority, targets.destinationResource, 'move')
      ) {
        throw new CapabilityInvocationError(
          'capability.denied',
          context.operation,
          resource.semanticResourceDigest
        )
      }
      nodeFs.renameSync(target, targets.destination)
      return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
    }
    if (context.operation === 'filesystem.entry.unlink') {
      if (context.providerData?.kind === 'directoryRemove') nodeFs.rmdirSync(target)
      else nodeFs.unlinkSync(target)
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
