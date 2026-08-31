import {
  createRuntimeRecord,
  defineRuntimeData,
  freezeRuntimeValue,
  invalidOptions,
  runtimeString,
  snapshotArray,
  snapshotOptionalRecord,
  snapshotRecord
} from './intrinsics.js'
import { snapshotNetworkAuthority } from './options.js'

import type { GitAuthorityInput } from '../git/index.js'
import type { StorageAuthorityInput } from '../storage/index.js'

const GIT_LIMITS = [
  'maxChangedFiles',
  'maxConcurrentOperations',
  'maxConfigValueBytes',
  'maxOpenRepositories',
  'maxProgressEvents',
  'maxRefBytes',
  'maxRemotes',
  'maxTransferBytes'
] as const
const STORAGE_LIMITS = [
  'maxDatabaseNameBytes',
  'maxKeyBytes',
  'maxKeysPerList',
  'maxRowsPerQuery',
  'maxSqlBytes',
  'maxTransactionStatements',
  'maxValueBytes'
] as const
const ROOTS = ['app-data', 'temp', 'workspace'] as const

const record = (entries: readonly (readonly [string, unknown])[]) => {
  const output = createRuntimeRecord(Object.prototype)
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry[1] === undefined) continue
    defineRuntimeData(output, entry[0], entry[1])
  }
  return freezeRuntimeValue(output)
}
const records = (value: unknown, copy: (item: unknown) => unknown) => {
  const input = snapshotArray(value)
  const output: unknown[] = []
  for (let index = 0; index < input.length; index += 1) {
    defineRuntimeData(output, runtimeString(index), copy(input[index]))
  }
  return freezeRuntimeValue(output)
}
const grant = (value: unknown) => {
  const input = snapshotRecord(value, ['permissions', 'rootId'], ['permissions', 'rootId'])
  return record([['permissions', snapshotArray(input.permissions)], ['rootId', input.rootId]])
}
const filesystem = (value: unknown) => {
  const input = snapshotRecord(value, ['capabilities', 'principal', 'roots'], ['capabilities', 'principal', 'roots'])
  const rootInput = snapshotRecord(input.roots, ROOTS)
  const rootEntries: Array<readonly [string, unknown]> = []
  for (let index = 0; index < ROOTS.length; index += 1) {
    const name = ROOTS[index]!
    if (rootInput[name] !== undefined) {
      defineRuntimeData(rootEntries, runtimeString(rootEntries.length), [name, grant(rootInput[name])] as const)
    }
  }
  return record([['capabilities', snapshotArray(input.capabilities)], ['principal', input.principal], [
    'roots',
    record(rootEntries)
  ]])
}
const credential = (value: unknown) => {
  const input = snapshotRecord(value, ['allowedOrigins', 'operations', 'reference'], [
    'allowedOrigins',
    'operations',
    'reference'
  ])
  return record([['allowedOrigins', snapshotArray(input.allowedOrigins)], [
    'operations',
    snapshotArray(input.operations)
  ], ['reference', input.reference]])
}

export const snapshotGitAuthorityInput = (value: unknown): GitAuthorityInput => {
  const input = snapshotRecord(value, [
    'capabilities',
    'configKeys',
    'credentials',
    'filesystem',
    'limits',
    'network',
    'operations',
    'principal'
  ], ['capabilities', 'configKeys', 'filesystem', 'network', 'operations', 'principal'])
  try {
    return record([
      ['capabilities', snapshotArray(input.capabilities)],
      ['configKeys', snapshotArray(input.configKeys)],
      ['credentials', input.credentials === undefined ? undefined : records(input.credentials, credential)],
      ['filesystem', filesystem(input.filesystem)],
      ['limits', snapshotOptionalRecord(input.limits, GIT_LIMITS)],
      ['network', snapshotNetworkAuthority(input.network)],
      ['operations', snapshotArray(input.operations)],
      ['principal', input.principal]
    ]) as unknown as GitAuthorityInput
  } catch {
    return invalidOptions()
  }
}

export const snapshotStorageAuthorityInput = (value: unknown): StorageAuthorityInput => {
  const input = snapshotRecord(value, ['capabilities', 'limits', 'namespace', 'operations', 'principal'], [
    'capabilities',
    'namespace',
    'operations',
    'principal'
  ])
  return record([
    ['capabilities', snapshotArray(input.capabilities)],
    ['limits', snapshotOptionalRecord(input.limits, STORAGE_LIMITS)],
    ['namespace', input.namespace],
    ['operations', snapshotArray(input.operations)],
    ['principal', input.principal]
  ]) as unknown as StorageAuthorityInput
}
