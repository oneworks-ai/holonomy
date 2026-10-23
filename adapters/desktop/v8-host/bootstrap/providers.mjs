/* eslint-disable max-lines -- Native filesystem authorization stays beside its Provider invocation. */
import {
  CapabilityInvocationError,
  canonicalizeFilesystemResource,
  trustedInvocationValueFromJsonV1
} from '../../../../packages/runtime/src/kernel/index.ts'

import { prepareNativeRename } from './filesystem-rename.mjs'
import { createNativeWatchResources } from './filesystem-watch.mjs'

export const createNativeProviders = (native, projection) => {
  const watches = createNativeWatchResources(native)
  const system = {
    execution: 'sync',
    module: 'host.system',
    invoke(call, authority) {
      const resource = call.resource.requested
      const field = projection.fields[resource.field]
      const ranks = { redacted: 0, coarse: 1, exact: 2 }
      if (
        resource.kind !== 'systemField' || field == null || field.mode === 'unavailable' ||
        !authority.bindings.some(binding =>
          binding.providerModule === 'host.system' &&
          binding.constraints.fields.includes(resource.field) && binding.constraints.modes.includes(field.mode) &&
          ranks[field.precision] <= ranks[binding.constraints.maxPrecision]
        )
      ) {
        throw new CapabilityInvocationError('capability.denied', call.operation)
      }
      return authority.complete(trustedInvocationValueFromJsonV1(field.value, 'result'))
    }
  }
  const rightFor = operation =>
    ({
      'filesystem.file.read': 'read',
      'filesystem.file.write': 'write',
      'filesystem.directory.read': 'list',
      'filesystem.directory.create': 'create',
      'filesystem.entry.rename': 'move',
      'filesystem.entry.unlink': 'delete',
      'filesystem.watch.subscribe': 'watch',
      'filesystem.watch.close': 'watch',
      'filesystem.metadata.stat': 'read',
      'filesystem.metadata.lstat': 'read',
      'filesystem.metadata.chmod': 'chmod',
      'filesystem.metadata.utimes': 'write',
      'filesystem.file.truncate': 'write',
      'filesystem.directory.open': 'list'
    })[operation]
  const linuxOnlyShape = call => {
    const args = call.arguments ?? {}
    const extendedTime = call.operation === 'filesystem.metadata.utimes' &&
      [args.atime?.kind, args.mtime?.kind].some(kind => kind === 'now' || kind === 'omit')
    if (Object.hasOwn(args, 'expectedKind')) {
      if (call.operation !== 'filesystem.metadata.chmod') {
        throw new CapabilityInvocationError('argument.invalid', call.operation)
      }
      if (call.source?.kind !== 'linuxProcess' || args.readback !== true) {
        throw new CapabilityInvocationError('capability.denied', call.operation)
      }
      if (!['file', 'directory'].includes(args.expectedKind)) {
        throw new CapabilityInvocationError('argument.invalid', call.operation)
      }
    }
    if (
      call.source?.kind !== 'linuxProcess' &&
      (
        ['filesystem.directory.open', 'filesystem.directory.sync', 'filesystem.directory.close'].includes(
          call.operation
        ) ||
        args.readback === true || extendedTime
      )
    ) throw new CapabilityInvocationError('capability.denied', call.operation)
  }
  const filesystemCandidates = (
    call,
    authority,
    resource = call.resource.resolved ?? call.resource.requested,
    targetType
  ) => {
    linuxOnlyShape(call)
    const right = rightFor(call.operation)
    const flag = call.operation === 'filesystem.file.open' ? call.arguments.flag : undefined
    const openRights = () => {
      if (typeof flag === 'string') {
        return flag.includes('+') ? ['read', 'write'] : [flag.startsWith('r') ? 'read' : 'write']
      }
      if (
        flag == null || typeof flag !== 'object' || call.source?.kind !== 'linuxProcess' ||
        Object.keys(flag).length !== 6 ||
        Object.keys(flag).some(key => !['kind', 'access', 'create', 'exclusive', 'truncate', 'append'].includes(key)) ||
        flag.kind !== 'portable-open-v1' || !['read', 'write', 'readWrite'].includes(flag.access) ||
        !['create', 'exclusive', 'truncate', 'append'].every(key => typeof flag[key] === 'boolean') ||
        flag.exclusive && !flag.create ||
        flag.access === 'read' && (flag.truncate || flag.append)
      ) throw new CapabilityInvocationError('capability.denied', call.operation)
      return flag.access === 'read'
        ? flag.create ? ['read', 'write'] : ['read']
        : flag.access === 'write'
        ? ['write']
        : ['read', 'write']
    }
    const accessRights = () => {
      const mode = call.arguments.mode
      if (!Number.isInteger(mode) || mode < 0 || mode > 7) {
        throw new CapabilityInvocationError('argument.invalid', call.operation)
      }
      return [
        ...(mode === 0 ? ['read'] : []),
        ...((mode & 2) !== 0 ? ['write'] : []),
        ...((mode & 1) !== 0 ? ['list'] : [])
      ]
    }
    const required = [
        'filesystem.file.close',
        'filesystem.file.sync',
        'filesystem.file.datasync',
        'filesystem.directory.sync',
        'filesystem.directory.close'
      ].includes(call.operation)
      ? []
      : call.operation === 'filesystem.file.open'
      ? openRights()
      : call.operation === 'filesystem.metadata.access'
      ? accessRights()
      : [right]
    const accessRead = call.operation === 'filesystem.metadata.access' && (call.arguments.mode & 4) !== 0
    const selected = authority.bindings.filter(binding =>
      binding.providerModule === 'host.fs' &&
      binding.constraints.roots.some(root =>
        root.rootId === resource.rootId && required.every(right => root.rights.includes(right)) &&
        (!accessRead || (
          targetType === 'file'
            ? root.rights.includes('read')
            : targetType === 'directory'
            ? root.rights.includes('list')
            : root.rights.includes('read') || root.rights.includes('list')
        )) &&
        (
          call.resource.inheritedBindingId != null ||
          root.pathPrefixSegments.every((segment, index) => resource.pathSegments[index] === segment)
        )
      )
    )
    if (resource.kind !== 'filesystem' || selected.length === 0 || required.includes(undefined)) {
      throw new CapabilityInvocationError(
        required.includes(undefined) ? 'provider.unavailable' : 'capability.denied',
        call.operation
      )
    }
    return selected.map(binding => binding.constraints)
  }
  const selectedFilesystem = (call, authority, resource, targetType) =>
    filesystemCandidates(call, authority, resource, targetType)[0]
  const sendFilesystem = (input, operation, digest) => {
    const result = JSON.parse(native.filesystem(JSON.stringify(input)))
    if (result.ok !== true) throw new CapabilityInvocationError(result.code, operation, digest)
    return result.value
  }
  const nativeFilesystemArguments = call => {
    if (
      call.module !== 'node:fs' ||
      ![
        'filesystem.metadata.utimes',
        'filesystem.metadata.chmod',
        'filesystem.file.truncate',
        'filesystem.file.sync',
        'filesystem.file.datasync'
      ].includes(call.operation) ||
      !Object.hasOwn(call.arguments ?? {}, 'fd')
    ) return call.arguments
    if (!Number.isSafeInteger(call.arguments?.fd) || call.arguments.fd < 0) {
      throw new CapabilityInvocationError('argument.invalid', call.operation)
    }
    if (typeof call.resource.inheritedBindingId !== 'string') {
      throw new CapabilityInvocationError('resource.stale', call.operation)
    }
    if (call.operation === 'filesystem.metadata.utimes') {
      return { atime: call.arguments.atime, mtime: call.arguments.mtime }
    }
    if (call.operation === 'filesystem.metadata.chmod') {
      return {
        mode: call.arguments.mode,
        ...(Object.hasOwn(call.arguments, 'readback') ? { readback: call.arguments.readback } : {}),
        ...(Object.hasOwn(call.arguments, 'expectedKind') ? { expectedKind: call.arguments.expectedKind } : {})
      }
    }
    if (call.operation === 'filesystem.file.truncate') return { len: call.arguments.len }
    return {}
  }
  const completeFilesystemResource = (call, authority, bindingId, resourceType, value) => {
    const close = () => native.filesystem(JSON.stringify({ kind: 'close', bindingId }))
    try {
      return authority.complete(trustedInvocationValueFromJsonV1(value, 'result'), [{
        bindingId,
        resource: call.resource.requested,
        resourceType,
        close
      }])
    } catch (error) {
      try {
        close()
      } catch { /* Preserve the delivery failure. */ }
      throw error
    }
  }
  const invokeFilesystem = (call, authority, resolution) => {
    if (call.signal?.aborted) throw new CapabilityInvocationError('runtime.cancelled', call.operation)
    const resource = call.resource.resolved ?? call.resource.requested
    const request = constraints => ({
      kind: 'invoke',
      operation: call.operation,
      arguments: nativeFilesystemArguments(call),
      rootId: resource.rootId,
      pathSegments: resource.pathSegments,
      requestedSegments: resolution?.requested.pathSegments ?? resource.pathSegments,
      resolutionTicket: resolution?.ticket ?? null,
      linuxProcess: call.source?.kind === 'linuxProcess',
      constraints,
      ...(call.source?.kind === 'linuxProcess' && call.providerData?.kind === 'directoryRemove'
        ? { directoryRemove: true }
        : {}),
      ...(call.source?.kind === 'linuxProcess' &&
          ['positionedRead', 'positionedWrite'].includes(call.providerData?.kind)
        ? { positioned: call.providerData }
        : {}),
      bindingId: call.resource.inheritedBindingId ?? null
    })
    const candidates = call.operation === 'filesystem.metadata.access' && resolution == null
      ? filesystemCandidates(call, authority, resource)
      : [selectedFilesystem(call, authority, resource, resolution?.targetType)]
    let result
    let denied
    for (const constraints of candidates) {
      try {
        result = sendFilesystem(request(constraints), call.operation, resource.semanticResourceDigest)
        break
      } catch (error) {
        if (call.operation !== 'filesystem.metadata.access' || error?.code !== 'capability.denied') throw error
        denied = error
      }
    }
    if (result === undefined) throw denied ?? new CapabilityInvocationError('capability.denied', call.operation)
    if (call.operation === 'filesystem.watch.subscribe') return watches.publish(call, authority, result)
    if (call.operation === 'filesystem.watch.close') watches.close(call.resource.inheritedBindingId)
    if (call.operation === 'filesystem.directory.open') {
      const { bindingId, entries } = result
      return completeFilesystemResource(call, authority, bindingId, 'filesystem.directory-handle', {
        binding: { bindingId, generation: call.runtime.generation },
        resourceType: 'filesystem.directory-handle',
        entries
      })
    }
    if (call.operation === 'filesystem.file.open') {
      const { bindingId, fd } = result
      const value = call.module === 'node:fs/promises'
        ? { binding: { bindingId, generation: call.runtime.generation }, resourceType: 'filesystem.file-handle' }
        : { binding: 'opaque', fd }
      return completeFilesystemResource(call, authority, bindingId, 'filesystem.file-handle', value)
    }
    return authority.complete(trustedInvocationValueFromJsonV1(result, 'result'))
  }
  const filesystem = {
    execution: 'sync',
    module: 'host.fs',
    poll: () => watches.poll(),
    preflight(context, authority) {
      if (context.operation === 'filesystem.entry.rename') return prepareNativeRename(native, context, authority)
      if (
        context.resource.inheritedBindingId != null ||
        ['filesystem.file.close', 'filesystem.directory.close', 'filesystem.watch.close'].includes(context.operation)
      ) return
      const requested = context.resource.requested
      const constraints = selectedFilesystem(context, authority, requested)
      const prepared = sendFilesystem(
        {
          kind: 'prepareResolution',
          operation: context.operation,
          arguments: context.arguments,
          linuxProcess: context.source?.kind === 'linuxProcess',
          rootId: requested.rootId,
          pathSegments: requested.pathSegments,
          constraints
        },
        context.operation,
        requested.semanticResourceDigest
      )
      if (prepared.required !== true) return
      if (context.operation === 'filesystem.metadata.access') {
        selectedFilesystem(context, authority, requested, prepared.evidence.targetType)
      }
      const encoded = prepared.resolvedSegments.map(encodeURIComponent).join('/')
      const resolved = canonicalizeFilesystemResource(
        `holo-fs://${requested.rootId}/${encoded}`,
        'native resolved filesystem target'
      )
      return {
        requests: [{
          evidence: prepared.evidence,
          reason: 'filesystemTarget',
          resolved,
          sideEffectCount: 0,
          verify: () => {
            const value = sendFilesystem(
              {
                kind: 'verifyResolution',
                rootId: requested.rootId,
                ticket: prepared.ticket
              },
              context.operation,
              resolved.semanticResourceDigest
            )
            const verifiedUrl = `holo-fs://${requested.rootId}/${
              value.resolvedSegments.map(encodeURIComponent).join('/')
            }`
            return {
              evidence: value.evidence,
              resolved: canonicalizeFilesystemResource(verifiedUrl, 'native verified filesystem target')
            }
          }
        }],
        execute(resolvedContext, authorities, tokens) {
          if (
            authorities.length !== 1 || tokens.length !== 1 ||
            tokens[0].resolvedSemanticDigest !== resolved.semanticResourceDigest
          ) {
            throw new CapabilityInvocationError('provider.protocol_error', context.operation)
          }
          return invokeFilesystem(resolvedContext, authorities[0], {
            requested,
            ticket: prepared.ticket,
            targetType: prepared.evidence.targetType
          })
        },
        dispose() {
          sendFilesystem({ kind: 'closeResolution', ticket: prepared.ticket }, context.operation)
        }
      }
    },
    invoke(call, authority) {
      return invokeFilesystem(call, authority)
    }
  }
  return new Map([['host.system', system], ['host.fs', filesystem]])
}
