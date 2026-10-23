import { CapabilityInvocationError } from '@holonomyjs/runtime/kernel/errors'
import { utf8ByteLength } from '@holonomyjs/runtime/kernel/validation'
import { decodeBase64, encodeBase64 } from '@holonomyjs/runtime/node-compat/encoding'
import type { StorageLimitsV2, StorageOperationV1 } from './storage-types.js'
const STRINGIFY = JSON.stringify

const fail = (operation: StorageOperationV1, digest: string): never => {
  throw new CapabilityInvocationError('result.invalid', operation, digest)
}

const isFailure = (value: unknown): value is { error: { code: string } } =>
  value != null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'error')

/** Apply the current Policy limit after Middleware and Provider, even for a short-circuited result. */
export const validateStorageResultPolicyV1 = (
  operation: StorageOperationV1,
  result: unknown,
  args: unknown,
  limits: StorageLimitsV2,
  semanticResourceDigest: string
): void => {
  // The static closed schema validates error.code before this check.
  if (isFailure(result)) return
  if (operation === 'storage.kv.get') {
    const value = result as { found: boolean; valueBase64?: string }
    if (!value.found) return
    const base64 = value.valueBase64 as string
    try {
      if (base64.length > Math.ceil(limits.maxValueBytes / 3) * 4) return fail(operation, semanticResourceDigest)
      const bytes = decodeBase64(base64)
      if (bytes.length > limits.maxValueBytes || encodeBase64(bytes, false) !== base64) {
        return fail(operation, semanticResourceDigest)
      }
    } catch {
      return fail(operation, semanticResourceDigest)
    }
    return
  }
  if (operation === 'storage.kv.list') {
    const values = result as readonly string[]
    const prefix = (args as { prefix: string }).prefix
    if (
      values.length > limits.maxKeysPerList ||
      values.some(value => utf8ByteLength(value) > limits.maxKeyBytes || !value.startsWith(prefix))
    ) return fail(operation, semanticResourceDigest)
    return
  }
  if (operation === 'storage.sqlite.query') {
    const rows = result as readonly (readonly (readonly [string, null | boolean | number | string])[])[]
    let bytes = 0
    if (
      rows.length > limits.maxRowsPerQuery || rows.some(row => {
        const names = row.map(pair => pair[0])
        return row.length > limits.maxKeysPerList || new Set(names).size !== names.length ||
          row.some(([name, value]) => {
            bytes += utf8ByteLength(name) + utf8ByteLength(STRINGIFY(value))
            return utf8ByteLength(name) > limits.maxKeyBytes || bytes > limits.maxValueBytes ||
              typeof value === 'string' && utf8ByteLength(value) > limits.maxValueBytes
          })
      })
    ) return fail(operation, semanticResourceDigest)
    return
  }
  if (operation === 'storage.sqlite.transaction') {
    const expected = (args as { statements: readonly unknown[] }).statements.length
    if ((result as readonly unknown[]).length !== expected) return fail(operation, semanticResourceDigest)
  }
}
