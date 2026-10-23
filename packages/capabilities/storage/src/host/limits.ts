import { utf8ByteLength } from '@holonomyjs/runtime/kernel/validation'
import { decodeBase64 } from '@holonomyjs/runtime/node-compat/encoding'
import type { StorageLimitNameV2 } from '../kernel/storage-types.js'
import type { StorageArgumentsV1, StorageHostInstallationV1 } from './types.js'

const STRINGIFY = JSON.stringify

export const storageHostLimitsV1 = (installation: StorageHostInstallationV1) => {
  const hostLimit = (name: StorageLimitNameV2) => installation.limits?.[name] ?? Infinity
  return {
    allowsArguments(operation: string, args: StorageArgumentsV1): boolean {
      if (operation.startsWith('v1.kv.')) {
        const name = operation === 'v1.kv.list' ? args.prefix! : args.key!
        return utf8ByteLength(name) <= hostLimit('maxKeyBytes') &&
          (operation !== 'v1.kv.set' || args.valueByteLength! <= hostLimit('maxValueBytes'))
      }
      const statements = operation === 'v1.sqlite.transaction' ? args.statements! : [args.statement!]
      return utf8ByteLength(args.database!) <= hostLimit('maxDatabaseNameBytes') &&
        statements.length <= hostLimit('maxTransactionStatements') &&
        statements.every(statement =>
          utf8ByteLength(statement.sql) <= hostLimit('maxSqlBytes') &&
          (statement.params ?? []).every(value =>
            typeof value !== 'string' || utf8ByteLength(value) <= hostLimit('maxValueBytes')
          )
        )
    },
    allowsResult(operation: string, value: unknown): boolean {
      if (operation === 'v1.kv.get') {
        const result = value as { found?: boolean; valueBase64: string } | null
        return result?.found !== true ||
          decodeBase64(result.valueBase64).byteLength <= hostLimit('maxValueBytes')
      }
      if (operation === 'v1.kv.list') {
        const keys = value as readonly string[]
        return keys.length <= hostLimit('maxKeysPerList') &&
          keys.every(key => utf8ByteLength(key) <= hostLimit('maxKeyBytes'))
      }
      if (operation === 'v1.sqlite.query') {
        const rows = value as readonly (readonly (readonly [string, null | boolean | number | string])[])[]
        if (rows.length > hostLimit('maxRowsPerQuery')) return false
        let bytes = 0
        for (const row of rows) {
          for (const [name, cell] of row) {
            bytes += utf8ByteLength(name) + utf8ByteLength(STRINGIFY(cell))
            if (bytes > hostLimit('maxValueBytes')) return false
          }
        }
      }
      if (operation === 'v1.sqlite.transaction') {
        return (value as readonly unknown[]).length <= hostLimit('maxTransactionStatements')
      }
      return true
    }
  }
}
