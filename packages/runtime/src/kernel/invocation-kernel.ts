import type { CapabilityBrokerInvocationV1 } from './broker-types.js'
import { CapabilityInvocationBrokerV1 } from './broker.js'
import { CapabilityInvocationError } from './errors.js'
import type { CapabilityInvocationHostInputV1 } from './guest-facade-support.js'
import type { RuntimePluginInterceptorScopeV1 } from './interceptor-registry.js'
import { guestErrorFamilyFromInvocationJsonV1 } from './invocation-family.js'
import { guestInvocationErrorV1 } from './invocation-guest-error.js'
import { createInvocationBodyReadersV1, invokeWithHostInputV1 } from './invocation-host-input.js'
import type { CapabilityRuntimeInvocationKernelOptionsV1 } from './invocation-kernel-types.js'
import { createCapabilityInvocationRequestV1 } from './invocation-request.js'
import { invokeFromCapabilitySourceSyncV1, invokeFromCapabilitySourceV1 } from './invocation-source-dispatch.js'
import type { JsonValueV1 } from './json-types.js'

export type { CapabilityRuntimeInvocationKernelOptionsV1 } from './invocation-kernel-types.js'
export class CapabilityRuntimeInvocationKernelV1 {
  readonly #broker: CapabilityInvocationBrokerV1
  readonly #networkProvider: 'host.network' | 'host.network.mock'
  readonly #prefix: string
  readonly #generation: number
  readonly #requestBodyReaders: ReturnType<typeof createInvocationBodyReadersV1>
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
    this.#requestBodyReaders = createInvocationBodyReadersV1(options)
  }

  get admissionDigest(): string {
    return this.#broker.admissionDigest
  }
  close(stale = false): void {
    this.#requestBodyReaders?.close()
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

  async invoke(json: string, signal?: AbortSignal, hostInput?: CapabilityInvocationHostInputV1): Promise<string> {
    return invokeWithHostInputV1(
      json,
      () => this.#request(json, undefined, signal),
      request => this.#broker.invoke(request),
      this.#requestBodyReaders,
      hostInput
    )
  }

  /** Host-only settlement handle for transport quotas and plugin graph retirement. */
  invokeTracked(json: string, signal?: AbortSignal): Readonly<{
    result: Promise<string>
    settled: Promise<void>
  }> {
    try {
      const tracked = this.#broker.invokeTracked(this.#request(json, undefined, signal))
      const result = tracked.result.then(
        value => JSON.stringify({ ok: true, value: value.value }),
        error =>
          JSON.stringify({
            error: guestInvocationErrorV1(error, guestErrorFamilyFromInvocationJsonV1(json)),
            ok: false
          })
      )
      return Object.freeze({ result, settled: tracked.settled })
    } catch (error) {
      return Object.freeze({
        result: Promise.resolve(JSON.stringify({
          error: guestInvocationErrorV1(error, guestErrorFamilyFromInvocationJsonV1(json)),
          ok: false
        })),
        settled: Promise.resolve()
      })
    }
  }

  async invokeFromSource(input: unknown, signal?: AbortSignal): Promise<JsonValueV1> {
    return invokeFromCapabilitySourceV1(
      input,
      async (json, source) =>
        (await this.#broker.invoke(
          Object.freeze({ ...this.#request(json), source, ...(signal == null ? {} : { signal }) })
        )).value
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

  resourceEventDescriptor(bindingId: string) {
    return this.#broker.resourceEventDescriptor(bindingId)
  }

  #request(json: string, forcedMode?: 'sync', signal?: AbortSignal): CapabilityBrokerInvocationV1 {
    return createCapabilityInvocationRequestV1(
      json,
      {
        generation: this.#generation,
        networkProvider: this.#networkProvider,
        requestPrefix: this.#prefix,
        nextOrdinal: () => ++this.#nextRequestId,
        resource: (bindingId, type) => this.#broker.resource(bindingId, type)
      },
      forcedMode,
      signal
    )
  }
}
