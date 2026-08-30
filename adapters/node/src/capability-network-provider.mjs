import dns from 'node:dns'

import {
  CapabilityInvocationError,
  normalizeResolutionEvidenceV1,
  trustedInvocationValueFromJsonV1
} from '../../../dist/capability-runtime/index.js'
import { assertNodeNetworkAuthorityV1 } from './capability-provider-authority.mjs'
import { isPrivateAddress } from './network-authority.mjs'

const DNS_TTL_MS = 30_000

const resolutionError = (context, code = 'provider.unavailable') => {
  throw new CapabilityInvocationError(code, context.operation, context.resource.requested.semanticResourceDigest)
}

export class NodeNetworkAuthorizationProviderV1 {
  execution = 'sync'
  module
  #generation
  #nextBinding = 1
  #resolve
  #resolutions = new Map()

  constructor(module, generation, resolve = dns.promises.lookup) {
    this.module = module
    this.#generation = generation
    this.#resolve = resolve
  }

  preflight(context, authority) {
    if (this.module !== 'host.network' || context.operation !== 'network.fetch.request') return undefined
    return this.#resolveRequest(context, authority)
  }

  invoke(context, authority) {
    if (context.resource.requested.kind !== 'network') {
      throw new CapabilityInvocationError('resource.invalid', context.operation)
    }
    assertNodeNetworkAuthorityV1(context, authority, this.module)
    if (context.operation === 'network.fetch.redirect') {
      return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
    }
    if (context.operation === 'network.response.metadata.read') {
      return authority.complete(trustedInvocationValueFromJsonV1(context.providerData, 'result'))
    }
    if (context.operation === 'network.response.body.read') return this.#body(context, authority)
    return this.#completeRequest(context, authority)
  }

  resolution(bindingId, urlValue) {
    const value = this.#resolutions.get(bindingId)
    if (value == null || value.generation !== this.#generation || performance.now() > value.expiresAtMonotonicMs) {
      throw Object.assign(new Error('Node capability network resolution is stale'), { code: 'dns_rebind' })
    }
    const url = new URL(urlValue)
    if (url.origin !== value.origin) {
      throw Object.assign(new Error('Node capability network origin changed'), { code: 'dns_rebind' })
    }
    return value.addresses
  }

  #body(context, authority) {
    if (context.member === 'Response.clone') {
      const sourceBindingId = context.resource.inheritedBindingId
      const bindingId = `network-clone-${context.requestId}-${this.#nextBinding++}`
      const resolution = this.#resolutions.get(sourceBindingId)
      if (resolution != null) this.#resolutions.set(bindingId, resolution)
      return authority.complete(
        trustedInvocationValueFromJsonV1({
          binding: { bindingId, generation: context.runtime.generation },
          resourceType: 'network.response'
        }, 'result'),
        [{
          bindingId,
          close: () => this.#resolutions.delete(bindingId),
          resource: context.resource.requested,
          resourceType: 'network.response'
        }]
      )
    }
    const value = context.member === 'Response.json'
      ? null
      : context.member === 'Response.text'
      ? ''
      : { base64: '', byteLength: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }
    return authority.complete(trustedInvocationValueFromJsonV1(value, 'result'))
  }

  #completeRequest(context, authority, resolution) {
    const bindingId = `network-${context.requestId}-${this.#nextBinding++}`
    if (resolution != null) this.#resolutions.set(bindingId, resolution)
    return authority.complete(
      trustedInvocationValueFromJsonV1({
        binding: { bindingId, generation: context.runtime.generation },
        resourceType: 'network.response'
      }, 'result'),
      [{
        bindingId,
        close: () => this.#resolutions.delete(bindingId),
        resource: context.resource.requested,
        resourceType: 'network.response'
      }]
    )
  }

  async #resolveRequest(context, authority) {
    const constraints = assertNodeNetworkAuthorityV1(context, authority, this.module)
    const resource = context.resource.requested
    let results
    try {
      results = await this.#resolve(new URL(resource.origin).hostname, { all: true, verbatim: true })
    } catch {
      return resolutionError(context)
    }
    if (!Array.isArray(results) || results.length < 1 || results.length > 64) return resolutionError(context)
    const addresses = results.map(item => item?.address)
    if (addresses.some(address => typeof address !== 'string')) return resolutionError(context)
    const evidence = normalizeResolutionEvidenceV1({
      addresses,
      expiresAtMonotonicMs: performance.now() + DNS_TTL_MS,
      kind: 'networkAddress',
      resolverGeneration: this.#generation
    })
    if (!constraints.allowPrivateNetwork && evidence.addresses.some(isPrivateAddress)) {
      return resolutionError(context, 'policy.denied')
    }
    const resolution = Object.freeze({
      addresses: evidence.addresses,
      expiresAtMonotonicMs: evidence.expiresAtMonotonicMs,
      generation: this.#generation,
      origin: resource.origin
    })
    return {
      execute: (resolvedContext, authorities) => {
        const resolvedAuthority = authorities[0]
        if (resolvedAuthority == null) return resolutionError(context, 'provider.protocol_error')
        return this.#completeRequest(resolvedContext, resolvedAuthority, resolution)
      },
      requests: [{
        evidence,
        reason: 'networkAddress',
        resolved: resource,
        sideEffectCount: 0,
        verify: () => ({ evidence, resolved: resource })
      }]
    }
  }
}
