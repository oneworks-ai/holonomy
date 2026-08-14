import type { CapabilityBrokerInvocationV1 } from './broker-types.js'
import { CapabilityInvocationBrokerV1 } from './broker.js'
import type { AdmittedRuntimeCreationV1 } from './context-types.js'
import { CapabilityInvocationError } from './errors.js'
import { translateCapabilityErrorV1 } from './guest-errors.js'
import { exactInvocationInputV1 } from './invocation-input.js'
import { routeCapabilityInvocationV1 } from './invocation-routing.js'
import { normalizeCapabilityInvocationSourceV1 } from './invocation-source.js'
import { trustedInvocationValueFromJsonV1 } from './json-invocation-value.js'
import type { JsonValueV1 } from './json-types.js'
import { normalizeNetworkRedirectInvocationV1 } from './network-invocation.js'

type GuestErrorFamilyV1 = 'childProcess' | 'holo' | 'nodeFs' | 'nodeSystem'
const guestError = (error: unknown, family: GuestErrorFamilyV1) => {
  const translated = translateCapabilityErrorV1(error, family)
  return Object.freeze({
    code: translated.code,
    message: translated.message,
    name: translated.name,
    retryable: translated.retryable
  })
}

export interface CapabilityRuntimeInvocationKernelOptionsV1 {
  readonly admitted: AdmittedRuntimeCreationV1
  readonly engine: string
  readonly networkProvider: 'host.network' | 'host.network.mock'
  readonly requestPrefix: string
  readonly target: 'android' | 'desktop' | 'node'
}

export class CapabilityRuntimeInvocationKernelV1 {
  readonly #broker: CapabilityInvocationBrokerV1
  readonly #networkProvider: 'host.network' | 'host.network.mock'
  readonly #prefix: string
  readonly #generation: number
  #nextRequestId = 0
  constructor(options: CapabilityRuntimeInvocationKernelOptionsV1) {
    this.#broker = new CapabilityInvocationBrokerV1({
      admitted: options.admitted,
      engine: options.engine,
      target: options.target
    })
    this.#generation = options.admitted.generation
    this.#networkProvider = options.networkProvider
    this.#prefix = options.requestPrefix
  }

  get admissionDigest(): string {
    return this.#broker.admissionDigest
  }

  close(stale = false): void {
    this.#broker.close(stale ? 'generation-stale' : 'cancelled')
  }

  invokeSync(json: string): string {
    try {
      const request = this.#request(json, 'sync')
      return JSON.stringify({ ok: true, value: this.#broker.invokeSync(request).value })
    } catch (error) {
      return JSON.stringify({ error: guestError(error, this.#family(json)), ok: false })
    }
  }

  invokeImmediate(json: string): string {
    try {
      return JSON.stringify({ ok: true, value: this.#broker.invokeSync(this.#request(json)).value })
    } catch (error) {
      return JSON.stringify({ error: guestError(error, this.#family(json)), ok: false })
    }
  }

  async invoke(json: string): Promise<string> {
    try {
      const result = await this.#broker.invoke(this.#request(json))
      return JSON.stringify({ ok: true, value: result.value })
    } catch (error) {
      return JSON.stringify({ error: guestError(error, this.#family(json)), ok: false })
    }
  }

  async invokeFromSource(input: unknown): Promise<JsonValueV1> {
    const value = exactInvocationInputV1(input, [
      'arguments',
      'bindingId',
      'member',
      'mode',
      'module',
      'path',
      'providerData',
      'resourceType',
      'source'
    ])
    const source = normalizeCapabilityInvocationSourceV1(value.source)
    const request = this.#request(JSON.stringify({
      ...(value.arguments === undefined ? {} : { arguments: value.arguments }),
      ...(value.bindingId === undefined ? {} : { bindingId: value.bindingId }),
      member: value.member,
      mode: value.mode,
      module: value.module,
      ...(value.path === undefined ? {} : { path: value.path }),
      ...(value.providerData === undefined ? {} : { providerData: value.providerData }),
      ...(value.resourceType === undefined ? {} : { resourceType: value.resourceType })
    }))
    return (await this.#broker.invoke(Object.freeze({ ...request, source }))).value
  }

  releaseResource(bindingId: string): void {
    this.#broker.releaseResource(bindingId)
  }

  subscribeResource(bindingId: string, listener: (event: unknown) => void): () => void {
    return this.#broker.subscribeResource(bindingId, listener)
  }

  #family(json: string): GuestErrorFamilyV1 {
    try {
      const module = (JSON.parse(json) as { module?: unknown })?.module
      return module === 'node:child_process'
        ? 'childProcess'
        : module === 'node:fs' || module === 'node:fs/promises'
        ? 'nodeFs'
        : module === 'node:os' || module === 'node:process'
        ? 'nodeSystem'
        : 'holo'
    } catch {
      return 'holo'
    }
  }

  #request(json: string, forcedMode?: 'sync'): CapabilityBrokerInvocationV1 {
    if (typeof json !== 'string' || json.length > 1024 * 1024) {
      throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
    }
    const input = exactInvocationInputV1(JSON.parse(json), [
      'arguments',
      'bindingId',
      'member',
      'method',
      'mode',
      'module',
      'path',
      'providerData',
      'resourceType',
      'url'
    ])
    const mode = forcedMode ?? input.mode
    if (mode !== 'callback' && mode !== 'promise' && mode !== 'sync') {
      throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
    }
    const module = input.module
    const member = input.member
    if (typeof module !== 'string' || typeof member !== 'string') {
      throw new CapabilityInvocationError('argument.invalid', 'runtime.invoke')
    }
    const requestId = `${this.#prefix}-${this.#generation}-${++this.#nextRequestId}`
    const inheritedBindingId = typeof input.bindingId === 'string' ? input.bindingId : undefined
    const routed = inheritedBindingId == null
      ? routeCapabilityInvocationV1({
        arguments: input.arguments as JsonValueV1,
        generation: this.#generation,
        member,
        method: input.method,
        module,
        networkProvider: this.#networkProvider,
        path: input.path,
        requestOrdinal: this.#nextRequestId,
        url: input.url
      })
      : module === 'web:fetch' && member === 'followRedirect'
      ? (() => {
        const redirect = normalizeNetworkRedirectInvocationV1(input.arguments)
        return { preferredProviderModule: undefined, resource: redirect.toRequest.resource }
      })()
      : {
        preferredProviderModule: undefined,
        resource: this.#broker.resource(
          inheritedBindingId,
          typeof input.resourceType === 'string' ? input.resourceType : undefined
        )
      }
    return Object.freeze({
      arguments: trustedInvocationValueFromJsonV1(
        (('argumentsValue' in routed ? routed.argumentsValue : undefined) ?? input.arguments) as JsonValueV1,
        'argument'
      ),
      ...(inheritedBindingId == null ? {} : { inheritedBindingId }),
      invocationMode: mode,
      member,
      module,
      preferredProviderModule: routed.preferredProviderModule,
      ...(input.providerData === undefined
        ? {}
        : { providerData: trustedInvocationValueFromJsonV1(input.providerData as JsonValueV1, 'argument') }),
      requestId,
      resource: routed.resource
    })
  }
}
