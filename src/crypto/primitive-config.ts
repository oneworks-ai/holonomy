import { inspectBytes } from './binary-intrinsics.js'
import { cryptoError, invalidArgumentType } from './errors.js'
import { bindFunction, createNullRecord, freeze, objectKeys } from './intrinsics.js'
import { snapshotStrictRecord } from './object-intrinsics.js'
import type { InspectedContextRequest } from './primitive-records.js'
import type { CryptoPrimitiveProvider } from './types.js'

const PROVIDER_KEYS = freeze(
  [
    'createContext',
    'digest',
    'dispose',
    'disposeContext',
    'final',
    'randomBytes',
    'setAAD',
    'setAuthTag',
    'timingSafeEqual',
    'update'
  ] as const
)

export const resolveProvider = (value: unknown): CryptoPrimitiveProvider => {
  const snapshot = snapshotStrictRecord(value, PROVIDER_KEYS, PROVIDER_KEYS)
  const bound = createNullRecord()
  for (let index = 0; index < PROVIDER_KEYS.length; index += 1) {
    const key = PROVIDER_KEYS[index]!
    const callback = snapshot[key]
    if (typeof callback !== 'function') return invalidArgumentType()
    bound[key] = bindFunction(callback as (...args: never[]) => unknown, value)
  }
  return freeze(bound) as unknown as CryptoPrimitiveProvider
}

const assertExactKeys = (
  snapshot: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): void => {
  const present = objectKeys(snapshot)
  if (present.length !== expected.length) return invalidArgumentType()
  for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
    const key = expected[expectedIndex]!
    let found = false
    for (let presentIndex = 0; presentIndex < present.length; presentIndex += 1) {
      const candidate = present[presentIndex]!
      if (candidate === key) {
        found = true
        break
      }
    }
    if (!found) return invalidArgumentType()
  }
}

export const inspectContextRequest = (value: unknown): InspectedContextRequest => {
  const snapshot = snapshotStrictRecord(
    value,
    ['algorithm', 'iv', 'key', 'kind'],
    ['algorithm', 'kind']
  )
  if (typeof snapshot.kind !== 'string' || typeof snapshot.algorithm !== 'string') {
    return invalidArgumentType()
  }
  if (snapshot.kind === 'hash') {
    assertExactKeys(snapshot, ['algorithm', 'kind'])
    if (snapshot.algorithm !== 'sha1' && snapshot.algorithm !== 'sha256') {
      throw cryptoError('ERR_CRYPTO_UNKNOWN_HASH')
    }
    return freeze({ algorithm: snapshot.algorithm, kind: 'hash' })
  }
  if (snapshot.kind === 'hmac') {
    assertExactKeys(snapshot, ['algorithm', 'key', 'kind'])
    if (snapshot.algorithm !== 'sha256') throw cryptoError('ERR_CRYPTO_UNKNOWN_HASH')
    return freeze({ algorithm: 'sha256', key: inspectBytes(snapshot.key), kind: 'hmac' })
  }
  if (snapshot.kind === 'cipher' || snapshot.kind === 'decipher') {
    assertExactKeys(snapshot, ['algorithm', 'iv', 'key', 'kind'])
    if (snapshot.algorithm !== 'aes-256-gcm') return invalidArgumentType()
    return freeze({
      algorithm: 'aes-256-gcm',
      iv: inspectBytes(snapshot.iv),
      key: inspectBytes(snapshot.key),
      kind: snapshot.kind
    })
  }
  return invalidArgumentType()
}
