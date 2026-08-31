import type { SandboxPolicyV2 } from './sandbox-policy.js'

const none = Object.freeze({ access: 'none' as const })

export const DEFAULT_SANDBOX_POLICY_V2: SandboxPolicyV2 = Object.freeze({
  codeGeneration: Object.freeze({ dynamicImport: none, strings: none, wasm: none }),
  device: Object.freeze({
    defaultAccess: 'deny',
    maxEventsPerSecond: 1,
    maxQueuedEvents: 0,
    maxSubscriptions: 0,
    operations: Object.freeze({})
  }),
  diagnostics: Object.freeze({
    maxObserverCallbackMs: 1,
    maxQueuedEvents: 0,
    maxSourceReadBytes: 0,
    observerEvents: Object.freeze([]),
    retentionMs: 0,
    sourceReader: 'none'
  }),
  filesystem: none,
  inspector: Object.freeze({
    callFunctionOn: false,
    compileScript: false,
    evaluate: false,
    runScript: false,
    setScriptSource: false
  }),
  network: none,
  process: none,
  schemaVersion: 2,
  systemInformation: Object.freeze({ defaultMode: 'unavailable', fields: Object.freeze({}) })
})
