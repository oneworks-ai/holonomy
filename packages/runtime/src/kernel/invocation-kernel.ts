import { normalizeNetworkRedirectInvocationV1 } from '@holonomyjs/capability-network/kernel/network-invocation'
import type { CapabilityBrokerInvocationV1 } from './broker-types.js'
import { CapabilityInvocationBrokerV1 } from './broker.js'
import type { AdmittedRuntimeCreationV1 } from './context-types.js'
import { CapabilityInvocationError } from './errors.js'
import type { RuntimePluginInterceptorScopeV1 } from './interceptor-registry.js'
import { bindInvocationAbortSignalV1 } from './invocation-abort.js'
import { guestErrorFamilyFromInvocationJsonV1 } from './invocation-family.js'
import { guestInvocationErrorV1 } from './invocation-guest-error.js'
import { exactInvocationInputV1 } from './invocation-input.js'
import { routeCapabilityInvocationV1 } from './invocation-routing.js'
import { invokeFromCapabilitySourceSyncV1, invokeFromCapabilitySourceV1 } from './invocation-source-dispatch.js'
import { trustedInvocationValueFromJsonV1 } from './json-invocation-value.js'
import type { JsonValueV1 } from './json-types.js'

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
  cancel(json: string): string {
    return JSON.stringify({
      error: guestInvocationErrorV1(
        new CapabilityInvocationError('runtime.cancelled', 'runtime.invoke'),
        guestErrorFamilyFromInvocationJsonV1(json)
      ),
      ok: false
    })
  }
  invokeSync(json: string): string {
    try {
      const request = this.#request(json, 'sync')
      return JSON.stringify({ ok: true, value: this.#broker.invokeSync(request).value })
    } catch (error) {
      return JSON.stringify({
        error: guestInvocationErrorV1(error, guestErrorFamilyFromInvocationJsonV1(json)),
        ok: false
      })
    }
  }

  invokeImmediate(json: string): string {
    try {
      return JSON.stringify({ ok: true, value: this.#broker.invokeSync(this.#request(json)).value })
    } catch (error) {
      return JSON.stringify({
        error: guestInvocationErrorV1(error, guestErrorFamilyFromInvocationJsonV1(json)),
        ok: false
      })
    }
  }

  async invoke(json: string, signal?: AbortSignal): Promise<string> {
    try {
      const result = await this.#broker.invoke(this.#request(json, undefined, signal))
      return JSON.stringify({ ok: true, value: result.value })
    } catch (error) {
      return JSON.stringify({
        error: guestInvocationErrorV1(error, guestErrorFamilyFromInvocationJsonV1(json)),
        ok: false
      })
    }
  }

  async invokeFromSource(input: unknown): Promise<JsonValueV1> {
    return invokeFromCapabilitySourceV1(
      input,
      async (json, source) => (await this.#broker.invoke(Object.freeze({ ...this.#request(json), source }))).value
    )
  }

  invokeFromSourceImmediate(input: unknown): JsonValueV1 {
    return invokeFromCapabilitySourceSyncV1(
      input,
      (json, source) => this.#broker.invokeSync(Object.freeze({ ...this.#request(json), source })).value
    )
  }

  releaseResource(bindingId: string): void {
    this.#broker.releaseResource(bindingId)
  }

  createPluginInterceptorScope(instanceId: string): RuntimePluginInterceptorScopeV1<unknown> {
    return this.#broker.createPluginInterceptorScope(instanceId)
  }

  publishPluginGraph(revision: number, scopes: readonly RuntimePluginInterceptorScopeV1<unknown>[]): void {
    this.#broker.publishPluginGraph(revision, scopes)
  }

  drainPluginGraph(revision: number): Promise<void> {
    return this.#broker.drainPluginGraph(revision)
  }

  subscribeResource(bindingId: string, listener: (event: unknown) => void): () => void {
    return this.#broker.subscribeResource(bindingId, listener)
  }

  #request(json: string, forcedMode?: 'sync', signal?: AbortSignal): CapabilityBrokerInvocationV1 {
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
    const argumentsValue = bindInvocationAbortSignalV1(
      input.arguments as JsonValueV1,
      signal == null ? undefined : `abort-${this.#generation}-${this.#nextRequestId}`,
      this.#generation
    )
    const inheritedBindingId = typeof input.bindingId === 'string' ? input.bindingId : undefined
    const routed = inheritedBindingId == null
      ? routeCapabilityInvocationV1({
        arguments: argumentsValue,
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
        (('argumentsValue' in routed ? routed.argumentsValue : undefined) ?? argumentsValue) as JsonValueV1,
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
      resource: routed.resource,
      ...(signal == null ? {} : { signal })
    })
  }
}
