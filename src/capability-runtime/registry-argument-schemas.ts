import {
  FILESYSTEM_AGGREGATE_ARGUMENT_SCHEMAS_V1,
  FILESYSTEM_VARIANT_ARGUMENT_SCHEMAS_V1
} from './registry-filesystem-variant-schemas.js'
import { NETWORK_ARGUMENT_SCHEMAS_V1 } from './registry-network-argument-schemas.js'
import { PROCESS_ARGUMENT_SCHEMAS_V1 } from './registry-process-argument-schemas.js'
import {
  BINDING_SCHEMA_V1,
  DATA_SCHEMA_V1,
  EMPTY_ARGS_SCHEMA_V1,
  VIRTUAL_PATH_SCHEMA_V1,
  resourceFacade
} from './registry-schema-primitives.js'
import type { JsonSchema } from './schema-primitives.js'
import { integerSchema, strictObject } from './schema-primitives.js'

const signal = BINDING_SCHEMA_V1
const pathOrFd: JsonSchema = {
  oneOf: [
    VIRTUAL_PATH_SCHEMA_V1,
    strictObject({ binding: { const: 'opaque' }, fd: integerSchema(0, Number.MAX_SAFE_INTEGER) })
  ]
}
const encoding: JsonSchema = { enum: ['base64', 'hex', 'utf-8', 'utf8'] }
const writeOptions = (async: boolean): JsonSchema =>
  strictObject({
    encoding,
    flag: { enum: ['a', 'ax', 'w', 'wx'] },
    ...(async ? { signal } : {})
  }, [])
const pathArgs = (extra: Readonly<Record<string, JsonSchema>> = {}, required: readonly string[] = ['path']) =>
  strictObject({ path: VIRTUAL_PATH_SCHEMA_V1, ...extra }, required)

export const OPERATION_ARGUMENT_SCHEMAS_V1: Readonly<Record<string, JsonSchema>> = Object.freeze({
  ...FILESYSTEM_AGGREGATE_ARGUMENT_SCHEMAS_V1,
  ...FILESYSTEM_VARIANT_ARGUMENT_SCHEMAS_V1,
  ...NETWORK_ARGUMENT_SCHEMAS_V1,
  ...PROCESS_ARGUMENT_SCHEMAS_V1,
  ChildProcessReadableFacadeV1: resourceFacade('process.readable'),
  ChildProcessResourceStateV1: BINDING_SCHEMA_V1,
  DeviceSubscriptionOptionsV1: strictObject({
    kinds: {
      items: { enum: ['connectivity', 'display', 'lifecycle', 'power', 'thermal'] },
      maxItems: 5,
      minItems: 1,
      type: 'array',
      uniqueItems: true
    },
    maxQueuedEvents: integerSchema(1, 4096)
  }, ['kinds']),
  EmptyArgsV1: EMPTY_ARGS_SCHEMA_V1,
  FsCloseArgsV1: strictObject({ fd: integerSchema(0, Number.MAX_SAFE_INTEGER) }),
  FsDataV1: DATA_SCHEMA_V1,
  FsFileHandleStatArgsV1: strictObject({ bigint: { const: false } }, []),
  FsFileHandleWriteArgsV1: strictObject({ data: DATA_SCHEMA_V1, options: writeOptions(true) }, ['data']),
  FsOpenArgsV1: pathArgs({ flag: { enum: ['a', 'a+', 'ax', 'ax+', 'r', 'r+', 'w', 'w+', 'wx', 'wx+'] } }, [
    'path',
    'flag'
  ]),
  FsRenameArgsV1: strictObject({ from: VIRTUAL_PATH_SCHEMA_V1, to: VIRTUAL_PATH_SCHEMA_V1 }),
  FsStatArgsV1: pathArgs({ options: strictObject({ bigint: { const: false } }, []) }),
  FsUnlinkArgsV1: pathArgs(),
  FsWatchArgsV1: pathArgs({
    options: strictObject({
      encoding,
      maxQueuedEvents: integerSchema(1, 4096),
      persistent: { type: 'boolean' },
      recursive: { const: false },
      signal
    }, [])
  }),
  FsWriteFileAsyncArgsV1: strictObject({ data: DATA_SCHEMA_V1, options: writeOptions(true), path: pathOrFd }, [
    'data',
    'path'
  ]),
  FsWriteFileSyncArgsV1: strictObject({ data: DATA_SCHEMA_V1, options: writeOptions(false), path: pathOrFd }, [
    'data',
    'path'
  ]),
  NetworkWebSocketArgsV1: strictObject({
    protocols: { items: { maxLength: 256, type: 'string' }, maxItems: 64, type: 'array' },
    url: { maxLength: 65_536, type: 'string' }
  }, ['url']),
  ProcessSignalV1: { enum: ['SIGINT', 'SIGKILL', 'SIGTERM'] },
  SystemUserInfoArgsV1: strictObject({ encoding: { const: 'utf8' } }, [])
})
