/* eslint-disable max-lines -- NativePort mapping and exact copied-binary binding share one Host-only boundary. */
import type { AuthorityBindingV1 } from '@holonomyjs/runtime/kernel/capability-types'
import { CapabilityInvocationError } from '@holonomyjs/runtime/kernel/errors'
import { exact, identifier, required, utf8ByteLength } from '@holonomyjs/runtime/kernel/validation'
import { sha256Hex } from '@holonomyjs/runtime/module-loader/sha256'
import type { NativeBinarySource } from '@holonomyjs/runtime/native-port/types'
import { decodeBase64, encodeBase64 } from '@holonomyjs/runtime/node-compat/encoding'
import { normalizeStorageCapabilityConstraintsV1 } from './storage-capability-constraints.js'
import { STORAGE_LIMIT_MAXIMA_V2, isStorageScalarTextV1 } from './storage-policy.js'
import type { StorageLimitsV2, StorageOperationV1 } from './storage-types.js'

export const STORAGE_OPERATION_BY_NATIVE_V1 = Object.freeze(
  {
    'v1.kv.delete': 'storage.kv.delete',
    'v1.kv.get': 'storage.kv.get',
    'v1.kv.list': 'storage.kv.list',
    'v1.kv.set': 'storage.kv.set',
    'v1.sqlite.execute': 'storage.sqlite.execute',
    'v1.sqlite.query': 'storage.sqlite.query',
    'v1.sqlite.transaction': 'storage.sqlite.transaction'
  } as const
)

export const STORAGE_NATIVE_BY_OPERATION_V1: Readonly<Record<StorageOperationV1, string>> = Object.freeze(
  Object.fromEntries(Object.entries(STORAGE_OPERATION_BY_NATIVE_V1).map(([native, operation]) => [operation, native]))
) as Readonly<Record<StorageOperationV1, string>>

export interface StorageProviderSelectionV1 {
  readonly databases: readonly string[]
  readonly keyPrefixes: readonly string[]
  readonly limits: StorageLimitsV2
  readonly namespaceId: string
  readonly operation: StorageOperationV1
}

export interface StorageHostRequestV1 {
  readonly args: unknown
  readonly binary?: readonly Readonly<{
    base64?: string
    data?: NativeBinarySource
    handle: string
  }>[]
  readonly module: string
  readonly operation: string
}

/** Project only the selected, narrowed authority. Never send physical namespace paths to a Provider. */
export const storageSelectionForProviderV1 = (
  binding: AuthorityBindingV1,
  operation: StorageOperationV1
): StorageProviderSelectionV1 => {
  if (binding.capabilityName !== 'host.storage' || binding.providerModule !== 'host.storage') {
    throw new CapabilityInvocationError('capability.denied', operation)
  }
  let constraints: ReturnType<typeof normalizeStorageCapabilityConstraintsV1>
  try {
    constraints = normalizeStorageCapabilityConstraintsV1(binding.constraints)
  } catch {
    throw new CapabilityInvocationError('capability.denied', operation)
  }
  if (!constraints.operations.includes(operation)) throw new CapabilityInvocationError('capability.denied', operation)
  return Object.freeze({
    databases: constraints.databases,
    keyPrefixes: constraints.keyPrefixes,
    limits: constraints.limits,
    namespaceId: constraints.namespaceId,
    operation
  })
}

const invalid = (operation: string): never => {
  throw new CapabilityInvocationError('argument.invalid', operation)
}

const text = (value: unknown, maximum: number, operation: string, allowEmpty = false): string => {
  if (!isStorageScalarTextV1(value, maximum, allowEmpty)) return invalid(operation)
  return value
}

const keys = (value: unknown, allowed: readonly string[], operation: string): Record<string, unknown> => {
  try {
    const record = exact(value, allowed)
    if (Object.keys(record).some(key => !allowed.includes(key))) return invalid(operation)
    return record
  } catch {
    return invalid(operation)
  }
}

const sqlValue = (value: unknown, operation: string): null | boolean | number | string => {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') return text(value, STORAGE_LIMIT_MAXIMA_V2.maxValueBytes, operation, true)
  return invalid(operation)
}

const statement = (value: unknown, operation: string) => {
  const source = keys(value, ['params', 'sql'], operation)
  const sql = text(required(source, 'sql'), STORAGE_LIMIT_MAXIMA_V2.maxSqlBytes, operation)
  if (!Object.hasOwn(source, 'params')) return { sql }
  const params = source.params
  if (!Array.isArray(params) || params.length > STORAGE_LIMIT_MAXIMA_V2.maxTransactionStatements) {
    return invalid(operation)
  }
  return { params: params.map(value => sqlValue(value, operation)), sql }
}

const storageBytes = (request: StorageHostRequestV1): Uint8Array => {
  const operation = request.operation
  if (request.binary?.length !== 1 || request.binary[0]?.handle !== 'value') return invalid(operation)
  const item = request.binary[0]
  if (item.data != null && item.base64 != null) return invalid(operation)
  try {
    if (typeof item.base64 === 'string') {
      if (
        item.base64.length > Math.ceil(STORAGE_LIMIT_MAXIMA_V2.maxValueBytes / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.base64)
      ) {
        return invalid(operation)
      }
      const bytes = decodeBase64(item.base64)
      if (bytes.length > STORAGE_LIMIT_MAXIMA_V2.maxValueBytes || encodeBase64(bytes, false) !== item.base64) {
        return invalid(operation)
      }
      return bytes
    }
    const data = item.data
    if (data instanceof Uint8Array) {
      if (data.byteLength > STORAGE_LIMIT_MAXIMA_V2.maxValueBytes) return invalid(operation)
      return data.slice()
    }
    if (data instanceof ArrayBuffer) {
      if (data.byteLength > STORAGE_LIMIT_MAXIMA_V2.maxValueBytes) return invalid(operation)
      return new Uint8Array(data.slice(0))
    }
  } catch {
    return invalid(operation)
  }
  return invalid(operation)
}

const argumentsFor = (request: StorageHostRequestV1, namespaceId: string) => {
  const operation = request.operation
  if (operation === 'v1.kv.get' || operation === 'v1.kv.delete') {
    const args = keys(request.args, ['key'], operation)
    return { key: text(required(args, 'key'), STORAGE_LIMIT_MAXIMA_V2.maxKeyBytes, operation), namespaceId }
  }
  if (operation === 'v1.kv.list') {
    const args = keys(request.args, ['prefix'], operation)
    return { namespaceId, prefix: text(required(args, 'prefix'), STORAGE_LIMIT_MAXIMA_V2.maxKeyBytes, operation, true) }
  }
  if (operation === 'v1.kv.set') {
    const args = keys(request.args, ['key'], operation)
    const bytes = storageBytes(request)
    const valueByteLength = bytes.byteLength
    if (!Number.isSafeInteger(valueByteLength) || valueByteLength > STORAGE_LIMIT_MAXIMA_V2.maxValueBytes) {
      return invalid(operation)
    }
    return {
      key: text(required(args, 'key'), STORAGE_LIMIT_MAXIMA_V2.maxKeyBytes, operation),
      namespaceId,
      valueByteLength,
      valueSha256: sha256Hex(bytes)
    }
  }
  if (operation === 'v1.sqlite.execute' || operation === 'v1.sqlite.query') {
    const args = keys(request.args, ['database', 'statement'], operation)
    return {
      database: text(required(args, 'database'), STORAGE_LIMIT_MAXIMA_V2.maxDatabaseNameBytes, operation),
      namespaceId,
      statement: statement(required(args, 'statement'), operation)
    }
  }
  if (operation === 'v1.sqlite.transaction') {
    const args = keys(request.args, ['database', 'statements'], operation)
    const statements = required(args, 'statements')
    if (
      !Array.isArray(statements) || statements.length === 0 ||
      statements.length > STORAGE_LIMIT_MAXIMA_V2.maxTransactionStatements
    ) return invalid(operation)
    return {
      database: text(required(args, 'database'), STORAGE_LIMIT_MAXIMA_V2.maxDatabaseNameBytes, operation),
      namespaceId,
      statements: statements.map(value => statement(value, operation))
    }
  }
  return invalid(operation)
}

/** Map the existing NativeBridge v4 Storage request into the existing Kernel invoke JSON. */
export const createStorageInvocationV1 = (
  request: StorageHostRequestV1,
  namespaceValue: string = 'default',
  storageCallToken?: string
): string => {
  if (request.module !== 'host.storage' || !Object.hasOwn(STORAGE_OPERATION_BY_NATIVE_V1, request.operation)) {
    return invalid(request.operation)
  }
  let namespaceId: string
  try {
    namespaceId = identifier(namespaceValue, 128)
  } catch {
    return invalid(request.operation)
  }
  if (request.operation !== 'v1.kv.set' && request.binary != null && request.binary.length !== 0) {
    return invalid(request.operation)
  }
  if (request.operation === 'v1.kv.set' && storageCallToken == null) return invalid(request.operation)
  if (
    storageCallToken != null &&
    (typeof storageCallToken !== 'string' || !/^[\w.:-]{1,256}$/u.test(storageCallToken))
  ) {
    return invalid(request.operation)
  }
  const member = request.operation.slice(3)
  let output: string
  try {
    output = JSON.stringify({
      arguments: argumentsFor(request, namespaceId),
      member,
      mode: 'promise',
      module: 'holo:storage',
      ...(storageCallToken == null ? {} : { providerData: { storageCallToken } })
    })
  } catch (error) {
    if (error instanceof CapabilityInvocationError) throw error
    return invalid(request.operation)
  }
  if (utf8ByteLength(output) > 1024 * 1024) return invalid(request.operation)
  return output
}
