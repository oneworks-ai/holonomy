import { copyInspectedBytes, zeroBytes } from './binary-intrinsics.js'
import { cryptoError } from './errors.js'
import {
  createNullRecord,
  freeze,
  runtimeSetAdd,
  runtimeSetDelete,
  runtimeSetSize,
  weakMapDelete,
  weakMapGet,
  weakMapHas,
  weakMapSet
} from './intrinsics.js'
import { inspectContextRequest } from './primitive-config.js'
import type { ContextRecord, InspectedContextRequest } from './primitive-records.js'
import {
  assertAdmission,
  assertCallable,
  callProvider,
  disposeProviderContext,
  releaseRecord
} from './primitive-state.js'
import type { PrimitivePortState } from './primitive-state.js'
import type { CryptoPrimitiveContextHandle, CryptoPrimitiveContextRequest } from './types.js'

const initialContextBytes = (request: InspectedContextRequest): number =>
  request.kind === 'hash'
    ? 0
    : request.kind === 'hmac'
    ? request.key.byteLength
    : request.key.byteLength + request.iv.byteLength

const validateContextAdmission = (
  state: PrimitivePortState,
  request: InspectedContextRequest,
  initialBytes: number
): void => {
  if (runtimeSetSize(state.activeRecords) + state.reservedContextSlots >= state.limits.maxContexts) {
    throw cryptoError('ERR_MOBILE_RUNTIME_RESOURCE_EXHAUSTED')
  }
  if (request.kind === 'hmac' && request.key.byteLength > state.limits.maxHmacKeyBytes) {
    throw cryptoError('ERR_MOBILE_RUNTIME_RESOURCE_EXHAUSTED')
  }
  if (request.kind === 'cipher' || request.kind === 'decipher') {
    if (request.key.byteLength !== 32) throw cryptoError('ERR_CRYPTO_INVALID_KEYLEN')
    if (request.iv.byteLength !== 12) throw cryptoError('ERR_CRYPTO_INVALID_IV')
  }
  if (initialBytes > state.limits.maxInFlightContextBytes - state.retainedBytes - state.transientBytes) {
    throw cryptoError('ERR_MOBILE_RUNTIME_RESOURCE_EXHAUSTED')
  }
}

const providerRequest = (
  request: InspectedContextRequest,
  keyCopy: Uint8Array | undefined,
  ivCopy: Uint8Array | undefined
): CryptoPrimitiveContextRequest =>
  request.kind === 'hash'
    ? freeze({ algorithm: request.algorithm, kind: 'hash' })
    : request.kind === 'hmac'
    ? freeze({ algorithm: 'sha256', key: keyCopy!, kind: 'hmac' })
    : freeze({
      algorithm: 'aes-256-gcm',
      iv: ivCopy!,
      key: keyCopy!,
      kind: request.kind
    })

export const createContext = (
  state: PrimitivePortState,
  rawRequest: CryptoPrimitiveContextRequest
): CryptoPrimitiveContextHandle => {
  assertCallable(state)
  const generation = state.generation
  const request = inspectContextRequest(rawRequest)
  assertAdmission(state, generation)
  const initialBytes = initialContextBytes(request)
  validateContextAdmission(state, request, initialBytes)
  state.reservedContextSlots += 1
  state.retainedBytes += initialBytes

  let keyCopy: Uint8Array | undefined
  let ivCopy: Uint8Array | undefined
  let context: unknown
  let providerCreated = false
  let createdHandle: object | undefined
  let createdRecord: ContextRecord | undefined
  try {
    if (request.kind === 'hmac') keyCopy = copyInspectedBytes(request.key)
    if (request.kind === 'cipher' || request.kind === 'decipher') {
      keyCopy = copyInspectedBytes(request.key)
      ivCopy = copyInspectedBytes(request.iv)
    }
    const outcome = callProvider(
      state,
      undefined,
      () => state.provider.createContext(providerRequest(request, keyCopy, ivCopy))
    )
    context = outcome.result
    providerCreated = outcome.returned
    if (!outcome.ok) throw cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED')
    assertAdmission(state, generation)
    if ((typeof context !== 'object' && typeof context !== 'function') || context === null) {
      disposeProviderContext(state, context)
      providerCreated = false
      throw cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED')
    }
    if (weakMapHas(state.providerContextOwners, context as object)) {
      const existing = weakMapGet(state.providerContextOwners, context as object)
      disposeProviderContext(state, context)
      providerCreated = false
      if (existing !== undefined) releaseRecord(state, existing, 'released', true)
      throw cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED')
    }
    assertAdmission(state, generation)
    const record: ContextRecord = {
      aadBytes: 0,
      algorithm: request.algorithm,
      authTagSet: false,
      dataBytes: 0,
      dataStarted: false,
      kind: request.kind,
      outputBytes: 0,
      providerContext: context as object,
      retainedBytes: initialBytes,
      state: 'active'
    }
    const handle = freeze(createNullRecord()) as unknown as CryptoPrimitiveContextHandle
    createdHandle = handle as object
    createdRecord = record
    weakMapSet(state.contexts, handle as object, record)
    weakMapSet(state.providerContextOwners, context as object, record)
    runtimeSetAdd(state.activeRecords, record)
    providerCreated = false
    state.reservedContextSlots -= 1
    return handle
  } catch (error) {
    if (createdHandle !== undefined) weakMapDelete(state.contexts, createdHandle)
    if (createdRecord !== undefined) {
      runtimeSetDelete(state.activeRecords, createdRecord)
      createdRecord.state = 'released'
      createdRecord.providerContext = undefined
      createdRecord.retainedBytes = 0
    }
    if (context !== null && (typeof context === 'object' || typeof context === 'function')) {
      weakMapDelete(state.providerContextOwners, context as object)
    }
    if (providerCreated) disposeProviderContext(state, context)
    state.retainedBytes -= initialBytes
    state.reservedContextSlots -= 1
    if (error instanceof Error && 'code' in error) throw error
    throw cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED')
  } finally {
    zeroBytes(keyCopy)
    zeroBytes(ivCopy)
  }
}
