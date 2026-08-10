import { cryptoError, invalidArgumentType } from './errors.js'
import type { RuntimeCryptoErrorCode } from './errors.js'
import {
  createRuntimeSet,
  createRuntimeWeakMap,
  freeze,
  runtimeSetDelete,
  weakMapDelete,
  weakMapGet
} from './intrinsics.js'
import { isForbiddenAsyncOrThenableReturn } from './object-intrinsics.js'
import type { ContextRecord } from './primitive-records.js'
import type {
  CryptoContextStatus,
  CryptoPrimitiveContextHandle,
  CryptoPrimitiveLimits,
  CryptoPrimitiveProvider
} from './types.js'

interface ProviderOutcome<Result> {
  readonly ok: boolean
  readonly returned: boolean
  readonly result?: Result
}

export interface PrimitivePortState {
  readonly activeRecords: Set<ContextRecord>
  readonly contexts: WeakMap<object, ContextRecord>
  disposed: boolean
  generation: number
  readonly limits: CryptoPrimitiveLimits
  providerCallActive: boolean
  providerDisposed: boolean
  providerReentryDetected: boolean
  readonly provider: CryptoPrimitiveProvider
  readonly providerContextOwners: WeakMap<object, ContextRecord>
  providerRecord: ContextRecord | undefined
  reservedContextSlots: number
  retainedBytes: number
  transientBytes: number
}

export const createPrimitivePortState = (
  provider: CryptoPrimitiveProvider,
  limits: CryptoPrimitiveLimits
): PrimitivePortState => ({
  activeRecords: createRuntimeSet<ContextRecord>(),
  contexts: createRuntimeWeakMap<object, ContextRecord>(),
  disposed: false,
  generation: 0,
  limits,
  provider,
  providerCallActive: false,
  providerContextOwners: createRuntimeWeakMap<object, ContextRecord>(),
  providerDisposed: false,
  providerRecord: undefined,
  providerReentryDetected: false,
  reservedContextSlots: 0,
  retainedBytes: 0,
  transientBytes: 0
})

export const assertCallable = (state: PrimitivePortState): void => {
  if (state.providerCallActive) {
    state.providerReentryDetected = true
    throw cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED')
  }
  if (state.disposed) throw cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_DISPOSED')
}

export const assertAdmission = (state: PrimitivePortState, generation: number): void => {
  if (state.disposed || state.generation !== generation) {
    throw cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_DISPOSED')
  }
}

export const callProvider = <Result>(
  state: PrimitivePortState,
  record: ContextRecord | undefined,
  operation: () => Result
): ProviderOutcome<Result> => {
  state.providerCallActive = true
  state.providerReentryDetected = false
  state.providerRecord = record
  let result: Result | undefined
  let ok = true
  let returned = false
  try {
    result = operation()
    returned = true
  } catch {
    ok = false
  }
  if (ok && isForbiddenAsyncOrThenableReturn(result)) ok = false
  if (state.providerReentryDetected) ok = false
  state.providerCallActive = false
  state.providerReentryDetected = false
  state.providerRecord = undefined
  return freeze({ ok, result, returned })
}

export const disposeProviderContext = (state: PrimitivePortState, context: unknown): boolean => {
  const outcome = callProvider(state, undefined, () => state.provider.disposeContext(context))
  return outcome.ok && outcome.result === undefined
}

export const releaseRecord = (
  state: PrimitivePortState,
  record: ContextRecord,
  status: CryptoContextStatus,
  providerAlreadyDisposed = false
): boolean => {
  if (record.state !== 'active') return true
  const context = record.providerContext
  record.providerContext = undefined
  record.state = status
  runtimeSetDelete(state.activeRecords, record)
  state.retainedBytes -= record.retainedBytes
  record.retainedBytes = 0
  if (context === undefined) return true
  weakMapDelete(state.providerContextOwners, context)
  return providerAlreadyDisposed || disposeProviderContext(state, context)
}

export const providerOperation = <Result>(
  state: PrimitivePortState,
  record: ContextRecord,
  operation: () => Result,
  failureCode: RuntimeCryptoErrorCode = 'ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED'
): Result => {
  const outcome = callProvider(state, record, operation)
  if (!outcome.ok) {
    releaseRecord(state, record, 'released')
    throw cryptoError(failureCode)
  }
  return outcome.result as Result
}

export const reserveTransient = (state: PrimitivePortState, byteLength: number): void => {
  if (byteLength > state.limits.maxInFlightContextBytes - state.retainedBytes - state.transientBytes) {
    throw cryptoError('ERR_MOBILE_RUNTIME_RESOURCE_EXHAUSTED')
  }
  state.transientBytes += byteLength
}

export const releaseTransient = (state: PrimitivePortState, byteLength: number): void => {
  state.transientBytes -= byteLength
}

export const reserveRecordBytes = (
  state: PrimitivePortState,
  record: ContextRecord,
  byteLength: number
): void => {
  reserveTransient(state, byteLength)
  state.transientBytes -= byteLength
  record.retainedBytes += byteLength
  state.retainedBytes += byteLength
}

export const requireRecord = (
  state: PrimitivePortState,
  handle: CryptoPrimitiveContextHandle
): ContextRecord => {
  if ((typeof handle !== 'object' && typeof handle !== 'function') || handle === null) {
    return invalidArgumentType()
  }
  const record = weakMapGet(state.contexts, handle as object)
  if (record === undefined) return invalidArgumentType()
  if (record.state === 'active') return record
  if (record.state === 'finalized' && (record.kind === 'hash' || record.kind === 'hmac')) {
    throw cryptoError('ERR_CRYPTO_HASH_FINALIZED')
  }
  if (record.state === 'released') throw cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_DISPOSED')
  throw cryptoError('ERR_CRYPTO_INVALID_STATE')
}

export const terminalFailure = (state: PrimitivePortState, record: ContextRecord, error: Error): never => {
  releaseRecord(state, record, 'released')
  throw error
}
