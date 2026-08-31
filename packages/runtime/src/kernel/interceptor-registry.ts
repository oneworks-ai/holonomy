import { compileInitialMiddlewareSetV1 } from './broker-matcher.js'
import type {
  CapabilityMiddlewareExecutionV1,
  HoloInvocationMatcherV1,
  HoloMiddlewareRegistrationV1,
  HoloMiddlewareV1
} from './broker-types.js'

export interface DisposableV1 {
  dispose(): void
}

export interface RuntimePluginInterceptorScopeV1<THostContext> extends DisposableV1 {
  readonly instanceId: string
  snapshot(): readonly HoloMiddlewareRegistrationV1<THostContext>[]
  use(
    matcher: HoloInvocationMatcherV1,
    middleware: HoloMiddlewareV1<THostContext>,
    options?: Readonly<{
      execution?: CapabilityMiddlewareExecutionV1
      timeoutMs?: number
    }>
  ): DisposableV1
}

export interface RuntimeInterceptorSnapshotV1<THostContext> {
  readonly pluginGraphRevision: number
  readonly registrations: readonly HoloMiddlewareRegistrationV1<THostContext>[]
  release(): void
}

export class RuntimeInterceptorRegistryV1<THostContext> {
  readonly #drainWaiters = new Map<number, Set<() => void>>()
  readonly #inflight = new Map<number, number>()
  #next = 0
  #pluginGraphRevision = 0
  #pluginScopes: readonly RuntimePluginInterceptorScopeV1<THostContext>[] = Object.freeze([])
  readonly #registrations = new Map<string, HoloMiddlewareRegistrationV1<THostContext>>()

  snapshot(): readonly HoloMiddlewareRegistrationV1<THostContext>[] {
    return Object.freeze([
      ...this.#registrations.values(),
      ...this.#pluginScopes.flatMap(scope => scope.snapshot())
    ])
  }

  acquireSnapshot(): RuntimeInterceptorSnapshotV1<THostContext> {
    const revision = this.#pluginGraphRevision
    this.#inflight.set(revision, (this.#inflight.get(revision) ?? 0) + 1)
    let released = false
    return Object.freeze({
      pluginGraphRevision: revision,
      registrations: this.snapshot(),
      release: () => {
        if (released) return
        released = true
        const remaining = (this.#inflight.get(revision) ?? 1) - 1
        if (remaining > 0) {
          this.#inflight.set(revision, remaining)
          return
        }
        this.#inflight.delete(revision)
        const waiters = this.#drainWaiters.get(revision)
        this.#drainWaiters.delete(revision)
        waiters?.forEach(resolve => resolve())
      }
    })
  }

  createPluginScope(instanceId: string): RuntimePluginInterceptorScopeV1<THostContext> {
    if (!/^[A-Za-z0-9][\w.-]{0,127}$/u.test(instanceId)) {
      throw new TypeError('Runtime plugin instance id is invalid')
    }
    const registrations = new Map<string, HoloMiddlewareRegistrationV1<THostContext>>()
    let closed = false
    let next = 0
    const use: RuntimePluginInterceptorScopeV1<THostContext>['use'] = (
      matcher,
      middleware,
      options = {}
    ) => {
      if (closed) throw new Error('Runtime plugin interceptor scope is closed')
      const registrationId = `plugin-${instanceId}-${++next}`
      const registration = compileInitialMiddlewareSetV1<THostContext>({
        registrations: [{
          execution: options.execution ?? 'async',
          layer: 'application',
          matcher,
          middleware,
          registrationId,
          ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs })
        }],
        schemaVersion: 1
      }).registrations[0]!
      registrations.set(registrationId, registration)
      let disposed = false
      return Object.freeze({
        dispose: () => {
          if (disposed) return
          disposed = true
          registrations.delete(registrationId)
        }
      })
    }
    return Object.freeze({
      dispose: () => {
        if (closed) return
        closed = true
        registrations.clear()
      },
      instanceId,
      snapshot: () => Object.freeze([...registrations.values()]),
      use
    })
  }

  publishPluginGraph(
    revision: number,
    scopes: readonly RuntimePluginInterceptorScopeV1<THostContext>[]
  ): void {
    if (!Number.isSafeInteger(revision) || revision !== this.#pluginGraphRevision + 1) {
      throw new TypeError('Runtime plugin graph revision is invalid')
    }
    if (
      new Set(scopes).size !== scopes.length || new Set(scopes.map(scope => scope.instanceId)).size !== scopes.length
    ) {
      throw new TypeError('Runtime plugin interceptor scopes are duplicated')
    }
    this.#pluginScopes = Object.freeze([...scopes])
    this.#pluginGraphRevision = revision
  }

  drainPluginGraph(revision: number): Promise<void> {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= this.#pluginGraphRevision) {
      throw new TypeError('Runtime plugin drain revision is invalid')
    }
    if (!this.#inflight.has(revision)) return Promise.resolve()
    return new Promise(resolve => {
      const waiters = this.#drainWaiters.get(revision) ?? new Set()
      waiters.add(resolve)
      this.#drainWaiters.set(revision, waiters)
    })
  }

  use(
    matcher: HoloInvocationMatcherV1,
    middleware: HoloMiddlewareV1<THostContext>,
    options: Readonly<{
      execution?: CapabilityMiddlewareExecutionV1
      timeoutMs?: number
    }> = {}
  ): DisposableV1 {
    const registrationId = `live-${++this.#next}`
    const registration = compileInitialMiddlewareSetV1<THostContext>({
      registrations: [{
        execution: options.execution ?? 'async',
        layer: 'application',
        matcher,
        middleware,
        registrationId,
        ...(options.timeoutMs == null ? {} : { timeoutMs: options.timeoutMs })
      }],
      schemaVersion: 1
    }).registrations[0]!
    this.#registrations.set(registrationId, registration)
    let disposed = false
    return Object.freeze({
      dispose: () => {
        if (disposed) return
        disposed = true
        this.#registrations.delete(registrationId)
      }
    })
  }
}
