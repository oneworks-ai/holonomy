import {
  CAPABILITY_DEFINITION_REGISTRY_V1_SCHEMA,
  CAPABILITY_SELECTION_CONTRACT_V1_SCHEMA
} from './capability-schema.js'
import { RUNTIME_CREATION_CONFIGURATION_V1_SCHEMA, RUNTIME_CREATION_CONTRACT_V1_SCHEMA } from './context-schema.js'
import { CORE_CONTRACT_V1_SCHEMA } from './core-contract-schema.js'
import { DEVICE_CONTRACT_V1_SCHEMA } from './device-schema.js'
import { ENGINE_GATE_CONTRACT_V1_SCHEMA, ENGINE_HOOK_CAPABILITY_PROBE_V1_SCHEMA } from './engine-observer-schema.js'
import { CAPABILITY_ERROR_MAP_V1_SCHEMA } from './error-schema.js'
import { INVOCATION_SNAPSHOT_ENVELOPE_V1_SCHEMA } from './invocation-snapshot-schema.js'
import { OBSERVER_CONTRACT_V1_SCHEMA } from './observer-schema.js'
import { OPERATION_REGISTRY_V1_SCHEMA } from './operation-schema.js'
import { SANDBOX_POLICY_V2_SCHEMA } from './policy-schema.js'
import { PROCESS_BACKEND_PROBE_EVIDENCE_V1_SCHEMA } from './process-backend-probe-schema.js'
import { PROCESS_BACKEND_DESCRIPTOR_V1_SCHEMA } from './process-backend.js'
import { RESOLUTION_CONTRACT_V1_SCHEMA } from './resolution-schema.js'
import { CANONICAL_RESOURCE_V1_SCHEMA } from './resource-schema.js'
import { HOST_SYSTEM_PROJECTION_V1_SCHEMA } from './system-schema.js'

export const CAPABILITY_MACHINE_SCHEMA_ARTIFACTS_V1 = Object.freeze({
  'canonical-resource-v1.schema.json': CANONICAL_RESOURCE_V1_SCHEMA,
  'capability-definition-registry-v1.schema.json': CAPABILITY_DEFINITION_REGISTRY_V1_SCHEMA,
  'capability-selection-v1.schema.json': CAPABILITY_SELECTION_CONTRACT_V1_SCHEMA,
  'core-contract-v1.schema.json': CORE_CONTRACT_V1_SCHEMA,
  'capability-error-map-v1.schema.json': CAPABILITY_ERROR_MAP_V1_SCHEMA,
  'device-contract-v1.schema.json': DEVICE_CONTRACT_V1_SCHEMA,
  'engine-gate-v1.schema.json': ENGINE_GATE_CONTRACT_V1_SCHEMA,
  'engine-hook-capability-v1.schema.json': ENGINE_HOOK_CAPABILITY_PROBE_V1_SCHEMA,
  'host-system-projection-v1.schema.json': HOST_SYSTEM_PROJECTION_V1_SCHEMA,
  'invocation-snapshot-v1.schema.json': INVOCATION_SNAPSHOT_ENVELOPE_V1_SCHEMA,
  'observer-contract-v1.schema.json': OBSERVER_CONTRACT_V1_SCHEMA,
  'operation-registry-v1.schema.json': OPERATION_REGISTRY_V1_SCHEMA,
  'process-backend-v1.schema.json': PROCESS_BACKEND_DESCRIPTOR_V1_SCHEMA,
  'process-backend-probe-v1.schema.json': PROCESS_BACKEND_PROBE_EVIDENCE_V1_SCHEMA,
  'resource-resolution-v1.schema.json': RESOLUTION_CONTRACT_V1_SCHEMA,
  'runtime-creation-configuration-v1.schema.json': RUNTIME_CREATION_CONFIGURATION_V1_SCHEMA,
  'runtime-creation-v1.schema.json': RUNTIME_CREATION_CONTRACT_V1_SCHEMA,
  'sandbox-policy-v2.schema.json': SANDBOX_POLICY_V2_SCHEMA
})
