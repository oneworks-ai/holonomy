import { executeCapabilityAsyncV1, executeCapabilitySyncV1 } from './broker-execution.js'
import { compileInitialMiddlewareSetV1 } from './broker-matcher.js'
import { prepareCapabilityBrokerInvocationV1 } from './broker-preparation.js'
import type {
  CapabilityBrokerInvocationV1,
  CapabilityRuntimeTargetV1,
  CapabilitySystemMiddlewareRegistrationV1,
  HoloMiddlewareRegistrationV1,
  InitialMiddlewareSetV1
} from './broker-types.js'
import type { TrustedInvocationValueV1 } from './broker-values.js'
import { compileSandboxPolicyV2 } from './compile-policy.js'
import type { AdmittedRuntimeCreationV1 } from './context-types.js'
import { CapabilityInvocationError } from './errors.js'
import { RuntimeInterceptorRegistryV1 } from './interceptor-registry.js'
import { CapabilityResourceRegistryV1 } from './resource-registry.js'

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

  subscribeResource(bindingId: string, listener: (event: unknown) => void): () => void {
    return this.#resources.subscribe(bindingId, listener)
  }

  invokeSync(invocation: CapabilityBrokerInvocationV1): TrustedInvocationValueV1 {
    const execution = this.#prepare(invocation)
    try {
      const result = executeCapabilitySyncV1(execution)
      execution.validate(result)
      this.#publish(execution, result)
      if (execution.releaseBindingId != null) this.#resources.release(execution.releaseBindingId)
      return result
    } finally {
      execution.cleanup()
    }
  }

  async invoke(invocation: CapabilityBrokerInvocationV1): Promise<TrustedInvocationValueV1> {
    const execution = this.#prepare(invocation)
    try {
      const result = await executeCapabilityAsyncV1(execution)
      execution.validate(result)
      this.#publish(execution, result)
      if (execution.releaseBindingId != null) this.#resources.release(execution.releaseBindingId)
      return result
    } finally {
      execution.cleanup()
    }
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
  ): void {
    this.#resources.publish(
      result.value,
      execution.terminal?.resources,
      execution.providerModule,
      execution.selection,
      execution.inheritedBindingId
    )
  }
}
