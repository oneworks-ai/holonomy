/* eslint-disable max-lines -- Broker authorization, graph lease and Storage slot finalize as one invocation. */
import { executeCapabilityAsyncV1, executeCapabilitySyncV1 } from './broker-execution.js'
import { createBrokerFrameLeaseV1 } from './broker-frame-lease.js'
import { compileInitialMiddlewareSetV1 } from './broker-matcher.js'
import { prepareCapabilityBrokerInvocationV1 } from './broker-preparation.js'
import type {
  CapabilityBrokerInvocationV1,
  CapabilityProviderResourcePublicationV1,
  CapabilityRuntimeTargetV1,
  CapabilitySystemMiddlewareRegistrationV1,
  HoloMiddlewareRegistrationV1,
  InitialMiddlewareSetV1
} from './broker-types.js'
import type { TrustedInvocationValueV1 } from './broker-values.js'
import { canonicalJson } from './canonical-json.js'
import type { CanonicalJsonValue } from './canonical-json.js'
import { compileSandboxPolicyV2 } from './compile-policy.js'
import type { AdmittedRuntimeCreationV1 } from './context-types.js'
import { CapabilityInvocationError } from './errors.js'
import { RuntimeInterceptorRegistryV1 } from './interceptor-registry.js'
import type { RuntimePluginInterceptorScopeV1 } from './interceptor-registry.js'
import { CapabilityResourceRegistryV1, resourceFacadeBindingV1 } from './resource-registry.js'

export interface CapabilityBrokerOptionsV1<THostContext> {
  readonly admitted: AdmittedRuntimeCreationV1
  readonly engine: string
  readonly systemMiddleware?: readonly CapabilitySystemMiddlewareRegistrationV1<THostContext>[]
  readonly target: CapabilityRuntimeTargetV1
}

export class CapabilityInvocationBrokerV1<THostContext = unknown> {
  readonly #admitted: AdmittedRuntimeCreationV1
  readonly #controller = new AbortController()
  readonly #engine: string
  readonly #initial: InitialMiddlewareSetV1<THostContext>
  readonly #policyDigest: string
  readonly #resources: CapabilityResourceRegistryV1
  readonly #system: readonly HoloMiddlewareRegistrationV1<THostContext>[]
  readonly #target: CapabilityRuntimeTargetV1
  readonly interceptors = new RuntimeInterceptorRegistryV1<THostContext>()
  #storagePending = 0

  get admissionDigest(): string {
    return this.#admitted.admissionDigest
  }

  constructor(options: CapabilityBrokerOptionsV1<THostContext>) {
    this.#admitted = options.admitted
    this.#engine = options.engine
    this.#target = options.target
    const bindingId = options.admitted.hostBindings.initialMiddlewareSet.bindingId
    this.#initial = compileInitialMiddlewareSetV1(
      options.admitted.resolvedHostBindings[bindingId] as InitialMiddlewareSetV1<THostContext>
    )
    this.#system = compileInitialMiddlewareSetV1({
      registrations: options.systemMiddleware ?? [],
      schemaVersion: 1
    }).registrations
    this.#policyDigest = compileSandboxPolicyV2(options.admitted.configuration.sandboxPolicy).digest
    this.#resources = new CapabilityResourceRegistryV1(Object.freeze({
      engine: this.#engine,
      generation: this.#admitted.generation,
      policyDigest: this.#policyDigest,
      processId: this.#admitted.processId,
      target: this.#target
    }))
  }

  close(reason: 'cancelled' | 'generation-stale' = 'cancelled'): void {
    if (this.#controller.signal.aborted) return
    this.#controller.abort(
      new CapabilityInvocationError(
        reason === 'cancelled' ? 'runtime.cancelled' : 'runtime.generation_stale',
        'runtime.lifecycle'
      )
    )
    this.#resources.close(reason)
  }

  resource(bindingId: string, resourceType?: string) {
    return this.#resources.get(bindingId, resourceType).resource
  }

  releaseResource(bindingId: string): void {
    this.#resources.release(bindingId)
  }

  createPluginInterceptorScope(instanceId: string): RuntimePluginInterceptorScopeV1<THostContext> {
    return this.interceptors.createPluginScope(instanceId)
  }

  publishPluginGraph(
    revision: number,
    scopes: readonly RuntimePluginInterceptorScopeV1<THostContext>[]
  ): void {
    this.interceptors.publishPluginGraph(revision, scopes)
  }

  drainPluginGraph(revision: number): Promise<void> {
    return this.interceptors.drainPluginGraph(revision)
  }

  subscribeResource(bindingId: string, listener: (event: unknown) => void): () => void {
    return this.#resources.subscribe(bindingId, listener)
  }

  resourceEventDescriptor(bindingId: string) {
    return this.#resources.eventDescriptor(bindingId)
  }

  invokeSync(invocation: CapabilityBrokerInvocationV1): TrustedInvocationValueV1 {
    const execution = this.#prepare(invocation)
    const lease = createBrokerFrameLeaseV1()
    let publishedResources: readonly CapabilityProviderResourcePublicationV1[] = []
    try {
      const result = executeCapabilitySyncV1(execution, lease)
      execution.validate(result)
      publishedResources = this.#publish(execution, result)
      if (execution.releaseBindingId != null) this.#resources.release(execution.releaseBindingId)
      return result
    } finally {
      for (const resource of execution.terminal?.resources ?? []) {
        if (publishedResources.includes(resource)) continue
        lease.track(Promise.resolve().then(() => resource.close?.('cancelled')).catch(() => undefined))
      }
      if (lease.pending) execution.abort(this.#cancelled(execution.context.operation))
      lease.close()
      if (lease.pending) void lease.settled.then(execution.cleanup, execution.cleanup)
      else execution.cleanup()
    }
  }

  invoke(invocation: CapabilityBrokerInvocationV1): Promise<TrustedInvocationValueV1> {
    const tracked = this.invokeTracked(invocation)
    void tracked.settled.catch(() => undefined)
    return tracked.result
  }

  invokeTracked(invocation: CapabilityBrokerInvocationV1): Readonly<{
    result: Promise<TrustedInvocationValueV1>
    settled: Promise<void>
  }> {
    let execution: ReturnType<typeof prepareCapabilityBrokerInvocationV1<THostContext>>
    try {
      execution = this.#prepare(invocation)
    } catch (error) {
      return Object.freeze({ result: Promise.reject(error), settled: Promise.resolve() })
    }
    const storage = execution.providerModule === 'host.storage' &&
      execution.context.module === 'holo:storage' &&
      this.#admitted.configuration.sandboxPolicy.storage.access === 'sandboxed'
    const maximum = this.#admitted.configuration.sandboxPolicy.storage.access === 'sandboxed'
      ? this.#admitted.configuration.sandboxPolicy.storage.limits.maxPendingOperations
      : 0
    if (storage && this.#storagePending >= maximum) {
      execution.cleanup()
      return Object.freeze({
        result: Promise.reject(
          new CapabilityInvocationError(
            'resource.handle_limit',
            execution.context.operation,
            execution.context.resource.requested.semanticResourceDigest
          )
        ),
        settled: Promise.resolve()
      })
    }
    if (storage) this.#storagePending += 1
    const lease = createBrokerFrameLeaseV1()
    let publishedResources: readonly CapabilityProviderResourcePublicationV1[] = []
    let failure: unknown
    const result = (async () => {
      try {
        const value = await executeCapabilityAsyncV1(execution, lease)
        execution.validate(value)
        publishedResources = this.#publish(execution, value)
        if (execution.releaseBindingId != null) this.#resources.release(execution.releaseBindingId)
        return value
      } catch (error) {
        failure = error
        throw error
      } finally {
        if (lease.pending) {
          execution.abort(
            failure instanceof CapabilityInvocationError
              ? failure
              : this.#cancelled(execution.context.operation)
          )
        }
        lease.close()
      }
    })()
    const settled = lease.settled.then(async () => {
      if (execution.terminal?.resources != null) {
        await Promise.all(
          execution.terminal.resources.filter(resource => !publishedResources.includes(resource)).map(
            async resource => {
              try {
                await resource.close?.('cancelled')
              } catch {}
            }
          )
        )
      }
      try {
        execution.cleanup()
      } finally {
        if (storage) this.#storagePending -= 1
      }
    })
    return Object.freeze({ result, settled })
  }

  #cancelled(operation: string): CapabilityInvocationError {
    return new CapabilityInvocationError('runtime.cancelled', operation)
  }

  #prepare(invocation: CapabilityBrokerInvocationV1) {
    return prepareCapabilityBrokerInvocationV1({
      admitted: this.#admitted,
      controller: this.#controller,
      engine: this.#engine,
      initial: this.#initial,
      interceptors: this.interceptors,
      policyDigest: this.#policyDigest,
      resources: this.#resources,
      system: this.#system,
      target: this.#target
    }, invocation)
  }

  #publish(
    execution: ReturnType<typeof prepareCapabilityBrokerInvocationV1<THostContext>>,
    result: TrustedInvocationValueV1
  ): readonly CapabilityProviderResourcePublicationV1[] {
    const terminal = execution.terminal
    const facade = resourceFacadeBindingV1(result.value)
    const opaqueFd = result.value != null && typeof result.value === 'object' &&
      (result.value as { binding?: unknown }).binding === 'opaque' &&
      Number.isSafeInteger((result.value as { fd?: unknown }).fd)
    const publications = terminal?.result === result
      ? terminal.resources ?? []
      : facade != null
      ? terminal?.resources?.filter(resource =>
        resource.bindingId === facade.bindingId && resource.resourceType === facade.resourceType
      ) ?? []
      : opaqueFd && terminal != null && canonicalJson(terminal.result.value as CanonicalJsonValue) ===
          canonicalJson(result.value as CanonicalJsonValue)
      ? terminal.resources ?? []
      : []
    this.#resources.publish(
      result.value,
      publications.length === 0 ? undefined : publications,
      execution.providerModule,
      execution.selection,
      execution.inheritedBindingId
    )
    return publications
  }
}
