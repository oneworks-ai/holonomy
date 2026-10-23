import {
  FILESYSTEM_AGGREGATE_ARGUMENT_SCHEMAS_V1,
  FILESYSTEM_VARIANT_ARGUMENT_SCHEMAS_V1
} from '@holonomyjs/capability-fs/kernel/registry-filesystem-variant-schemas'
import { NETWORK_ARGUMENT_SCHEMAS_V1 } from '@holonomyjs/capability-network/kernel/registry-network-argument-schemas'
import { PROCESS_ARGUMENT_SCHEMAS_V1 } from '@holonomyjs/capability-process/kernel/registry-process-argument-schemas'
import { STORAGE_ARGUMENT_SCHEMAS_V1 } from '@holonomyjs/capability-storage/kernel/storage-operation-schemas'
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
const fsTime: JsonSchema = {
  oneOf: [
    strictObject({
      kind: { const: 'set' },
      seconds: integerSchema(0, 253_402_300_799),
      nanoseconds: integerSchema(0, 999_999_999)
    }),
    strictObject({ kind: { const: 'now' } }),
    strictObject({ kind: { const: 'omit' } })
  ]
}
const fsTimes = { atime: fsTime, mtime: fsTime }
const readback = { readback: { const: true } }
const fsMode = integerSchema(0, 0o777)
const fsPathChmod = pathArgs({ mode: fsMode }, ['path', 'mode'])
const expectedKind = { expectedKind: { enum: ['file', 'directory'] } }
const fsPathChmodReadback = pathArgs({ mode: fsMode, ...readback, ...expectedKind }, ['path', 'mode', 'readback'])
const fsHandleChmod = strictObject({ mode: fsMode }, ['mode'])
const fsHandleChmodReadback = strictObject({ mode: fsMode, ...readback, ...expectedKind }, ['mode', 'readback'])
const fsHandleTimes = strictObject({ ...fsTimes, fd: integerSchema(0, Number.MAX_SAFE_INTEGER) }, ['atime', 'mtime'])
const fsHandleTimesReadback = strictObject({ ...fsTimes, ...readback }, ['atime', 'mtime', 'readback'])
const fsHandleTruncate = strictObject({
  fd: integerSchema(0, Number.MAX_SAFE_INTEGER),
  len: integerSchema(0, Number.MAX_SAFE_INTEGER)
}, ['len'])
const fsHandleTruncateReadback = strictObject({ len: integerSchema(0, Number.MAX_SAFE_INTEGER), ...readback }, [
  'len',
  'readback'
])
const fsPathTimes = pathArgs(fsTimes, ['path', 'atime', 'mtime'])
const fsPathTimesReadback = pathArgs({ ...fsTimes, ...readback }, ['path', 'atime', 'mtime', 'readback'])
const fsPathTruncate = pathArgs({ len: integerSchema(0, Number.MAX_SAFE_INTEGER) }, ['path', 'len'])
const fsPathTruncateReadback = pathArgs({ len: integerSchema(0, Number.MAX_SAFE_INTEGER), ...readback }, [
  'path',
  'len',
  'readback'
])
export const FS_PORTABLE_OPEN_FLAG_SCHEMA_V1: JsonSchema = Object.freeze({
  allOf: [
    strictObject({
      kind: { const: 'portable-open-v1' },
      access: { enum: ['read', 'write', 'readWrite'] },
      create: { type: 'boolean' },
      exclusive: { type: 'boolean' },
      truncate: { type: 'boolean' },
      append: { type: 'boolean' }
    }),
    {
      if: { type: 'object', properties: { exclusive: { const: true } } },
      then: { type: 'object', properties: { create: { const: true } } }
    },
    {
      if: { type: 'object', properties: { access: { const: 'read' } } },
      then: { type: 'object', properties: { truncate: { const: false }, append: { const: false } } }
    }
  ]
})

export const OPERATION_ARGUMENT_SCHEMAS_V1: Readonly<Record<string, JsonSchema>> = Object.freeze({
  ...FILESYSTEM_AGGREGATE_ARGUMENT_SCHEMAS_V1,
  ...FILESYSTEM_VARIANT_ARGUMENT_SCHEMAS_V1,
  ...NETWORK_ARGUMENT_SCHEMAS_V1,
  ...PROCESS_ARGUMENT_SCHEMAS_V1,
  ...STORAGE_ARGUMENT_SCHEMAS_V1,
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
  FsChmodArgsV1: fsPathChmod,
  FsChmodReadbackArgsV1: fsPathChmodReadback,
  FsChmodPromiseArgsV1: { oneOf: [fsPathChmod, fsPathChmodReadback] },
  FsFchmodArgsV1: strictObject({ fd: integerSchema(0, Number.MAX_SAFE_INTEGER), mode: fsMode }, ['fd', 'mode']),
  FsHandleChmodArgsV1: fsHandleChmod,
  FsHandleChmodReadbackArgsV1: fsHandleChmodReadback,
  FsHandleChmodPromiseArgsV1: { oneOf: [fsHandleChmod, fsHandleChmodReadback] },
  FsAccessArgsV1: pathArgs({ mode: integerSchema(0, 7) }, ['path', 'mode']),
  FsDataV1: DATA_SCHEMA_V1,
  FsDirectoryOpenArgsV1: pathArgs(),
  FsDirectorySyncArgsV1: strictObject({ dataOnly: { type: 'boolean' } }),
  FsHandleTimesArgsV1: fsHandleTimes,
  FsHandleTimesReadbackArgsV1: fsHandleTimesReadback,
  FsHandleTimesPromiseArgsV1: { oneOf: [fsHandleTimes, fsHandleTimesReadback] },
  FsHandleTruncateArgsV1: fsHandleTruncate,
  FsHandleTruncateReadbackArgsV1: fsHandleTruncateReadback,
  FsHandleTruncatePromiseArgsV1: { oneOf: [fsHandleTruncate, fsHandleTruncateReadback] },
  FsFileHandleStatArgsV1: strictObject({ bigint: { const: false } }, []),
  FsFileHandleWriteArgsV1: strictObject({ data: DATA_SCHEMA_V1, options: writeOptions(true) }, ['data']),
  FsOpenArgsV1: pathArgs({
    flag: {
      oneOf: [
        { enum: ['a', 'a+', 'ax', 'ax+', 'r', 'r+', 'w', 'w+', 'wx', 'wx+'] },
        FS_PORTABLE_OPEN_FLAG_SCHEMA_V1
      ]
    }
  }, [
    'path',
    'flag'
  ]),
  FsRenameArgsV1: strictObject({ from: VIRTUAL_PATH_SCHEMA_V1, to: VIRTUAL_PATH_SCHEMA_V1 }),
  FsSyncArgsV1: strictObject({ fd: integerSchema(0, Number.MAX_SAFE_INTEGER) }),
  FsStatArgsV1: pathArgs({ options: strictObject({ bigint: { const: false } }, []) }),
  FsTruncateArgsV1: fsPathTruncate,
  FsTruncateReadbackArgsV1: fsPathTruncateReadback,
  FsTruncatePromiseArgsV1: { oneOf: [fsPathTruncate, fsPathTruncateReadback] },
  FsUnlinkArgsV1: pathArgs(),
  FsUtimesArgsV1: fsPathTimes,
  FsUtimesReadbackArgsV1: fsPathTimesReadback,
  FsUtimesPromiseArgsV1: { oneOf: [fsPathTimes, fsPathTimesReadback] },
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
