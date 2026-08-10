import { cryptoError, invalidArgumentType } from './errors.js'
import { runtimeSetValues, weakMapGet } from './intrinsics.js'
import { snapshotStrictRecord } from './object-intrinsics.js'
import { resolveProvider } from './primitive-config.js'
import { createContext } from './primitive-context-create.js'
import { setContextAAD, setContextAuthTag, updateContext } from './primitive-context-data.js'
import { digestContext, finalContext } from './primitive-context-final.js'
import { resolveLimits } from './primitive-limits.js'
import { randomBytes, timingSafeEqual } from './primitive-random.js'
import { callProvider, createPrimitivePortState, releaseRecord } from './primitive-state.js'
import type { PrimitivePortState } from './primitive-state.js'
import type {
  CryptoPrimitiveContextHandle,
  CryptoPrimitiveContextRequest,
  CryptoPrimitiveFinalResult,
  CryptoPrimitiveLimits,
  CryptoPrimitivePortOptions
} from './types.js'

export { CRYPTO_PRIMITIVE_HARD_CEILINGS, DEFAULT_CRYPTO_PRIMITIVE_LIMITS } from './primitive-limits.js'

export class CryptoPrimitivePort {
  readonly limits: CryptoPrimitiveLimits
  readonly #state: PrimitivePortState

  constructor(options: CryptoPrimitivePortOptions) {
    const snapshot = snapshotStrictRecord(options, ['limits', 'provider'], ['provider'])
    const limits = resolveLimits(snapshot.limits)
    this.#state = createPrimitivePortState(resolveProvider(snapshot.provider), limits)
    this.limits = limits
  }

  createContext(request: CryptoPrimitiveContextRequest): CryptoPrimitiveContextHandle {
    return createContext(this.#state, request)
  }

  update(handle: CryptoPrimitiveContextHandle, value: Uint8Array): Uint8Array {
    return updateContext(this.#state, handle, value)
  }

  setAAD(handle: CryptoPrimitiveContextHandle, value: Uint8Array): void {
    setContextAAD(this.#state, handle, value)
  }

  setAuthTag(handle: CryptoPrimitiveContextHandle, value: Uint8Array): void {
    setContextAuthTag(this.#state, handle, value)
  }

  digest(handle: CryptoPrimitiveContextHandle): Uint8Array {
    return digestContext(this.#state, handle)
  }

  final(handle: CryptoPrimitiveContextHandle): CryptoPrimitiveFinalResult {
    return finalContext(this.#state, handle)
  }

  randomBytes(size: number): Uint8Array {
    return randomBytes(this.#state, size)
  }

  timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
    return timingSafeEqual(this.#state, left, right)
  }

  disposeContext(handle: CryptoPrimitiveContextHandle): void {
    const state = this.#state
    if (state.providerCallActive) {
      state.providerReentryDetected = true
      throw cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED')
    }
    if (state.disposed) return
    if ((typeof handle !== 'object' && typeof handle !== 'function') || handle === null) {
      return invalidArgumentType()
    }
    const record = weakMapGet(state.contexts, handle as object)
    if (record === undefined) return invalidArgumentType()
    if (!releaseRecord(state, record, 'released')) {
      throw cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED')
    }
  }

  dispose(): void {
    const state = this.#state
    if (state.providerCallActive) {
      state.providerReentryDetected = true
      throw cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED')
    }
    if (state.disposed) return
    state.disposed = true
    state.generation += 1
    let failed = false
    const activeRecords = runtimeSetValues(state.activeRecords)
    for (let index = 0; index < activeRecords.length; index += 1) {
      if (!releaseRecord(state, activeRecords[index]!, 'released')) failed = true
    }
    if (!state.providerDisposed) {
      state.providerDisposed = true
      const outcome = callProvider(state, undefined, () => state.provider.dispose())
      if (!outcome.ok || outcome.result !== undefined) failed = true
    }
    if (failed) throw cryptoError('ERR_MOBILE_RUNTIME_CRYPTO_OPERATION_FAILED')
  }
}
