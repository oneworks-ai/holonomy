import { zeroBytes } from './binary-intrinsics.js'
import { cryptoError } from './errors.js'
import { freeze } from './intrinsics.js'
import { snapshotStrictRecord } from './object-intrinsics.js'
import { copyProviderOutput } from './primitive-output.js'
import { assertCallable, providerOperation, releaseRecord, requireRecord, terminalFailure } from './primitive-state.js'
import type { PrimitivePortState } from './primitive-state.js'
import type { CryptoPrimitiveContextHandle, CryptoPrimitiveFinalResult } from './types.js'

export const digestContext = (
  state: PrimitivePortState,
  handle: CryptoPrimitiveContextHandle
): Uint8Array => {
  assertCallable(state)
  const record = requireRecord(state, handle)
  if (record.kind !== 'hash' && record.kind !== 'hmac') {
    throw cryptoError('ERR_CRYPTO_INVALID_STATE')
  }
  const providerOutput = providerOperation(state, record, () => state.provider.digest(record.providerContext))
  const expectedLength = record.kind === 'hmac' || record.algorithm === 'sha256' ? 32 : 20
  const output = copyProviderOutput(
    state,
    record,
    providerOutput,
    byteLength => byteLength === expectedLength
  )
  if (!releaseRecord(state, record, 'finalized')) {
    zeroBytes(output)
    throw cryptoError('ERR_HOLONOMY_CRYPTO_OPERATION_FAILED')
  }
  return output
}

const inspectFinalResult = (
  state: PrimitivePortState,
  handle: CryptoPrimitiveContextHandle
) => {
  assertCallable(state)
  const record = requireRecord(state, handle)
  if (record.kind !== 'cipher' && record.kind !== 'decipher') {
    throw cryptoError('ERR_CRYPTO_INVALID_STATE')
  }
  if (record.kind === 'decipher' && !record.authTagSet) {
    return terminalFailure(state, record, cryptoError('ERR_CRYPTO_INVALID_AUTH_TAG'))
  }
  const providerResult = providerOperation(state, record, () => state.provider.final(record.providerContext))
  try {
    const snapshot = record.kind === 'cipher'
      ? snapshotStrictRecord(providerResult, ['authTag', 'output'], ['authTag', 'output'])
      : snapshotStrictRecord(providerResult, ['authenticated', 'output'], [
        'authenticated',
        'output'
      ])
    return { record, snapshot }
  } catch {
    return terminalFailure(state, record, cryptoError('ERR_HOLONOMY_CRYPTO_OPERATION_FAILED'))
  }
}

export const finalContext = (
  state: PrimitivePortState,
  handle: CryptoPrimitiveContextHandle
): CryptoPrimitiveFinalResult => {
  const { record, snapshot } = inspectFinalResult(state, handle)
  if (record.kind === 'decipher') {
    if (typeof snapshot.authenticated !== 'boolean') {
      zeroBytes(snapshot.output, state.limits.maxInFlightContextBytes)
      return terminalFailure(state, record, cryptoError('ERR_HOLONOMY_CRYPTO_OPERATION_FAILED'))
    }
    if (!snapshot.authenticated) {
      zeroBytes(snapshot.output, state.limits.maxInFlightContextBytes)
      return terminalFailure(state, record, cryptoError('ERR_CRYPTO_INVALID_AUTH_TAG'))
    }
    const output = copyProviderOutput(
      state,
      record,
      snapshot.output,
      byteLength => record.outputBytes + byteLength === record.dataBytes
    )
    if (!releaseRecord(state, record, 'finalized')) {
      zeroBytes(output)
      throw cryptoError('ERR_HOLONOMY_CRYPTO_OPERATION_FAILED')
    }
    return freeze({ output })
  }
  const output = copyProviderOutput(
    state,
    record,
    snapshot.output,
    byteLength => record.outputBytes + byteLength === record.dataBytes
  )
  let authTag: Uint8Array
  try {
    authTag = copyProviderOutput(
      state,
      record,
      snapshot.authTag,
      byteLength => byteLength === 16
    )
  } catch (error) {
    zeroBytes(output)
    throw error
  }
  if (!releaseRecord(state, record, 'finalized')) {
    zeroBytes(output)
    zeroBytes(authTag)
    throw cryptoError('ERR_HOLONOMY_CRYPTO_OPERATION_FAILED')
  }
  return freeze({ authTag, output })
}
