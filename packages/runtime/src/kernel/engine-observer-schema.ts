import { ENGINE_GATE_OPERATIONS_V1 } from './engine-contract.js'
import { integerSchema, strictObject } from './schema-primitives.js'

const availability = { enum: ['exact', 'unavailable'] }
const gateFlags = strictObject({
  generationLevelDeny: { type: 'boolean' },
  perCompilationCallback: { type: 'boolean' }
})

export const ENGINE_HOOK_CAPABILITY_PROBE_V1_SCHEMA = Object.freeze({
  $id: 'https://oneworks.ai/holonomy/contracts/engine-hook-capability-v1.schema.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  ...strictObject({
    engine: { enum: ['android-embedded-v8', 'node-vm'] },
    metadata: strictObject({
      callsite: availability,
      entryDetail: availability,
      origin: availability,
      source: { enum: ['available', 'unavailable'] }
    }),
    provenance: strictObject({
      generationLevel: { const: 'behavioralProbe' },
      metadata: { const: 'profileStaticUnsupported' },
      perCompilationCallback: { const: 'profileStaticUnsupported' }
    }),
    schemaVersion: { const: 1 },
    strings: gateFlags,
    wasm: gateFlags
  })
})

const opaqueId = { maxLength: 128, minLength: 1, pattern: '^[a-zA-Z0-9._:-]+$', type: 'string' }
const digest = { pattern: '^[0-9a-f]{64}$', type: 'string' }
const metadataSupport = strictObject({
  callsite: availability,
  entryDetail: availability,
  origin: availability,
  source: { enum: ['available', 'unavailable'] }
})
const gateRequest = strictObject({
  callsite: strictObject({
    column: integerSchema(1, 10_000_000),
    line: integerSchema(1, 10_000_000),
    moduleUrl: { maxLength: 4096, minLength: 1, type: 'string' }
  }, ['moduleUrl']),
  codeKind: { enum: ['module', 'strings', 'wasm'] },
  entryDetail: strictObject({
    kind: {
      enum: [
        'debuggerSetScriptSource',
        'dynamicImport',
        'inspectorCallFunction',
        'inspectorCompile',
        'inspectorEvaluate',
        'inspectorRunScript'
      ]
    },
    source: { enum: ['inspector', 'loader', 'trustedWrapper'] }
  }),
  metadataSupport,
  operation: { enum: ENGINE_GATE_OPERATIONS_V1 },
  origin: { maxLength: 4096, minLength: 1, type: 'string' },
  requestId: opaqueId,
  runtime: strictObject({
    generation: integerSchema(1, Number.MAX_SAFE_INTEGER),
    policyDigest: digest,
    processId: opaqueId
  }),
  schemaVersion: { const: 1 },
  sourceBytes: integerSchema(0, 16 * 1024 * 1024),
  sourceSha256: digest
}, ['codeKind', 'metadataSupport', 'operation', 'requestId', 'runtime', 'schemaVersion'])

const metadataConditional = (field: string, available: string, dependent: readonly string[]) => ({
  else: {
    not: {
      anyOf: dependent.map(name => ({ properties: { [name]: {} }, required: [name], type: 'object' }))
    }
  },
  if: {
    properties: {
      metadataSupport: {
        properties: { [field]: { const: available } },
        required: [field],
        type: 'object'
      }
    },
    required: ['metadataSupport'],
    type: 'object'
  },
  then: {
    properties: Object.fromEntries(dependent.map(name => [name, {}])),
    required: [...dependent],
    type: 'object'
  }
})

export const ENGINE_GATE_CONTRACT_V1_SCHEMA = Object.freeze({
  $defs: {
    decision: {
      oneOf: [
        strictObject({ action: { const: 'allow' } }),
        strictObject({ action: { const: 'deny' }, reasonCode: opaqueId })
      ]
    },
    request: {
      ...gateRequest,
      allOf: [
        {
          oneOf: [
            {
              properties: { codeKind: { const: 'strings' }, operation: { const: 'runtime.code.generate.strings' } },
              required: ['codeKind', 'operation'],
              type: 'object'
            },
            {
              properties: { codeKind: { const: 'wasm' }, operation: { const: 'runtime.code.generate.wasm' } },
              required: ['codeKind', 'operation'],
              type: 'object'
            },
            {
              properties: { codeKind: { const: 'module' }, operation: { const: 'runtime.module.import' } },
              required: ['codeKind', 'operation'],
              type: 'object'
            }
          ]
        },
        metadataConditional('source', 'available', ['sourceBytes', 'sourceSha256']),
        metadataConditional('origin', 'exact', ['origin']),
        metadataConditional('entryDetail', 'exact', ['entryDetail']),
        metadataConditional('callsite', 'exact', ['callsite'])
      ]
    }
  },
  $id: 'https://oneworks.ai/holonomy/contracts/engine-gate-v1.schema.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema'
})
