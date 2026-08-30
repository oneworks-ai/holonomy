/* eslint-disable max-lines -- strict authority snapshots and provider checks are one security boundary. */

import { STORAGE_CREDENTIAL_RESOURCE, STORAGE_REQUIRED_CAPABILITY } from './constants.js'
import { StorageRuntimeError, createStorageError } from './errors.js'

import type { NativeArgumentValue, NativeAuthority, NativeDispatchContext } from '../native-port/types.js'
import type { StorageAuthority, StorageAuthorityInput, StorageCapability, StorageLimits } from './types.js'

const ARRAY_IS_ARRAY = Array.isArray
const ARRAY_PROTOTYPE = Array.prototype
const OBJECT_PROTOTYPE = Object.prototype
const GET_PROTOTYPE_OF = Object.getPrototypeOf
const GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor
const GET_OWN_PROPERTY_NAMES = Object.getOwnPropertyNames
const GET_OWN_PROPERTY_SYMBOLS = Object.getOwnPropertySymbols
const HAS_OWN = Object.hasOwn
const REGEXP_TEST = Function.prototype.call.bind(RegExp.prototype.test) as (pattern: RegExp, value: string) => boolean
const FREEZE = Object.freeze

export const DEFAULT_STORAGE_LIMITS: StorageLimits = FREEZE({
  maxDatabaseNameBytes: 128,
  maxKeyBytes: 1024,
  maxKeysPerList: 1024,
  maxRowsPerQuery: 1024,
  maxSqlBytes: 64 * 1024,
  maxTransactionStatements: 256,
  maxValueBytes: 1024 * 1024
})

const OPERATION_VALUES: readonly StorageCapability[] = [
  'credential.open',
  'credential.use',
  'kv.delete',
  'kv.get',
  'kv.list',
  'kv.set',
  'sqlite.execute',
  'sqlite.query',
  'sqlite.transaction'
]
const ID = /^\w[\w.:-]{0,127}$/u
const CAPABILITY = /^[\w@][\w@./:-]{0,127}$/u

const matches = (pattern: RegExp, value: string) => REGEXP_TEST(pattern, value)
const contains = (values: readonly string[], value: string) => {
  for (let index = 0; index < values.length; index += 1) if (values[index] === value) return true
  return false
}

/** Strict own-data snapshot; it intentionally never enumerates untrusted keys. */
export const snapshotStorageRecord = (
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = []
) => {
  try {
    if (
      value == null || typeof value !== 'object' || ARRAY_IS_ARRAY(value) ||
      GET_PROTOTYPE_OF(value) !== OBJECT_PROTOTYPE
    ) {
      throw new Error('invalid record')
    }
    const output: Record<string, unknown> = {}
    for (let index = 0; index < allowed.length; index += 1) {
      const key = allowed[index] as string
      const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(value, key)
      if (descriptor == null) continue
      if (!descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
        throw new Error('invalid descriptor')
      }
      output[key] = descriptor.value
    }
    for (let index = 0; index < required.length; index += 1) {
      if (!HAS_OWN(output, required[index] as string)) throw new Error('missing field')
    }
    return output
  } catch {
    throw createStorageError('storage.invalid_argument')
  }
}

const snapshotStrings = (value: unknown, valid: (item: string) => boolean, maximum = 128) => {
  try {
    if (!ARRAY_IS_ARRAY(value) || GET_PROTOTYPE_OF(value) !== ARRAY_PROTOTYPE || value.length > maximum) {
      throw new Error('invalid array')
    }
    const output: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(value, String(index))
      if (
        descriptor == null || !descriptor.enumerable || !('value' in descriptor) ||
        typeof descriptor.value !== 'string' || !valid(descriptor.value)
      ) {
        throw new Error('invalid entry')
      }
      if (contains(output, descriptor.value)) throw new Error('duplicate entry')
      output.push(descriptor.value)
    }
    return FREEZE(output)
  } catch {
    throw createStorageError('storage.invalid_argument')
  }
}

const resolveLimits = (value: unknown): Readonly<StorageLimits> => {
  const input = snapshotStorageRecord(value, [
    'maxDatabaseNameBytes',
    'maxKeyBytes',
    'maxKeysPerList',
    'maxRowsPerQuery',
    'maxSqlBytes',
    'maxTransactionStatements',
    'maxValueBytes'
  ])
  const output: Record<string, number> = { ...DEFAULT_STORAGE_LIMITS }
  for (
    const key of [
      'maxDatabaseNameBytes',
      'maxKeyBytes',
      'maxKeysPerList',
      'maxRowsPerQuery',
      'maxSqlBytes',
      'maxTransactionStatements',
      'maxValueBytes'
    ]
  ) {
    if (!HAS_OWN(input, key)) continue
    const item = input[key]
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item <= 0) {
      throw createStorageError('storage.invalid_argument')
    }
    output[key] = item
  }
  return FREEZE(output) as Readonly<StorageLimits>
}

export const createStorageAuthority = (input: StorageAuthorityInput): Readonly<StorageAuthority> => {
  try {
    const value = snapshotStorageRecord(input, ['capabilities', 'limits', 'namespace', 'operations', 'principal'], [
      'capabilities',
      'namespace',
      'operations',
      'principal'
    ])
    if (
      typeof value.principal !== 'string' || !matches(ID, value.principal) ||
      typeof value.namespace !== 'string' || !matches(ID, value.namespace)
    ) throw createStorageError('storage.invalid_argument')
    const capabilities = snapshotStrings(value.capabilities, item => matches(CAPABILITY, item))
    if (!contains(capabilities, STORAGE_REQUIRED_CAPABILITY)) throw createStorageError('storage.invalid_argument')
    const operations = snapshotStrings(
      value.operations,
      item => contains(OPERATION_VALUES, item),
      OPERATION_VALUES.length
    ) as readonly StorageCapability[]
    return FREEZE({
      capabilities,
      limits: HAS_OWN(value, 'limits') ? resolveLimits(value.limits) : DEFAULT_STORAGE_LIMITS,
      namespace: value.namespace,
      operations,
      principal: value.principal
    })
  } catch (error) {
    if (error instanceof StorageRuntimeError) throw error
    throw createStorageError('storage.invalid_argument')
  }
}

export const nativeAuthorityForStorage = (authority: Readonly<StorageAuthority>): Readonly<NativeAuthority> =>
  FREEZE({
    capabilities: authority.capabilities,
    principal: authority.principal
  })

export const createStorageAuthorityRegistry = (authorities: readonly Readonly<StorageAuthority>[]) => {
  const registry = new Map<string, Readonly<StorageAuthority>>()
  for (let index = 0; index < authorities.length; index += 1) {
    const authority = authorities[index] as Readonly<StorageAuthority>
    if (registry.has(authority.principal)) throw createStorageError('storage.invalid_argument')
    registry.set(authority.principal, authority)
  }
  return registry
}

export const resolveProviderStorageAuthority = (
  registry: ReadonlyMap<string, Readonly<StorageAuthority>>,
  context: Readonly<NativeDispatchContext>,
  operation: StorageCapability
) => {
  try {
    const authority = registry.get(context.authority.principal)
    if (
      authority == null || !contains(context.authority.capabilities, STORAGE_REQUIRED_CAPABILITY) ||
      authority.capabilities.length !== context.authority.capabilities.length ||
      !contains(authority.operations, operation)
    ) throw createStorageError('storage.authorization_denied')
    for (let index = 0; index < authority.capabilities.length; index += 1) {
      if (!contains(context.authority.capabilities, authority.capabilities[index] as string)) {
        throw createStorageError('storage.authorization_denied')
      }
    }
    return authority
  } catch (error) {
    if (error instanceof StorageRuntimeError) throw error
    throw createStorageError('storage.authorization_denied')
  }
}

export const assertStorageCapability = (authority: Readonly<StorageAuthority>, operation: StorageCapability) => {
  if (!contains(authority.operations, operation)) throw createStorageError('storage.authorization_denied')
}

export const requireStorageCredentialBinding = (
  context: Readonly<NativeDispatchContext>,
  args: NativeArgumentValue
) => {
  try {
    if (
      GET_OWN_PROPERTY_NAMES(args).length !== 1 || GET_OWN_PROPERTY_NAMES(args)[0] !== 'credential' ||
      GET_OWN_PROPERTY_SYMBOLS(args).length !== 0
    ) {
      throw createStorageError('storage.authorization_denied')
    }
    const request = snapshotStorageRecord(args, ['credential'], ['credential'])
    const credential = request.credential
    if (context.resources.length !== 1 || context.resources[0]?.type !== STORAGE_CREDENTIAL_RESOURCE) {
      throw createStorageError('storage.authorization_denied')
    }
    const binding = context.resources[0]
    if (binding?.reference !== credential) throw createStorageError('storage.authorization_denied')
    return binding
  } catch (error) {
    if (error instanceof StorageRuntimeError) throw error
    throw createStorageError('storage.authorization_denied')
  }
}
