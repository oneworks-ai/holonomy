import type { DisposableV1 } from './interceptor-registry.js'
import type { NormalizedRuntimeObserverAdmissionV1, RuntimeObserverPlatformDescriptorV1 } from './observer-contract.js'
import type { RuntimeObserverEventV1 } from './observer-events.js'
import type { RuntimeObserverSelectableEventNameV1 } from './registry-types.js'
import type {
  RuntimeObserverDiagnosticV1,
  RuntimeObserverRegistryV1,
  RuntimeObserverV1
} from './runtime-observer-registry.js'

export interface DroppedRuntimeObserverEventsV1 extends Record<string, unknown> {
  dropped: number
  droppedByEvent: Partial<Record<RuntimeObserverSelectableEventNameV1, number>>
  firstDroppedSequence: number
  lastDroppedSequence: number
}

export class RuntimeObserverSubscriptionV1 implements DisposableV1 {
  readonly #admission: NormalizedRuntimeObserverAdmissionV1
  readonly #diagnostic: (diagnostic: RuntimeObserverDiagnosticV1) => void
  readonly #observer: RuntimeObserverV1
  readonly #registry: RuntimeObserverRegistryV1
  readonly #support: ReadonlyMap<RuntimeObserverSelectableEventNameV1, 'optional' | 'required'>
  readonly #scheduleTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly #cancelTimeout: (handle: ReturnType<typeof setTimeout>) => void
  #active = true
  #dropped?: DroppedRuntimeObserverEventsV1
  #inflight = false
  #overflow?: RuntimeObserverEventV1
  #queue: RuntimeObserverEventV1[] = []
  #running = false
  #timeout?: ReturnType<typeof setTimeout>
  #cancelInflight?: () => void

  constructor(
    registry: RuntimeObserverRegistryV1,
    admission: NormalizedRuntimeObserverAdmissionV1,
    observer: RuntimeObserverV1,
    platform: RuntimeObserverPlatformDescriptorV1,
    diagnostic: (diagnostic: RuntimeObserverDiagnosticV1) => void,
    scheduleTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>,
    cancelTimeout: (handle: ReturnType<typeof setTimeout>) => void
  ) {
    this.#admission = admission
    this.#diagnostic = diagnostic
    this.#scheduleTimeout = scheduleTimeout
    this.#cancelTimeout = cancelTimeout
    this.#observer = observer
    this.#registry = registry
    this.#support = new Map(
      platform.events
        .filter(item => item.supportLevel !== 'unsupported')
        .map(item => [item.event, item.supportLevel as 'optional' | 'required'] as const)
    )
  }

  accepts(event: RuntimeObserverSelectableEventNameV1): boolean {
    return this.#active && this.#admission.events.includes(event)
  }

  dispose(): void {
    if (!this.#active) return
    this.#active = false
    this.#queue = []
    this.#dropped = undefined
    this.#overflow = undefined
    this.#cancelInflight?.()
    this.#registry.remove(this)
  }

  enqueue(event: RuntimeObserverEventV1): void {
    if (!this.#active) return
    const occupied = this.#queue.length + (this.#inflight ? 1 : 0)
    if (occupied >= this.#admission.maxQueuedEvents) {
      const optional = this.#queue.findIndex(item =>
        item.event !== 'observer.overflow' && this.#support.get(item.event) === 'optional'
      )
      const nonTerminal = this.#queue.findIndex(item => item.event !== 'runtime.terminated')
      const index = optional >= 0 ? optional : nonTerminal
      if (index >= 0) this.#recordDrop(this.#queue.splice(index, 1)[0]!)
      else {
        this.#recordDrop(event)
        this.#schedule()
        return
      }
    }
    this.#queue.push(event)
    this.#schedule()
  }

  #recordDrop(event: RuntimeObserverEventV1): void {
    if (event.event === 'observer.overflow') return
    if (this.#dropped == null) {
      this.#dropped = {
        dropped: 1,
        droppedByEvent: { [event.event]: 1 },
        firstDroppedSequence: event.sequence,
        lastDroppedSequence: event.sequence
      }
      this.#overflow = this.#registry.createOverflow(this.#dropped)
      this.#diagnostic({ event: event.event, kind: 'event.dropped' })
      return
    }
    this.#dropped.dropped += 1
    this.#dropped.droppedByEvent[event.event] = (this.#dropped.droppedByEvent[event.event] ?? 0) + 1
    this.#dropped.firstDroppedSequence = Math.min(this.#dropped.firstDroppedSequence, event.sequence)
    this.#dropped.lastDroppedSequence = Math.max(this.#dropped.lastDroppedSequence, event.sequence)
    this.#overflow = this.#registry.updateOverflow(this.#overflow!, this.#dropped)
    this.#diagnostic({ event: event.event, kind: 'event.dropped' })
  }

  #schedule(): void {
    if (this.#running || !this.#active) return
    this.#running = true
    queueMicrotask(() => void this.#drain())
  }

  async #drain(): Promise<void> {
    while (this.#active) {
      const queued = this.#queue[0]
      const overflow = this.#overflow
      const event = overflow != null && (queued == null || overflow.sequence < queued.sequence)
        ? (() => {
          this.#overflow = undefined
          this.#dropped = undefined
          return overflow
        })()
        : this.#queue.shift()
      if (event == null) break
      this.#inflight = true
      const callback = Promise.resolve().then(() => this.#observer(event))
      const outcome = await new Promise<'disposed' | 'failed' | 'settled' | 'timeout'>(resolve => {
        let settled = false
        const finish = (result: 'disposed' | 'failed' | 'settled' | 'timeout') => {
          if (settled) return
          settled = true
          if (this.#timeout != null) this.#cancelTimeout(this.#timeout)
          this.#timeout = undefined
          this.#cancelInflight = undefined
          resolve(result)
        }
        this.#cancelInflight = () => finish('disposed')
        this.#timeout = this.#scheduleTimeout(() => finish('timeout'), this.#admission.callbackTimeoutMs)
        void callback.then(() => finish('settled'), () => finish('failed'))
      })
      if (this.#active && outcome === 'failed') this.#diagnostic({ event: event.event, kind: 'callback.failed' })
      if (this.#active && outcome === 'timeout') this.#diagnostic({ event: event.event, kind: 'callback.timeout' })
      this.#inflight = false
    }
    this.#inflight = false
    this.#running = false
    if (this.#active && (this.#queue.length > 0 || this.#overflow != null)) this.#schedule()
  }
}
