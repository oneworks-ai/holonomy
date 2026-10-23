import type { DisposableV1 } from './interceptor-registry.js'
import { compileRuntimeObserverAdmissionV1, compileRuntimeObserverPlatformDescriptorV1 } from './observer-contract.js'
import type { RuntimeObserverPlatformDescriptorV1, RuntimeObserverRegistrationV1 } from './observer-contract.js'
import { normalizeRuntimeObserverEventV1 } from './observer-events.js'
import type { RuntimeObserverEventV1 } from './observer-events.js'
import type { RuntimeObserverSelectableEventNameV1 } from './registry-types.js'
import { RuntimeObserverSubscriptionV1 } from './runtime-observer-subscription.js'
import type { DroppedRuntimeObserverEventsV1 } from './runtime-observer-subscription.js'

export type RuntimeObserverV1 = (event: RuntimeObserverEventV1) => Promise<void> | void

export type RuntimeObserverDiagnosticV1 = Readonly<{
  event?: RuntimeObserverEventV1['event']
  kind: 'callback.failed' | 'callback.timeout' | 'event.dropped'
}>

export interface RuntimeObserverRegistryOptionsV1 {
  readonly generation: number
  readonly hostCaps: Readonly<{ maxObserverCallbackMs: number; maxQueuedEvents: number }>
  readonly now?: () => number
  readonly onDiagnostic?: (diagnostic: RuntimeObserverDiagnosticV1) => void
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly cancelTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  readonly platform: RuntimeObserverPlatformDescriptorV1
  readonly policy: Readonly<{
    maxObserverCallbackMs: number
    maxQueuedEvents: number
    observerEvents: readonly RuntimeObserverSelectableEventNameV1[]
  }>
}

export class RuntimeObserverRegistryV1 {
  readonly #diagnostic: (diagnostic: RuntimeObserverDiagnosticV1) => void
  readonly #generation: number
  readonly #hostCaps: RuntimeObserverRegistryOptionsV1['hostCaps']
  readonly #now: () => number
  readonly #platform: RuntimeObserverPlatformDescriptorV1
  readonly #policy: RuntimeObserverRegistryOptionsV1['policy']
  readonly #scheduleTimeout: NonNullable<RuntimeObserverRegistryOptionsV1['scheduleTimeout']>
  readonly #cancelTimeout: NonNullable<RuntimeObserverRegistryOptionsV1['cancelTimeout']>
  readonly #subscriptions = new Set<RuntimeObserverSubscriptionV1>()
  #closed = false
  #sequence = 0

  constructor(options: RuntimeObserverRegistryOptionsV1) {
    if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
      throw new TypeError('Runtime Observer generation is invalid')
    }
    this.#generation = options.generation
    this.#hostCaps = Object.freeze({ ...options.hostCaps })
    this.#now = options.now ?? (() => performance.now())
    this.#platform = compileRuntimeObserverPlatformDescriptorV1(options.platform)
    this.#policy = Object.freeze({ ...options.policy })
    this.#scheduleTimeout = options.scheduleTimeout ?? setTimeout
    this.#cancelTimeout = options.cancelTimeout ?? clearTimeout
    this.#diagnostic = diagnostic => {
      try {
        options.onDiagnostic?.(Object.freeze(diagnostic))
      } catch {
        // Observer diagnostics are also an isolated, lossy side channel.
      }
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const subscription of [...this.#subscriptions]) subscription.dispose()
  }

  publish(
    event: RuntimeObserverSelectableEventNameV1,
    payload: Readonly<Record<string, unknown>>,
    correlationId?: string
  ): RuntimeObserverEventV1 | undefined {
    if (this.#closed) return undefined
    const envelope = this.#event(event, payload, correlationId)
    for (const subscription of this.#subscriptions) {
      if (subscription.accepts(event)) subscription.enqueue(envelope)
    }
    return envelope
  }

  remove(subscription: RuntimeObserverSubscriptionV1): void {
    this.#subscriptions.delete(subscription)
  }

  subscribe(registration: RuntimeObserverRegistrationV1, observer: RuntimeObserverV1): DisposableV1 {
    if (this.#closed) throw new Error('Runtime Observer registry is closed')
    if (typeof observer !== 'function') throw new TypeError('Runtime Observer callback is invalid')
    const admission = compileRuntimeObserverAdmissionV1(
      registration,
      this.#policy,
      this.#platform,
      this.#hostCaps
    )
    const subscription = new RuntimeObserverSubscriptionV1(
      this,
      admission,
      observer,
      this.#platform,
      this.#diagnostic,
      this.#scheduleTimeout,
      this.#cancelTimeout
    )
    this.#subscriptions.add(subscription)
    return Object.freeze({ dispose: () => subscription.dispose() })
  }

  createOverflow(dropped: DroppedRuntimeObserverEventsV1): RuntimeObserverEventV1 {
    return this.#event('observer.overflow', dropped)
  }

  updateOverflow(
    event: RuntimeObserverEventV1,
    dropped: DroppedRuntimeObserverEventsV1
  ): RuntimeObserverEventV1 {
    return normalizeRuntimeObserverEventV1({ ...event, payload: dropped })
  }

  #event(
    event: RuntimeObserverEventV1['event'],
    payload: Readonly<Record<string, unknown>>,
    correlationId?: string
  ): RuntimeObserverEventV1 {
    return normalizeRuntimeObserverEventV1({
      ...(correlationId == null ? {} : { correlationId }),
      event,
      generation: this.#generation,
      observedAt: this.#now(),
      payload,
      schemaVersion: 1,
      sequence: ++this.#sequence
    })
  }
}
