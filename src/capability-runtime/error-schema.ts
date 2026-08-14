import { CAPABILITY_ERROR_MAP_V1 } from './error-registry.js'
import type {
  HoloGuestErrorCodeV1,
  InternalCapabilityCodeV1,
  NodeGuestErrorCodeV1,
  RuntimeAdmissionCodeV1
} from './error-registry.js'
import { strictObject } from './schema-primitives.js'

export const RUNTIME_ADMISSION_CODES_V1 = Object.freeze(
  [
    'runtime.binding_unavailable',
    'runtime.configuration_invalid',
    'runtime.policy_version_unsupported'
  ] as const satisfies readonly RuntimeAdmissionCodeV1[]
)
export const INTERNAL_CAPABILITY_CODES_V1 = Object.freeze(
  Object.keys(CAPABILITY_ERROR_MAP_V1).sort() as InternalCapabilityCodeV1[]
)
export const NODE_GUEST_ERROR_CODES_V1 = Object.freeze(
  [
    ...new Set(
      Object.values(CAPABILITY_ERROR_MAP_V1).flatMap(row => [
        row.nodeFs,
        row.nodeSystem,
        row.childProcess.default,
        row.childProcess.capturedOutput,
        row.childProcess.stdinWrite
      ]).filter((code): code is NodeGuestErrorCodeV1 => code !== undefined)
    )
  ]
    .sort() as NodeGuestErrorCodeV1[]
)
export const HOLO_GUEST_ERROR_CODES_V1 = Object.freeze(
  [...new Set(Object.values(CAPABILITY_ERROR_MAP_V1).map(row => row.holo))]
    .sort() as HoloGuestErrorCodeV1[]
)

export const CAPABILITY_ERROR_MAP_V1_SCHEMA = Object.freeze({
  $id: 'https://oneworks.ai/holonomy/contracts/capability-error-map-v1.schema.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: Object.fromEntries(INTERNAL_CAPABILITY_CODES_V1.map(code => [
    code,
    strictObject({
      childProcess: strictObject({
        capturedOutput: { enum: NODE_GUEST_ERROR_CODES_V1 },
        default: { enum: NODE_GUEST_ERROR_CODES_V1 },
        stdinWrite: { enum: NODE_GUEST_ERROR_CODES_V1 }
      }, ['default']),
      holo: { enum: HOLO_GUEST_ERROR_CODES_V1 },
      nodeFs: { enum: NODE_GUEST_ERROR_CODES_V1 },
      nodeSystem: { enum: NODE_GUEST_ERROR_CODES_V1 }
    })
  ])),
  required: INTERNAL_CAPABILITY_CODES_V1,
  type: 'object'
})
