import type { EngineHookCapabilityProbeV1 } from './engine-contract.js'

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
  metadata,
  provenance,
  schemaVersion: 1,
  strings: Object.freeze({ generationLevelDeny: true, perCompilationCallback: false }),
  wasm: Object.freeze({ generationLevelDeny: false, perCompilationCallback: false })
})
