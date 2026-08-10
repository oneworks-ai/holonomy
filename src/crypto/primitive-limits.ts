import { outOfRange } from './errors.js'
import { createNullRecord, freeze } from './intrinsics.js'
import { snapshotStrictRecord } from './object-intrinsics.js'
import type { CryptoPrimitiveLimits } from './types.js'

export const CRYPTO_PRIMITIVE_HARD_CEILINGS: CryptoPrimitiveLimits = freeze({
  maxAadBytes: 64 * 1024,
  maxCompareBytes: 1024 * 1024,
  maxContextBytes: 64 * 1024 * 1024,
  maxContexts: 64,
  maxHmacKeyBytes: 64 * 1024,
  maxInFlightContextBytes: 128 * 1024 * 1024,
  maxRandomBytesPerCall: 64 * 1024,
  maxUpdateBytesPerCall: 1024 * 1024
})

export const DEFAULT_CRYPTO_PRIMITIVE_LIMITS: CryptoPrimitiveLimits = CRYPTO_PRIMITIVE_HARD_CEILINGS

const LIMIT_KEYS = freeze(
  [
    'maxAadBytes',
    'maxCompareBytes',
    'maxContextBytes',
    'maxContexts',
    'maxHmacKeyBytes',
    'maxInFlightContextBytes',
    'maxRandomBytesPerCall',
    'maxUpdateBytesPerCall'
  ] as const
)

export const resolveLimits = (value: unknown): CryptoPrimitiveLimits => {
  if (value === undefined) return DEFAULT_CRYPTO_PRIMITIVE_LIMITS
  const snapshot = snapshotStrictRecord(value, LIMIT_KEYS)
  const resolved = createNullRecord() as Record<keyof CryptoPrimitiveLimits, number>
  for (let index = 0; index < LIMIT_KEYS.length; index += 1) {
    const key = LIMIT_KEYS[index]!
    const candidate = snapshot[key] ?? DEFAULT_CRYPTO_PRIMITIVE_LIMITS[key]
    if (
      typeof candidate !== 'number' ||
      !Number.isSafeInteger(candidate) ||
      candidate <= 0 ||
      candidate > CRYPTO_PRIMITIVE_HARD_CEILINGS[key]
    ) {
      return outOfRange()
    }
    resolved[key] = candidate
  }
  if (
    resolved.maxUpdateBytesPerCall > resolved.maxContextBytes ||
    resolved.maxContextBytes > resolved.maxInFlightContextBytes ||
    resolved.maxAadBytes > resolved.maxInFlightContextBytes ||
    resolved.maxHmacKeyBytes > resolved.maxInFlightContextBytes ||
    resolved.maxCompareBytes * 2 > resolved.maxInFlightContextBytes
  ) {
    return outOfRange()
  }
  return freeze(resolved) as unknown as CryptoPrimitiveLimits
}
