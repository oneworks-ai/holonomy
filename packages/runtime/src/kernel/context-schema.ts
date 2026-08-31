import { DEVICE_PROVIDER_DESCRIPTOR_V1_SCHEMA } from '@holonomyjs/capability-device/kernel/device-schema'
import { HOST_SYSTEM_PROJECTION_V1_SCHEMA } from '@holonomyjs/capability-system/kernel/system-schema'
import { SANDBOX_POLICY_V2_SCHEMA } from './policy-schema.js'
import type { JsonSchema } from './schema-primitives.js'
import { strictObject } from './schema-primitives.js'

const withoutSchemaIdentity = (schema: JsonSchema): JsonSchema => {
  const { $id: _id, $schema: _schema, ...value } = schema
  return Object.freeze(value)
}

const contextJson: JsonSchema = Object.freeze({
  anyOf: [
    { type: 'null' },
    { type: 'boolean' },
    { type: 'number' },
    { type: 'string' },
    { items: {}, type: 'array' },
    { additionalProperties: {}, type: 'object' }
  ]
})

export const RUNTIME_CONTEXT_ENVELOPE_V1_SCHEMA = strictObject({
  guest: contextJson,
  host: contextJson,
  inspector: contextJson,
  schemaVersion: { const: 1 }
}, ['schemaVersion'])

export const RUNTIME_MODULE_LAUNCH_V1_SCHEMA = strictObject({
  entryUrl: { maxLength: 4096, minLength: 1, type: 'string' },
  moduleCount: { maximum: 100_000, minimum: 1, type: 'integer' },
  moduleGraphDigest: { pattern: '^[0-9a-f]{64}$', type: 'string' },
  moduleRootUrl: { maxLength: 4096, minLength: 1, type: 'string' },
  totalSourceBytes: { maximum: Number.MAX_SAFE_INTEGER, minimum: 0, type: 'integer' }
})

export const RUNTIME_CREATION_CONFIGURATION_V1_SCHEMA = strictObject({
  context: RUNTIME_CONTEXT_ENVELOPE_V1_SCHEMA,
  deviceProviderDescriptor: DEVICE_PROVIDER_DESCRIPTOR_V1_SCHEMA,
  inspector: strictObject({ enabled: { type: 'boolean' } }),
  launch: RUNTIME_MODULE_LAUNCH_V1_SCHEMA,
  sandboxPolicy: withoutSchemaIdentity(SANDBOX_POLICY_V2_SCHEMA),
  schemaVersion: { const: 1 },
  systemProjection: HOST_SYSTEM_PROJECTION_V1_SCHEMA
}, ['context', 'inspector', 'launch', 'sandboxPolicy', 'schemaVersion', 'systemProjection'])

const id: JsonSchema = {
  maxLength: 128,
  minLength: 1,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
  type: 'string'
}
const moduleId: JsonSchema = {
  maxLength: 128,
  minLength: 1,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$',
  type: 'string'
}
export const HOST_BINDING_REFERENCE_V1_SCHEMA = strictObject({
  bindingId: id,
  ownerId: id,
  version: { maxLength: 64, minLength: 1, type: 'string' }
})
export const PROVIDER_BINDING_REGISTRATION_V1_SCHEMA = strictObject({
  module: moduleId,
  ownerId: id,
  providerId: id,
  providerVersion: { maxLength: 64, minLength: 1, type: 'string' }
})
export const RUNTIME_CREATION_HOST_BINDINGS_V1_SCHEMA = strictObject({
  engineGate: HOST_BINDING_REFERENCE_V1_SCHEMA,
  initialMiddlewareSet: HOST_BINDING_REFERENCE_V1_SCHEMA,
  initialObservers: {
    items: HOST_BINDING_REFERENCE_V1_SCHEMA,
    maxItems: 64,
    type: 'array'
  },
  moduleResolver: HOST_BINDING_REFERENCE_V1_SCHEMA,
  providerBindings: {
    items: PROVIDER_BINDING_REGISTRATION_V1_SCHEMA,
    maxItems: 64,
    type: 'array'
  }
})
export const RUNTIME_CREATION_SPEC_V1_SCHEMA = strictObject({
  configuration: RUNTIME_CREATION_CONFIGURATION_V1_SCHEMA,
  hostBindings: RUNTIME_CREATION_HOST_BINDINGS_V1_SCHEMA
})

export const RUNTIME_CREATION_CONTRACT_V1_SCHEMA = Object.freeze({
  $defs: {
    hostBindings: RUNTIME_CREATION_HOST_BINDINGS_V1_SCHEMA,
    spec: RUNTIME_CREATION_SPEC_V1_SCHEMA
  },
  $id: 'https://oneworks.ai/holonomy/contracts/runtime-creation-v1.schema.json',
  $ref: '#/$defs/spec',
  $schema: 'https://json-schema.org/draft/2020-12/schema'
})

export const INVOCATION_SNAPSHOT_CAPABILITY_V1_SCHEMA = strictObject({
  binaryInternalSlotCopy: { const: true },
  engineIsProxyWithoutTrap: { const: true },
  guestReentryPrevented: { const: true },
  plainOwnSlotWalker: { const: true },
  schemaVersion: { const: 1 }
})
