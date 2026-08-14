import { PROCESS_BACKEND_PROBE_CAPABILITIES_V1 } from './process-backend-probe.js'
import type { JsonSchema } from './schema-primitives.js'
import { integerSchema, strictObject } from './schema-primitives.js'

const IDENTIFIER_SCHEMA: JsonSchema = {
  maxLength: 128,
  minLength: 1,
  pattern: '^[A-Za-z0-9][\\w.+-]*$',
  type: 'string'
}

const observationSchema = (
  status: 'failed' | 'notRun' | 'passed' | 'unsupported',
  provenance: readonly string[],
  reason: boolean
): JsonSchema =>
  strictObject({
    capability: { enum: PROCESS_BACKEND_PROBE_CAPABILITIES_V1 },
    provenance: { enum: provenance },
    reasonCode: IDENTIFIER_SCHEMA,
    status: { const: status }
  }, reason ? ['capability', 'provenance', 'reasonCode', 'status'] : ['capability', 'provenance', 'status'])

const OBSERVATION_SCHEMA: JsonSchema = {
  oneOf: [
    observationSchema('passed', ['behavioralProbe'], false),
    observationSchema('failed', ['behavioralProbe'], true),
    observationSchema('unsupported', ['behavioralProbe', 'profileStaticUnsupported', 'upstreamContract'], true),
    observationSchema('notRun', ['profileStaticUnsupported', 'upstreamContract'], true)
  ]
}

export const PROCESS_BACKEND_PROBE_EVIDENCE_V1_SCHEMA: JsonSchema = strictObject({
  artifact: strictObject({
    artifactKind: { enum: ['npm', 'source', 'wasm'] },
    artifactVersion: IDENTIFIER_SCHEMA,
    integritySha256: { pattern: '^[0-9a-f]{64}$', type: 'string' },
    license: IDENTIFIER_SCHEMA,
    sourceRevision: IDENTIFIER_SCHEMA
  }, ['artifactKind', 'artifactVersion', 'license']),
  backendId: IDENTIFIER_SCHEMA,
  host: strictObject({
    architecture: { enum: ['arm64', 'x64', 'x86'] },
    engine: { enum: ['javet-v8', 'node-v8'] },
    engineVersion: IDENTIFIER_SCHEMA,
    platform: { enum: ['android', 'darwin', 'linux', 'win32'] },
    runtimeVersion: IDENTIFIER_SCHEMA
  }),
  metrics: strictObject({
    bootDurationMs: integerSchema(0, 86_400_000),
    peakRssBytes: integerSchema(0, 137_438_953_472),
    workloadDurationMs: integerSchema(0, 86_400_000)
  }, []),
  observations: {
    items: OBSERVATION_SCHEMA,
    maxItems: PROCESS_BACKEND_PROBE_CAPABILITIES_V1.length,
    minItems: PROCESS_BACKEND_PROBE_CAPABILITIES_V1.length,
    type: 'array'
  },
  schemaVersion: { const: 1 }
})
