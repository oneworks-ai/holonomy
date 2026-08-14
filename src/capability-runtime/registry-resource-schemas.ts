import { BINDING_SCHEMA_V1, DIGEST_SCHEMA_V1, IDENTIFIER_SCHEMA_V1 } from './registry-schema-primitives.js'
import {
  DEVICE_FIELD_RESOURCE_V1_SCHEMA,
  FILESYSTEM_RESOURCE_V1_SCHEMA,
  NETWORK_RESOURCE_V1_SCHEMA,
  PROCESS_EXECUTABLE_RESOURCE_V1_SCHEMA,
  PROCESS_INSTANCE_RESOURCE_V1_SCHEMA,
  PROCESS_NETWORK_ENDPOINT_RESOURCE_V1_SCHEMA,
  SYSTEM_INFORMATION_FIELD_RESOURCE_V1_SCHEMA
} from './resource-schema.js'
import type { JsonSchema } from './schema-primitives.js'
import { integerSchema, strictObject } from './schema-primitives.js'

export const OPERATION_RESOURCE_SCHEMAS_V1: Readonly<Record<string, JsonSchema>> = Object.freeze({
  DeviceFieldResourceV1: DEVICE_FIELD_RESOURCE_V1_SCHEMA,
  FilesystemResourceV1: FILESYSTEM_RESOURCE_V1_SCHEMA,
  NetworkResourceV1: NETWORK_RESOURCE_V1_SCHEMA,
  NetworkResponseBodyBindingV1: strictObject({
    bodyDigest: DIGEST_SCHEMA_V1,
    consumed: { type: 'boolean' },
    generation: integerSchema(1, Number.MAX_SAFE_INTEGER),
    hop: integerSchema(0, 128),
    logicalRequestId: IDENTIFIER_SCHEMA_V1,
    readerId: IDENTIFIER_SCHEMA_V1,
    responseId: IDENTIFIER_SCHEMA_V1
  }, ['consumed', 'generation', 'hop', 'logicalRequestId', 'readerId', 'responseId']),
  OpaqueFileHandleResourceV1: strictObject({
    binding: BINDING_SCHEMA_V1,
    rightsDigest: DIGEST_SCHEMA_V1
  }),
  'ProcessExecutableResourceV1→ProcessInstanceResourceV1': strictObject({
    instance: PROCESS_INSTANCE_RESOURCE_V1_SCHEMA,
    requested: PROCESS_EXECUTABLE_RESOURCE_V1_SCHEMA
  }),
  ProcessInstanceResourceV1: PROCESS_INSTANCE_RESOURCE_V1_SCHEMA,
  ProcessNetworkEndpointResourceV1: PROCESS_NETWORK_ENDPOINT_RESOURCE_V1_SCHEMA,
  SystemInformationFieldResourceV1: SYSTEM_INFORMATION_FIELD_RESOURCE_V1_SCHEMA
})
