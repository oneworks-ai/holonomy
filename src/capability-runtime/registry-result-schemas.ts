import {
  DEVICE_SUBSCRIPTION_RESOURCE_V1_SCHEMA,
  DEVICE_SUMMARY_V1_SCHEMA,
  deviceReadingSchemaV1
} from './device-schema.js'
import type { DeviceValueOperationV1 } from './device-types.js'
import { REGISTRY_EVENT_SCHEMAS_V1 } from './registry-event-schemas.js'
import { NETWORK_HEADER_VIEW_V1_SCHEMA } from './registry-network-argument-schemas.js'
import {
  BINARY_SCHEMA_V1,
  BINDING_SCHEMA_V1,
  DIGEST_SCHEMA_V1,
  EMPTY_ARGS_SCHEMA_V1,
  JSON_VALUE_SCHEMA_V1,
  NODE_ERROR_SNAPSHOT_SCHEMA_V1,
  VIRTUAL_PATH_SCHEMA_V1,
  resourceFacade
} from './registry-schema-primitives.js'
import type { JsonSchema } from './schema-primitives.js'
import { integerSchema, strictObject } from './schema-primitives.js'
import { SYSTEM_FIELD_VALUE_SCHEMAS_V1 } from './system-schema.js'

const primitive: Readonly<Record<string, JsonSchema>> = {
  ArrayBuffer: BINARY_SCHEMA_V1,
  JsonValueV1: JSON_VALUE_SCHEMA_V1,
  Uint8Array: BINARY_SCHEMA_V1,
  boolean: { type: 'boolean' },
  never: { not: {} },
  string: { type: 'string' },
  void: EMPTY_ARGS_SCHEMA_V1
}
const virtualStats = strictObject({
  birthtimeMs: { minimum: 0, type: 'number' },
  ctimeMs: { minimum: 0, type: 'number' },
  kind: { enum: ['directory', 'file', 'symlink'] },
  mtimeMs: { minimum: 0, type: 'number' },
  size: integerSchema(0, Number.MAX_SAFE_INTEGER)
})
const fsResults: Readonly<Record<string, JsonSchema>> = {
  FileHandleV1: resourceFacade('filesystem.file-handle'),
  FsMkdirRecursiveResultV1: {
    oneOf: [
      strictObject({ kind: { const: 'undefined' } }),
      strictObject({ kind: { const: 'path' }, value: VIRTUAL_PATH_SCHEMA_V1 })
    ]
  },
  FsMkdirResultV1: {
    oneOf: [
      EMPTY_ARGS_SCHEMA_V1,
      {
        oneOf: [
          strictObject({ kind: { const: 'undefined' } }),
          strictObject({ kind: { const: 'path' }, value: VIRTUAL_PATH_SCHEMA_V1 })
        ]
      }
    ]
  },
  FsReadResultV1: { oneOf: [{ type: 'string' }, BINARY_SCHEMA_V1] },
  FsReaddirDirentsResultV1: {
    items: strictObject({
      kind: { enum: ['directory', 'file', 'symlink'] },
      name: { maxLength: 255, minLength: 1, type: 'string' }
    }),
    maxItems: 100_000,
    type: 'array'
  },
  FsReaddirNamesResultV1: { items: { type: 'string' }, maxItems: 100_000, type: 'array' },
  FsReaddirResultV1: {
    oneOf: [
      { items: { type: 'string' }, maxItems: 100_000, type: 'array' },
      {
        items: strictObject({
          kind: { enum: ['directory', 'file', 'symlink'] },
          name: { maxLength: 255, minLength: 1, type: 'string' }
        }),
        maxItems: 100_000,
        type: 'array'
      }
    ]
  },
  FsWatchIteratorV1: resourceFacade('filesystem.watch-iterator'),
  FsWatcherV1: resourceFacade('filesystem.watcher'),
  VirtualFdV1: strictObject({ binding: { const: 'opaque' }, fd: integerSchema(0, Number.MAX_SAFE_INTEGER) }),
  VirtualStatsV1: virtualStats
}
const processResults: Readonly<Record<string, JsonSchema>> = {
  ChildProcessFacadeV1: strictObject({
    binding: BINDING_SCHEMA_V1,
    pid: integerSchema(1, Number.MAX_SAFE_INTEGER),
    resourceType: { const: 'process.child' },
    stderr: { oneOf: [{ type: 'null' }, resourceFacade('process.readable')] },
    stdin: { oneOf: [{ type: 'null' }, resourceFacade('process.stdin')] },
    stdout: { oneOf: [{ type: 'null' }, resourceFacade('process.readable')] }
  }),
  ChildProcessReadableFacadeV1: resourceFacade('process.readable'),
  ChildProcessStdinFacadeV1: resourceFacade('process.stdin'),
  ProcessNetworkAuthorizationReceiptV1: strictObject({
    authorized: { const: true },
    generation: integerSchema(1, Number.MAX_SAFE_INTEGER),
    invocationBindingDigest: DIGEST_SCHEMA_V1,
    semanticResourceDigest: DIGEST_SCHEMA_V1
  }),
  ProcessSyncOutputV1: { oneOf: [{ type: 'string' }, BINARY_SCHEMA_V1] },
  ProcessSyncResultV1: strictObject({
    error: NODE_ERROR_SNAPSHOT_SCHEMA_V1,
    pid: integerSchema(1, Number.MAX_SAFE_INTEGER),
    signal: { oneOf: [{ type: 'null' }, { enum: ['SIGINT', 'SIGKILL', 'SIGTERM'] }] },
    status: { oneOf: [{ type: 'null' }, integerSchema(0, 255)] },
    stderr: { oneOf: [{ type: 'string' }, BINARY_SCHEMA_V1] },
    stdout: { oneOf: [{ type: 'string' }, BINARY_SCHEMA_V1] }
  }, ['pid', 'signal', 'status', 'stderr', 'stdout'])
}
const networkResults: Readonly<Record<string, JsonSchema>> = {
  NetworkResponseMetadataV1: strictObject({
    generation: integerSchema(1, Number.MAX_SAFE_INTEGER),
    headers: {
      items: NETWORK_HEADER_VIEW_V1_SCHEMA,
      maxItems: 1024,
      type: 'array'
    },
    hop: integerSchema(0, 128),
    logicalRequestId: { maxLength: 128, minLength: 1, type: 'string' },
    responseId: { maxLength: 128, minLength: 1, type: 'string' },
    redirected: { type: 'boolean' },
    source: { enum: ['mock', 'real'] },
    status: integerSchema(100, 599),
    statusText: { maxLength: 1024, type: 'string' },
    url: { maxLength: 65_536, type: 'string' }
  }),
  ResponseV1: resourceFacade('network.response')
}
const DEVICE_VALUE_OPERATIONS = [
  'device.connectivity.cellular.state.read',
  'device.connectivity.read',
  'device.connectivity.wifi.identity.read',
  'device.connectivity.wifi.state.read',
  'device.display.read',
  'device.form-factor.read',
  'device.input.read',
  'device.lifecycle.read',
  'device.media.capabilities.read',
  'device.power.read',
  'device.security.capabilities.read',
  'device.sensor.capabilities.read',
  'device.thermal.read'
] as const satisfies readonly DeviceValueOperationV1[]
const deviceResults = Object.fromEntries(
  DEVICE_VALUE_OPERATIONS.map(operation => [
    `DeviceReadingV1.${operation}`,
    deviceReadingSchemaV1(operation)
  ])
)

export const OPERATION_RESULT_SCHEMAS_V1: Readonly<Record<string, JsonSchema>> = Object.freeze({
  ...primitive,
  ...fsResults,
  ...processResults,
  ...networkResults,
  ...REGISTRY_EVENT_SCHEMAS_V1,
  ...deviceResults,
  DeviceSubscriptionV1: DEVICE_SUBSCRIPTION_RESOURCE_V1_SCHEMA,
  HoloDeviceSummaryV1: DEVICE_SUMMARY_V1_SCHEMA,
  RuntimeBufferV1: BINARY_SCHEMA_V1,
  ...Object.fromEntries(
    Object.entries(SYSTEM_FIELD_VALUE_SCHEMAS_V1).map(([field, schema]) => [
      `SystemFieldValueMapV1.${field}`,
      schema
    ])
  )
})
