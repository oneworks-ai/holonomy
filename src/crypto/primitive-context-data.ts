import { copyInspectedBytes, inspectBytes, zeroBytes } from './binary-intrinsics.js'
import { cryptoError } from './errors.js'
import { copyProviderOutput } from './primitive-output.js'
import {
  assertCallable,
  providerOperation,
  requireRecord,
  reserveRecordBytes,
  terminalFailure
} from './primitive-state.js'
import type { PrimitivePortState } from './primitive-state.js'
import type { CryptoPrimitiveContextHandle } from './types.js'

export const updateContext = (
  state: PrimitivePortState,
  handle: CryptoPrimitiveContextHandle,
  value: Uint8Array
): Uint8Array => {
  assertCallable(state)
  const record = requireRecord(state, handle)
  const inputSnapshot = inspectBytes(value)
  if (inputSnapshot.byteLength > state.limits.maxUpdateBytesPerCall) {
    throw cryptoError('ERR_MOBILE_RUNTIME_RESOURCE_EXHAUSTED')
  }
  if (record.dataBytes + inputSnapshot.byteLength > state.limits.maxContextBytes) {
    throw cryptoError('ERR_MOBILE_RUNTIME_RESOURCE_EXHAUSTED')
  }
  reserveRecordBytes(state, record, inputSnapshot.byteLength)
  let input: Uint8Array | undefined
  try {
    input = copyInspectedBytes(inputSnapshot)
  } catch {
    return terminalFailure(state, record, cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED'))
  }
  record.dataStarted = true
  record.dataBytes += input.byteLength
  let providerOutput: Uint8Array
  try {
    providerOutput = providerOperation(state, record, () => state.provider.update(record.providerContext, input!))
  } finally {
    zeroBytes(input)
  }
  const output = copyProviderOutput(state, record, providerOutput, byteLength => {
    if (record.kind === 'hash' || record.kind === 'hmac') return byteLength === 0
    return record.outputBytes + byteLength <= record.dataBytes
  })
  record.outputBytes += output.byteLength
  return output
}

export const setContextAAD = (
  state: PrimitivePortState,
  handle: CryptoPrimitiveContextHandle,
  value: Uint8Array
): void => {
  assertCallable(state)
  const record = requireRecord(state, handle)
  if ((record.kind !== 'cipher' && record.kind !== 'decipher') || record.dataStarted) {
    throw cryptoError('ERR_CRYPTO_INVALID_STATE')
  }
  const snapshot = inspectBytes(value)
  if (record.aadBytes + snapshot.byteLength > state.limits.maxAadBytes) {
    throw cryptoError('ERR_MOBILE_RUNTIME_RESOURCE_EXHAUSTED')
  }
  reserveRecordBytes(state, record, snapshot.byteLength)
  let aad: Uint8Array | undefined
  try {
    aad = copyInspectedBytes(snapshot)
  } catch {
    return terminalFailure(state, record, cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED'))
  }
  record.aadBytes += aad.byteLength
  try {
    const output = providerOperation(state, record, () => state.provider.setAAD(record.providerContext, aad!))
    if (output !== undefined) {
      return terminalFailure(state, record, cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED'))
    }
  } finally {
    zeroBytes(aad)
  }
}

export const setContextAuthTag = (
  state: PrimitivePortState,
  handle: CryptoPrimitiveContextHandle,
  value: Uint8Array
): void => {
  assertCallable(state)
  const record = requireRecord(state, handle)
  if (record.kind !== 'decipher' || record.authTagSet) {
    throw cryptoError('ERR_CRYPTO_INVALID_STATE')
  }
  const snapshot = inspectBytes(value)
  if (snapshot.byteLength !== 16) throw cryptoError('ERR_CRYPTO_INVALID_AUTH_TAG')
  reserveRecordBytes(state, record, snapshot.byteLength)
  let authTag: Uint8Array | undefined
  try {
    authTag = copyInspectedBytes(snapshot)
  } catch {
    return terminalFailure(state, record, cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED'))
  }
  record.authTagSet = true
  try {
    const output = providerOperation(state, record, () => state.provider.setAuthTag(record.providerContext, authTag!))
    if (output !== undefined) {
      return terminalFailure(state, record, cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED'))
    }
  } finally {
    zeroBytes(authTag)
  }
}
