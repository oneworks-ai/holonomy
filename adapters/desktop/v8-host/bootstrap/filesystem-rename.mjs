import {
  CapabilityInvocationError,
  canonicalizeFilesystemResource,
  trustedInvocationValueFromJsonV1
} from '../../../../packages/runtime/src/kernel/index.ts'

const selected = (authority, resource, operation) => {
  const binding = authority.bindings.find(binding =>
    binding.providerModule === 'host.fs' &&
    binding.constraints.roots.some(root =>
      root.rootId === resource.rootId && root.rights.includes('move') &&
      root.pathPrefixSegments.every((value, index) => resource.pathSegments[index] === value)
    )
  )
  if (binding == null) throw new CapabilityInvocationError('capability.denied', operation)
  return binding.constraints
}
export const prepareNativeRename = (native, context, authority) => {
  const source = context.resource.requested
  const destination = canonicalizeFilesystemResource(context.arguments.to, 'rename destination')
  if (source.rootId !== destination.rootId) {
    throw new CapabilityInvocationError('resource.cross_root', context.operation)
  }
  const request = {
    kind: 'invoke',
    operation: context.operation,
    arguments: context.arguments,
    rootId: source.rootId,
    pathSegments: source.pathSegments,
    destinationRootId: destination.rootId,
    destinationSegments: destination.pathSegments
  }
  const send = input => {
    const result = JSON.parse(native.filesystem(JSON.stringify(input)))
    if (result.ok !== true) throw new CapabilityInvocationError(result.code, context.operation)
    return result.value
  }
  const prepared = send({
    ...request,
    phase: 'prepareRename',
    constraints: selected(authority, source, context.operation)
  })
  const resourceFromSegments = (segments, label) =>
    canonicalizeFilesystemResource(
      `holo-fs://${source.rootId}/${segments.map(encodeURIComponent).join('/')}`,
      label
    )
  const resources = prepared.resolvedSegments.map((segments, index) =>
    resourceFromSegments(segments, index === 0 ? 'resolved rename source' : 'resolved rename destination')
  )
  return {
    requests: resources.map((resource, index) => ({
      evidence: prepared.evidence[index],
      reason: 'filesystemTarget',
      resolved: resource,
      sideEffectCount: 0,
      verify: () => {
        const verified = send({ kind: 'verifyRename', ticket: prepared.ticket })
        return {
          evidence: verified.evidence[index],
          resolved: resourceFromSegments(
            verified.resolvedSegments[index],
            index === 0 ? 'verified rename source' : 'verified rename destination'
          )
        }
      }
    })),
    execute(resolved, authorities, tokens) {
      if (
        authorities.length !== 2 || tokens.length !== 2 ||
        tokens.some((token, index) => token.resolvedSemanticDigest !== resources[index].semanticResourceDigest)
      ) {
        throw new CapabilityInvocationError('provider.protocol_error', context.operation)
      }
      const value = send({
        ...request,
        pathSegments: resources[0].pathSegments,
        destinationSegments: resources[1].pathSegments,
        requestedSegments: source.pathSegments,
        requestedDestinationSegments: destination.pathSegments,
        ticket: prepared.ticket,
        constraints: selected(authorities[0], resources[0], context.operation),
        destinationConstraints: selected(authorities[1], resources[1], context.operation)
      })
      return authorities[0].complete(trustedInvocationValueFromJsonV1(value, 'result'))
    },
    dispose() {
      send({ kind: 'closeRename', ticket: prepared.ticket })
    }
  }
}
