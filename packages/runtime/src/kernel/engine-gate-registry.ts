import { normalizeEngineGateRequestMetadataV1 } from './engine-contract.js'
import { dispatchEngineGateV1, engineGateDenyV1 } from './engine-gate-dispatch.js'
import type { EngineGateMiddlewareV1, EngineSourceReaderV1 } from './engine-gate-dispatch.js'
import type { EngineGateDecisionV1 } from './engine-types.js'
import type { DisposableV1 } from './interceptor-registry.js'

export interface EngineGatePluginScopeV1 extends DisposableV1 {
  readonly instanceId: string
  snapshot(): readonly EngineGateMiddlewareV1[]
  use(middleware: EngineGateMiddlewareV1): DisposableV1
}

/** A separate pipeline owned by the same plugin app/revision, never a second app. */
export class RuntimeEngineGateRegistryV1 {
  readonly #owners = new WeakSet<EngineGatePluginScopeV1>()
  readonly #inflight = new Map<number, number>()
  readonly #waiters = new Map<number, Set<() => void>>()
  readonly #controllers = new Set<AbortController>()
  #revision = 0
  #scopes: readonly EngineGatePluginScopeV1[] = []
  #closed = false

  createPluginScope(instanceId: string): EngineGatePluginScopeV1 {
    if (this.#closed || !/^[A-Za-z0-9][\w.-]{0,127}$/u.test(instanceId)) {
      throw new TypeError('Invalid Engine Gate scope')
    }
    const handlers = new Set<EngineGateMiddlewareV1>()
    let closed = false
    const scope = Object.freeze({
      instanceId,
      snapshot: () => Object.freeze([...handlers]),
      use: (middleware: EngineGateMiddlewareV1) => {
        if (this.#closed || closed || typeof middleware !== 'function' || handlers.size >= 32) {
          throw new TypeError('Invalid Engine Gate middleware')
        }
        if (handlers.has(middleware)) throw new TypeError('Duplicate Engine Gate middleware')
        handlers.add(middleware)
        return Object.freeze({
          dispose: () => {
            handlers.delete(middleware)
          }
        })
      },
      dispose: () => {
        closed = true
        handlers.clear()
      }
    })
    this.#owners.add(scope)
    return scope
  }

  preparePluginGraph(revision: number, scopes: readonly EngineGatePluginScopeV1[]): () => void {
    if (
      this.#closed || revision !== this.#revision + 1 ||
      scopes.length > 128 || scopes.some(scope => !this.#owners.has(scope)) ||
      new Set(scopes.map(scope => scope.instanceId)).size !== scopes.length
    ) throw new TypeError('Invalid Engine Gate plugin graph')
    const snapshot = Object.freeze([...scopes])
    const before = this.#revision
    return () => {
      if (this.#closed || this.#revision !== before) throw new Error('Stale Engine Gate publication')
      this.#revision = revision
      this.#scopes = snapshot
    }
  }

  drainPluginGraph(revision: number): Promise<void> {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= this.#revision) {
      throw new TypeError('Invalid Engine Gate drain revision')
    }
    if (!this.#inflight.has(revision)) return Promise.resolve()
    return new Promise(resolve => {
      const waiters = this.#waiters.get(revision) ?? new Set()
      waiters.add(resolve)
      this.#waiters.set(revision, waiters)
    })
  }

  async decide(
    input: unknown,
    signal: AbortSignal,
    sourceReader?: EngineSourceReaderV1
  ): Promise<EngineGateDecisionV1> {
    if (this.#closed) return engineGateDenyV1('runtime.cancelled')
    if (this.#controllers.size >= 32) return engineGateDenyV1('runtime.gate_limit')
    const request = normalizeEngineGateRequestMetadataV1(input)
    const handlers = this.#scopes.flatMap(scope => scope.snapshot())
    if (handlers.length > 128) return engineGateDenyV1('runtime.gate_limit')
    const revision = this.#revision
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    this.#controllers.add(controller)
    this.#inflight.set(revision, (this.#inflight.get(revision) ?? 0) + 1)
    const execution = dispatchEngineGateV1(request, controller.signal, handlers, sourceReader)
    const release = () => {
      signal.removeEventListener('abort', abort)
      this.#controllers.delete(controller)
      const remaining = this.#inflight.get(revision)! - 1
      if (remaining > 0) this.#inflight.set(revision, remaining)
      else {
        this.#inflight.delete(revision)
        const waiters = this.#waiters.get(revision)
        this.#waiters.delete(revision)
        waiters?.forEach(resolve => resolve())
      }
    }
    void execution.settled.then(release, release)
    const decision = await execution.decision
    if (decision.action === 'deny') controller.abort()
    return decision
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const controller of this.#controllers) controller.abort()
    this.#scopes = []
  }
}
