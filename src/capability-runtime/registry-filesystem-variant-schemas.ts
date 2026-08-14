import { BINDING_SCHEMA_V1, EMPTY_ARGS_SCHEMA_V1, VIRTUAL_PATH_SCHEMA_V1 } from './registry-schema-primitives.js'
import type { JsonSchema } from './schema-primitives.js'
import { strictObject } from './schema-primitives.js'

const READ_ENCODING_SCHEMA_V1: JsonSchema = { enum: ['base64', 'hex', 'utf-8', 'utf8'] }
const VIRTUAL_FD_SCHEMA_V1 = strictObject({
  binding: { const: 'opaque' },
  fd: { maximum: Number.MAX_SAFE_INTEGER, minimum: 0, type: 'integer' }
})
const READ_BUFFER_OPTIONS_V1 = (async: boolean): JsonSchema =>
  strictObject({
    encoding: { type: 'null' },
    flag: { const: 'r' },
    ...(async ? { signal: BINDING_SCHEMA_V1 } : {})
  }, [])
const READ_STRING_OPTIONS_V1 = (async: boolean): JsonSchema =>
  strictObject({
    encoding: READ_ENCODING_SCHEMA_V1,
    flag: { const: 'r' },
    ...(async ? { signal: BINDING_SCHEMA_V1 } : {})
  }, ['encoding'])

const withOptionalOptions = (
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
  options: JsonSchema
): JsonSchema => ({
  oneOf: [
    strictObject(properties, required),
    strictObject({ ...properties, options }, [...required, 'options'])
  ]
})

const pathRead = (async: boolean, kind: 'buffer' | 'string'): JsonSchema =>
  kind === 'buffer'
    ? withOptionalOptions(
      { path: { oneOf: [VIRTUAL_PATH_SCHEMA_V1, VIRTUAL_FD_SCHEMA_V1] } },
      ['path'],
      READ_BUFFER_OPTIONS_V1(async)
    )
    : strictObject({
      options: READ_STRING_OPTIONS_V1(async),
      path: { oneOf: [VIRTUAL_PATH_SCHEMA_V1, VIRTUAL_FD_SCHEMA_V1] }
    }, ['options', 'path'])

const handleRead = (async: boolean, kind: 'buffer' | 'string'): JsonSchema =>
  kind === 'buffer'
    ? { oneOf: [EMPTY_ARGS_SCHEMA_V1, strictObject({ options: READ_BUFFER_OPTIONS_V1(async) })] }
    : strictObject({ options: READ_STRING_OPTIONS_V1(async) })

const readdirOptions = (withFileTypes: boolean, required: boolean): JsonSchema =>
  strictObject({
    encoding: { enum: ['utf-8', 'utf8'] },
    withFileTypes: { const: withFileTypes }
  }, required ? ['withFileTypes'] : [])

export const FILESYSTEM_VARIANT_ARGUMENT_SCHEMAS_V1: Readonly<Record<string, JsonSchema>> = Object.freeze({
  FsFileHandleReadBufferArgsV1: handleRead(true, 'buffer'),
  FsFileHandleReadStringArgsV1: handleRead(true, 'string'),
  FsMkdirNonRecursiveArgsV1: withOptionalOptions(
    { path: VIRTUAL_PATH_SCHEMA_V1 },
    ['path'],
    strictObject({ recursive: { const: false } }, [])
  ),
  FsMkdirRecursiveArgsV1: strictObject({
    options: strictObject({ recursive: { const: true } }),
    path: VIRTUAL_PATH_SCHEMA_V1
  }),
  FsReadFileAsyncBufferArgsV1: pathRead(true, 'buffer'),
  FsReadFileAsyncStringArgsV1: pathRead(true, 'string'),
  FsReadFileSyncBufferArgsV1: pathRead(false, 'buffer'),
  FsReadFileSyncStringArgsV1: pathRead(false, 'string'),
  FsReaddirDirentsArgsV1: strictObject({
    options: readdirOptions(true, true),
    path: VIRTUAL_PATH_SCHEMA_V1
  }),
  FsReaddirNamesArgsV1: withOptionalOptions(
    { path: VIRTUAL_PATH_SCHEMA_V1 },
    ['path'],
    readdirOptions(false, false)
  )
})

export const FILESYSTEM_AGGREGATE_ARGUMENT_SCHEMAS_V1: Readonly<Record<string, JsonSchema>> = Object.freeze({
  FsFileHandleReadArgsV1: {
    oneOf: [
      FILESYSTEM_VARIANT_ARGUMENT_SCHEMAS_V1.FsFileHandleReadBufferArgsV1,
      FILESYSTEM_VARIANT_ARGUMENT_SCHEMAS_V1.FsFileHandleReadStringArgsV1
    ]
  },
  FsMkdirArgsV1: {
    oneOf: [
      FILESYSTEM_VARIANT_ARGUMENT_SCHEMAS_V1.FsMkdirNonRecursiveArgsV1,
      FILESYSTEM_VARIANT_ARGUMENT_SCHEMAS_V1.FsMkdirRecursiveArgsV1
    ]
  },
  FsReadFileAsyncArgsV1: {
    oneOf: [
      FILESYSTEM_VARIANT_ARGUMENT_SCHEMAS_V1.FsReadFileAsyncBufferArgsV1,
      FILESYSTEM_VARIANT_ARGUMENT_SCHEMAS_V1.FsReadFileAsyncStringArgsV1
    ]
  },
  FsReadFileSyncArgsV1: {
    oneOf: [
      FILESYSTEM_VARIANT_ARGUMENT_SCHEMAS_V1.FsReadFileSyncBufferArgsV1,
      FILESYSTEM_VARIANT_ARGUMENT_SCHEMAS_V1.FsReadFileSyncStringArgsV1
    ]
  },
  FsReaddirArgsV1: {
    oneOf: [
      FILESYSTEM_VARIANT_ARGUMENT_SCHEMAS_V1.FsReaddirNamesArgsV1,
      FILESYSTEM_VARIANT_ARGUMENT_SCHEMAS_V1.FsReaddirDirentsArgsV1
    ]
  }
})
