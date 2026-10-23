// Native owns the hooks actually emitted by the Guest engine. This data-only
// leaf is shared with Service admission; it must not import Host bootstrap.
export const NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1 = Object.freeze({
  maxObserverCallbackMs: 1_000,
  maxQueuedEvents: 256
})

const EVENTS_V1 = Object.freeze([
  'gc.completed',
  'memory.pressure',
  'promise.rejected',
  'runtime.exception',
  'runtime.terminated',
  'script.compiled',
  'script.execution-finished',
  'script.execution-started'
])

export const NATIVE_RUNTIME_OBSERVER_PLATFORM_V1 = Object.freeze({
  events: Object.freeze(EVENTS_V1.map(event => {
    const script = event === 'script.compiled' || event === 'script.execution-started' ||
      event === 'script.execution-finished'
    const supported = script || event === 'runtime.exception' || event === 'runtime.terminated'
    return Object.freeze({
      cost: script ? 'high' : 'low',
      event,
      optIn: script,
      supportLevel: supported ? 'optional' : 'unsupported'
    })
  })),
  maxObserverCallbackMs: NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1.maxObserverCallbackMs,
  maxQueuedEvents: NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1.maxQueuedEvents,
  schemaVersion: 1
})
