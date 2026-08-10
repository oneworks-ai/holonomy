import { copyInspectedBytes, inspectBytes, zeroBytes } from './binary-intrinsics.js'
import type { TypedArraySnapshot } from './binary-intrinsics.js'
import { cryptoError, invalidArgumentType, outOfRange } from './errors.js'
import { assertCallable, callProvider, releaseTransient, reserveTransient } from './primitive-state.js'
import type { PrimitivePortState } from './primitive-state.js'

export const randomBytes = (state: PrimitivePortState, size: number): Uint8Array => {
  assertCallable(state)
  if (typeof size !== 'number') return invalidArgumentType()
  if (!Number.isSafeInteger(size) || size < 0) return outOfRange()
  if (size > state.limits.maxRandomBytesPerCall) {
    throw cryptoError('ERR_HOLONOMY_RESOURCE_EXHAUSTED')
  }
  reserveTransient(state, size)
  let providerOutput: Uint8Array | undefined
  try {
    const outcome = callProvider(state, undefined, () => state.provider.randomBytes(size))
    if (!outcome.ok) throw cryptoError('ERR_CRYPTO_RANDOM_UNAVAILABLE')
    providerOutput = outcome.result as Uint8Array
    let snapshot: TypedArraySnapshot
    try {
      snapshot = inspectBytes(providerOutput)
    } catch {
      throw cryptoError('ERR_CRYPTO_RANDOM_UNAVAILABLE')
    }
    if (snapshot.byteLength !== size) throw cryptoError('ERR_CRYPTO_RANDOM_UNAVAILABLE')
    reserveTransient(state, snapshot.byteLength)
    try {
      return copyInspectedBytes(snapshot)
    } finally {
      zeroBytes(snapshot.bytes, state.limits.maxRandomBytesPerCall)
      releaseTransient(state, snapshot.byteLength)
    }
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'ERR_HOLONOMY_RESOURCE_EXHAUSTED'
    ) {
      throw error
    }
    throw cryptoError('ERR_CRYPTO_RANDOM_UNAVAILABLE')
  } finally {
    zeroBytes(providerOutput, state.limits.maxRandomBytesPerCall)
    releaseTransient(state, size)
  }
}

export const timingSafeEqual = (
  state: PrimitivePortState,
  left: Uint8Array,
  right: Uint8Array
): boolean => {
  assertCallable(state)
  const firstSnapshot = inspectBytes(left)
  const secondSnapshot = inspectBytes(right)
  if (firstSnapshot.byteLength !== secondSnapshot.byteLength) {
    throw cryptoError('ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH')
  }
  if (firstSnapshot.byteLength > state.limits.maxCompareBytes) {
    throw cryptoError('ERR_HOLONOMY_RESOURCE_EXHAUSTED')
  }
  const transientBytes = firstSnapshot.byteLength + secondSnapshot.byteLength
  reserveTransient(state, transientBytes)
  let first: Uint8Array | undefined
  let second: Uint8Array | undefined
  try {
    first = copyInspectedBytes(firstSnapshot)
    second = copyInspectedBytes(secondSnapshot)
    const outcome = callProvider(state, undefined, () => state.provider.timingSafeEqual(first!, second!))
    if (!outcome.ok || typeof outcome.result !== 'boolean') {
      throw cryptoError('ERR_HOLONOMY_CRYPTO_OPERATION_FAILED')
    }
    return outcome.result
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw error
    throw cryptoError('ERR_HOLONOMY_CRYPTO_OPERATION_FAILED')
  } finally {
    zeroBytes(first)
    zeroBytes(second)
    releaseTransient(state, transientBytes)
  }
}
