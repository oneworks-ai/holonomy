import { buildNetworkInvocationSnapshotV1 } from '../../../../packages/capabilities/network/src/kernel/network-invocation-builder.ts'
import { isPrivateNetworkHost } from '../../../../packages/capabilities/network/src/web/authority.ts'
import {
  CapabilityInvocationError,
  canonicalDigest,
  normalizeResolutionEvidenceV1,
  trustedInvocationValueFromJsonV1
} from '../../../../packages/runtime/src/kernel/index.ts'
import { RuntimeBuffer } from '../../../../packages/runtime/src/node-compat/buffer.ts'

import { createNativeResponseBody, nativeNetworkTransportError } from './network-response-body.mjs'

export const createNativeNetworkProvider = (native, policy) => {
  const module = policy.access === 'mockOnly' ? 'host.network.mock' : 'host.network'
  const bindings = new Map()
  let next = 0
  const sync = input => {
    const result = JSON.parse(native.networkSync(JSON.stringify(input)))
    if (result.ok !== true) throw new CapabilityInvocationError(result.code, 'network.fetch.request')
    return result.value
  }
  const task = async (input, signal) => {
    if (signal?.aborted) throw new CapabilityInvocationError('runtime.cancelled', 'network.fetch.request')
    const started = native.networkStart(JSON.stringify(input))
    const abort = () => native.networkCancel(started.id)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const value = JSON.parse(await started.promise)
      if (signal?.aborted) {
        if (value.resolutionId) sync({ kind: 'discardResolution', resolutionId: value.resolutionId })
        if (value.streamId) sync({ kind: 'closeStream', streamId: value.streamId })
        if (input.kind === 'pull' && input.streamId) sync({ kind: 'closeStream', streamId: input.streamId })
        throw new CapabilityInvocationError('runtime.cancelled', 'network.fetch.request')
      }
      return value
    } catch (error) {
      throw error instanceof CapabilityInvocationError
        ? error
        : new CapabilityInvocationError(error?.code ?? 'provider.unavailable', 'network.fetch.request')
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }
  const selected = (context, authority) => {
    const resource = context.resource.requested
    const binding = authority.bindings.find(binding =>
      binding.providerModule === module && binding.constraints.origins?.includes(resource.origin) &&
      binding.constraints.schemes?.includes(new URL(resource.origin).protocol.slice(0, -1))
    )
    if (resource.kind !== 'network' || binding == null) {
      throw new CapabilityInvocationError('capability.denied', context.operation)
    }
    return binding.constraints
  }
  const close = id => {
    bindings.delete(id)
    sync({ kind: 'close', bindingId: id })
  }
  const complete = (context, authority, resolution, snapshot = context.arguments) => {
    const bindingId = `network-${context.requestId}-${++next}`
    if (resolution) sync({ kind: 'bind', bindingId, resolutionId: resolution.resolutionId })
    bindings.set(bindingId, snapshot)
    return authority.complete(
      trustedInvocationValueFromJsonV1({
        binding: { bindingId, generation: context.runtime.generation },
        resourceType: 'network.response'
      }, 'result'),
      [{
        bindingId,
        resource: context.resource.requested,
        resourceType: 'network.response',
        close: () => close(bindingId)
      }]
    )
  }
  const verify = (request, bindingId) => {
    const expected = bindings.get(bindingId)
    if (expected == null) throw new CapabilityInvocationError('resource.stale', 'network.fetch.request')
    const length = request.bodyLength ?? request.body?.byteLength ?? 0
    const actual = buildNetworkInvocationSnapshotV1({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      hop: expected.hop,
      logicalRequestId: expected.logicalRequestId,
      label: 'HTTP request'
    })
    const body = expected.body.kind === 'none' && length === 0
      ? expected.body
      : request.body instanceof Uint8Array && request.body.byteLength === length
      ? actual.body
      : { kind: 'buffered', length, sha256: request.bodySha256 }
    const comparable = value => ({
      method: value.method,
      headerDigest: value.headerDigest,
      queryDigest: value.queryDigest,
      body: value.body,
      resource: value.resource.semanticResourceDigest
    })
    if (canonicalDigest(comparable(expected)) !== canonicalDigest(comparable({ ...actual, body }))) {
      throw new CapabilityInvocationError('capability.denied', 'network.fetch.request')
    }
  }
  const provider = {
    module,
    execution: 'sync',
    preflight(context, authority) {
      if (module !== 'host.network' || context.operation !== 'network.fetch.request') return
      return (async () => {
        const constraints = selected(context, authority)
        const resolution = await task({
          kind: 'resolve',
          origin: context.resource.requested.origin,
          allowPrivateNetwork: constraints.allowPrivateNetwork
        }, context.signal)
        const evidence = normalizeResolutionEvidenceV1({
          kind: 'networkAddress',
          addresses: resolution.addresses,
          expiresAtMonotonicMs: resolution.expiresAtMonotonicMs,
          resolverGeneration: resolution.resolverGeneration
        })
        if (!constraints.allowPrivateNetwork && evidence.addresses.some(isPrivateNetworkHost)) {
          throw new CapabilityInvocationError('policy.denied', context.operation)
        }
        return {
          requests: [{
            reason: 'networkAddress',
            resolved: context.resource.requested,
            evidence,
            sideEffectCount: 0,
            verify: () => ({ evidence, resolved: context.resource.requested })
          }],
          execute(resolved, authorities) {
            selected(resolved, authorities[0])
            return complete(resolved, authorities[0], resolution, context.arguments)
          },
          dispose() {
            sync({ kind: 'discardResolution', resolutionId: resolution.resolutionId })
          }
        }
      })()
    },
    invoke(context, authority) {
      selected(context, authority)
      if (context.operation === 'network.fetch.redirect') {
        return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
      }
      if (context.operation === 'network.response.metadata.read') {
        return authority.complete(trustedInvocationValueFromJsonV1(context.providerData, 'result'))
      }
      if (context.operation === 'network.response.body.read') {
        if (context.member === 'Response.clone') {
          return complete(context, authority, undefined, bindings.get(context.resource.inheritedBindingId))
        }
        const value = context.member === 'Response.json'
          ? null
          : context.member === 'Response.text'
          ? ''
          : { base64: '', byteLength: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }
        return authority.complete(trustedInvocationValueFromJsonV1(value, 'result'))
      }
      return complete(context, authority)
    }
  }
  return {
    provider,
    verify,
    async request(input) {
      try {
        const result = await task({
          kind: 'request',
          request: {
            bindingId: input.capabilityBindingId,
            url: input.url,
            method: input.method,
            headers: input.headers,
            body: RuntimeBuffer.from(input.body ?? new Uint8Array()).toString('base64')
          }
        }, input.signal)
        const { streamId, ...head } = result
        return {
          ...head,
          body: head.hasBody === true && typeof streamId === 'string'
            ? createNativeResponseBody(streamId, task, sync)
            : undefined
        }
      } catch (error) {
        throw nativeNetworkTransportError(error)
      }
    }
  }
}
