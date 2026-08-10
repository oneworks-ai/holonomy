import { copyInspectedBytes, inspectBytes, zeroBytes } from './binary-intrinsics.js'
import type { TypedArraySnapshot } from './binary-intrinsics.js'
import { cryptoError } from './errors.js'
import type { ContextRecord } from './primitive-records.js'
import { releaseTransient, reserveTransient, terminalFailure } from './primitive-state.js'
import type { PrimitivePortState } from './primitive-state.js'

export const copyProviderOutput = (
  state: PrimitivePortState,
  record: ContextRecord,
  value: unknown,
  validateLength: (byteLength: number) => boolean
): Uint8Array => {
  let snapshot: TypedArraySnapshot
  try {
    snapshot = inspectBytes(value)
  } catch {
    return terminalFailure(state, record, cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED'))
  }
  if (state.disposed) {
    return terminalFailure(state, record, cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED'))
  }
  if (!validateLength(snapshot.byteLength)) {
    zeroBytes(snapshot.bytes, state.limits.maxInFlightContextBytes)
    return terminalFailure(state, record, cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED'))
  }
  try {
    reserveTransient(state, snapshot.byteLength)
  } catch (error) {
    zeroBytes(snapshot.bytes, state.limits.maxInFlightContextBytes)
    return terminalFailure(state, record, error as Error)
  }
  try {
    return copyInspectedBytes(snapshot)
  } catch {
    return terminalFailure(state, record, cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED'))
  } finally {
    zeroBytes(snapshot.bytes, state.limits.maxInFlightContextBytes)
    releaseTransient(state, snapshot.byteLength)
  }
}
