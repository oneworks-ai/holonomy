import type { EngineHookCapabilityProbeV1 } from './engine-contract.js'
import type { RuntimeObserverPlatformDescriptorV1 } from './observer-contract.js'
import { OBSERVER_EVENTS_V1 } from './registry-types.js'

const metadata = Object.freeze({
  callsite: 'unavailable' as const,
  entryDetail: 'unavailable' as const,
  origin: 'unavailable' as const,
  source: 'unavailable' as const
})

const provenance = Object.freeze({
  generationLevel: 'behavioralProbe' as const,
  metadata: 'profileStaticUnsupported' as const,
  perCompilationCallback: 'profileStaticUnsupported' as const
})

export const STOCK_NODE_ENGINE_PROBE_V1: EngineHookCapabilityProbeV1 = Object.freeze({
  engine: 'node-vm',
  metadata,
  provenance,
  schemaVersion: 1,
  strings: Object.freeze({ generationLevelDeny: true, perCompilationCallback: false }),
  wasm: Object.freeze({ generationLevelDeny: true, perCompilationCallback: false })
})

export const ANDROID_JAVET_ENGINE_PROBE_V1: EngineHookCapabilityProbeV1 = Object.freeze({
  engine: 'android-embedded-v8',
  metadata: Object.freeze({ ...metadata, source: 'available' as const }),
  provenance: Object.freeze({
    ...provenance,
    metadata: 'behavioralProbe' as const,
    perCompilationCallback: 'behavioralProbe' as const
  }),
  schemaVersion: 1,
  strings: Object.freeze({ generationLevelDeny: true, perCompilationCallback: true }),
  wasm: Object.freeze({ generationLevelDeny: true, perCompilationCallback: true })
})

export const NODE_NATIVE_ENGINE_PROBE_V1: EngineHookCapabilityProbeV1 = Object.freeze({
  engine: 'node-vm',
  metadata: Object.freeze({ ...metadata, source: 'available' as const }),
  provenance: Object.freeze({
    ...provenance,
    metadata: 'behavioralProbe' as const,
    perCompilationCallback: 'behavioralProbe' as const
  }),
  schemaVersion: 1,
  strings: Object.freeze({ generationLevelDeny: true, perCompilationCallback: true }),
  wasm: Object.freeze({ generationLevelDeny: true, perCompilationCallback: true })
})

export const NODE_RUNTIME_OBSERVER_PLATFORM_V1: RuntimeObserverPlatformDescriptorV1 = Object.freeze({
  events: Object.freeze(OBSERVER_EVENTS_V1.map(event =>
    Object.freeze({
      cost: 'low' as const,
      event,
      optIn: false,
      supportLevel: (
          event === 'runtime.exception' || event === 'runtime.terminated' || event === 'script.compiled'
        )
        ? 'required' as const
        : 'unsupported' as const
    })
  )),
  maxObserverCallbackMs: 120_000,
  maxQueuedEvents: 4096,
  schemaVersion: 1
})
