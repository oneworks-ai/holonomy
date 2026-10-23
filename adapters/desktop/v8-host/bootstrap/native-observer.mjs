import { RuntimeObserverRegistryV1 } from '../../../../packages/runtime/src/kernel/index.ts'
import {
  NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1,
  NATIVE_RUNTIME_OBSERVER_PLATFORM_V1
} from './native-observer-platform.mjs'

export { NATIVE_RUNTIME_OBSERVER_PLATFORM_V1 } from './native-observer-platform.mjs'

export const createNativeRuntimeObserver = (policy, native) => {
  const registry = new RuntimeObserverRegistryV1({
    generation: 1,
    hostCaps: NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1,
    onDiagnostic: diagnostic => native.observerDiagnostic(diagnostic.kind, diagnostic.event ?? ''),
    scheduleTimeout: (callback, delay) => native.scheduleUnreferenced(callback, delay),
    cancelTimeout: id => native.clear(id),
    platform: NATIVE_RUNTIME_OBSERVER_PLATFORM_V1,
    policy: policy.diagnostics
  })
  return Object.freeze({
    close: () => registry.close(),
    observe: (registration, callback) => registry.subscribe(registration, callback),
    publish: encoded => {
      // The owned Rust message contains only this closed event name and a
      // bounded, source-free payload. The shared normalizer freezes it again.
      try {
        const input = JSON.parse(encoded)
        registry.publish(input.event, input.payload)
      } catch {
        // Observer delivery is an isolated, lossy Host diagnostic side channel.
      }
    }
  })
}
