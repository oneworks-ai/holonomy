import type { NetworkInvocationSnapshotV1 } from '@holonomyjs/capability-network/kernel/network-invocation-types'
import { NetworkRequestBodyReaderRegistryV1 } from '@holonomyjs/capability-network/kernel/request-body-reader'
import type { CapabilityBrokerInvocationV1 } from './broker-types.js'
import type { TrustedInvocationValueV1 } from './broker-values.js'
import { canonicalDigest } from './canonical-json.js'
import type { CanonicalJsonValue } from './canonical-json.js'
import { selectCapabilityBranchV1 } from './capability-selection.js'
import { compileSandboxPolicyV2 } from './compile-policy.js'
import { CapabilityInvocationError } from './errors.js'
import type { CapabilityInvocationHostInputV1 } from './guest-facade-support.js'
import { guestErrorFamilyFromInvocationJsonV1 } from './invocation-family.js'
import { guestInvocationErrorV1 } from './invocation-guest-error.js'
import type { CapabilityRuntimeInvocationKernelOptionsV1 } from './invocation-kernel-types.js'

export const createInvocationBodyReadersV1 = (options: CapabilityRuntimeInvocationKernelOptionsV1) => {
  const selected = options.networkRequestBodyReader
  if (selected == null) return undefined
  const network = options.admitted.configuration.sandboxPolicy.network
  if (network.access === 'none' || network.requestBodyInspection.access !== 'bounded') {
    throw new TypeError('Network request body reader requires bounded Policy')
  }
  const admitted = options.admitted
  const verified = selectCapabilityBranchV1(selected.requirement, selected.bindings, {
    generation: admitted.generation,
    policyDigest: compileSandboxPolicyV2(admitted.configuration.sandboxPolicy).digest,
    principal: admitted.principal,
    processId: admitted.processId
  })
  if (
    verified == null || selected.bindings.length !== 1 ||
    selected.bindings[0]?.name !== 'host.network.request-body.read' ||
    canonicalDigest(verified as unknown as CanonicalJsonValue) !==
      canonicalDigest(selected as unknown as CanonicalJsonValue)
  ) throw new TypeError('Invalid Network request body reader capability selection')
  const constraints = verified.bindings[0]!.constraints
  const maxReadBytes = Math.min(network.requestBodyInspection.maxBytes, constraints.maxReadBytes as number, 1024 * 1024)
  const maxReads = Math.min(network.requestBodyInspection.maxReadsPerRuntime, constraints.maxReads as number, 1024)
  if (maxReadBytes === 0 || maxReads === 0) return undefined
  return new NetworkRequestBodyReaderRegistryV1({
    generation: admitted.generation,
    maxReadBytes,
    maxReads,
    timeoutMs: network.limits.socketTimeoutMs
  })
}

export const bindInvocationBodyReaderV1 = (
  readers: NetworkRequestBodyReaderRegistryV1 | undefined,
  request: CapabilityBrokerInvocationV1,
  hostInput?: CapabilityInvocationHostInputV1
) =>
  readers != null && request.module === 'web:fetch' && request.member === 'fetch'
    ? readers.create(
      (request.arguments.value as unknown as NetworkInvocationSnapshotV1).body,
      request.requestId,
      hostInput?.networkRequestBodyBase64
    )
    : undefined

export const invokeWithHostInputV1 = async (
  json: string,
  createRequest: () => CapabilityBrokerInvocationV1,
  invoke: (request: CapabilityBrokerInvocationV1) => Promise<TrustedInvocationValueV1>,
  readers: NetworkRequestBodyReaderRegistryV1 | undefined,
  hostInput?: CapabilityInvocationHostInputV1
) => {
  let close: (() => void) | undefined
  let stopDeadline: (() => void) | undefined
  try {
    const request = createRequest()
    const reader = bindInvocationBodyReaderV1(readers, request, hostInput)
    close = reader?.close
    const controller = new AbortController()
    if (reader != null) {
      const abort = () => controller.abort(request.signal?.reason)
      request.signal?.addEventListener('abort', abort, { once: true })
      if (request.signal?.aborted) abort()
      const timer = setTimeout(
        () => controller.abort(new CapabilityInvocationError('middleware.timeout', 'network.fetch.request')),
        readers!.timeoutMs
      )
      stopDeadline = () => {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', abort)
      }
    }
    const result = await invoke(
      reader == null
        ? request
        : Object.freeze({ ...request, hostBindings: Object.freeze([reader.binding]), signal: controller.signal })
    )
    return JSON.stringify({ ok: true, value: result.value })
  } catch (error) {
    return JSON.stringify({
      error: guestInvocationErrorV1(error, guestErrorFamilyFromInvocationJsonV1(json)),
      ok: false
    })
  } finally {
    stopDeadline?.()
    close?.()
  }
}
