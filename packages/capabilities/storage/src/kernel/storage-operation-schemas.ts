import { integerSchema, strictObject } from '@holonomyjs/runtime/kernel/schema-primitives'
import type { JsonSchema } from '@holonomyjs/runtime/kernel/schema-primitives'
import { STORAGE_ERROR_MESSAGES } from '@holonomyjs/runtime/storage/errors'
import { STORAGE_LIMIT_MAXIMA_V2 } from './storage-policy.js'

const scalar: JsonSchema = {
  pattern: '^(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*$',
  type: 'string'
}
const text = (maximum: number, minimum = 1): JsonSchema => ({ ...scalar, maxLength: maximum, minLength: minimum })
const namespaceId: JsonSchema = {
  maxLength: 128,
  minLength: 1,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
  type: 'string'
}
const key = text(STORAGE_LIMIT_MAXIMA_V2.maxKeyBytes)
const prefix = text(STORAGE_LIMIT_MAXIMA_V2.maxKeyBytes, 0)
const database = text(STORAGE_LIMIT_MAXIMA_V2.maxDatabaseNameBytes)
const sql = text(STORAGE_LIMIT_MAXIMA_V2.maxSqlBytes)
const scalarValue: JsonSchema = { oneOf: [{ type: 'null' }, { type: 'boolean' }, { type: 'number' }, scalar] }
const statement = strictObject({
  params: { items: scalarValue, maxItems: STORAGE_LIMIT_MAXIMA_V2.maxTransactionStatements, type: 'array' },
  sql
}, ['sql'])

export const STORAGE_ARGUMENT_SCHEMAS_V1: Readonly<Record<string, JsonSchema>> = Object.freeze({
  StorageKvKeyArgsV1: strictObject({ key, namespaceId }),
  StorageKvListArgsV1: strictObject({ namespaceId, prefix }),
  StorageKvSetArgsV1: strictObject({
    key,
    namespaceId,
    valueByteLength: integerSchema(0, STORAGE_LIMIT_MAXIMA_V2.maxValueBytes),
    valueSha256: { pattern: '^[0-9a-f]{64}$', type: 'string' }
  }),
  StorageSqlStatementArgsV1: strictObject({ database, namespaceId, statement }),
  StorageSqlTransactionArgsV1: strictObject({
    database,
    namespaceId,
    statements: {
      items: statement,
      maxItems: STORAGE_LIMIT_MAXIMA_V2.maxTransactionStatements,
      minItems: 1,
      type: 'array'
    }
  })
})

const executeResult = strictObject({ changes: integerSchema(0, Number.MAX_SAFE_INTEGER) })
const rowPair: JsonSchema = {
  items: false,
  maxItems: 2,
  minItems: 2,
  prefixItems: [text(STORAGE_LIMIT_MAXIMA_V2.maxKeyBytes), scalarValue],
  type: 'array'
}
const successResults: Readonly<Record<string, JsonSchema>> = Object.freeze({
  StorageExecuteResultV1: executeResult,
  StorageKvGetResultV1: {
    oneOf: [
      strictObject({ found: { const: false } }),
      strictObject({
        found: { const: true },
        valueBase64: {
          maxLength: Math.ceil(STORAGE_LIMIT_MAXIMA_V2.maxValueBytes / 3) * 4,
          pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
          type: 'string'
        }
      })
    ]
  },
  StorageKvListResultV1: {
    items: key,
    maxItems: STORAGE_LIMIT_MAXIMA_V2.maxKeysPerList,
    type: 'array',
    uniqueItems: true
  },
  StorageQueryResultV1: {
    items: {
      items: rowPair,
      maxItems: STORAGE_LIMIT_MAXIMA_V2.maxKeysPerList,
      type: 'array'
    },
    maxItems: STORAGE_LIMIT_MAXIMA_V2.maxRowsPerQuery,
    type: 'array'
  },
  StorageTransactionResultV1: {
    items: executeResult,
    maxItems: STORAGE_LIMIT_MAXIMA_V2.maxTransactionStatements,
    minItems: 1,
    type: 'array'
  },
  StorageVoidResultV1: { type: 'null' }
})

const failureResult = strictObject({
  error: strictObject({ code: { enum: Object.keys(STORAGE_ERROR_MESSAGES) } })
})

export const STORAGE_RESULT_SCHEMAS_V1: Readonly<Record<string, JsonSchema>> = Object.freeze(
  Object.fromEntries(
    Object.entries(successResults).map(([name, success]) => [
      name,
      { oneOf: [success, failureResult] }
    ])
  )
)
