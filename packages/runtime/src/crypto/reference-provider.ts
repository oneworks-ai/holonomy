import { Aes256Gcm } from './aes-gcm.js'
import { outOfRange } from './errors.js'
import {
  createNullRecord,
  createRuntimeSet,
  createRuntimeWeakMap,
  freeze,
  runtimeSetAdd,
  runtimeSetDelete,
  runtimeSetValues,
  weakMapDelete,
  weakMapGet,
  weakMapSet
} from './intrinsics.js'
import { snapshotStrictRecord } from './object-intrinsics.js'
import { HmacSha256, ShaDigest } from './sha.js'
import type {
  CryptoPrimitiveContextRequest,
  CryptoPrimitiveProvider,
  CryptoPrimitiveProviderFinalResult
} from './types.js'

export interface DeterministicCryptoPrimitiveProviderOptions {
  readonly seed?: number
}

type ReferenceContext =
  | { readonly digest: HmacSha256; readonly kind: 'hmac' }
  | { readonly digest: ShaDigest; readonly kind: 'hash' }
  | { readonly cipher: Aes256Gcm; readonly kind: 'cipher' | 'decipher' }

const resolveSeed = (options: DeterministicCryptoPrimitiveProviderOptions | undefined): number => {
  if (options === undefined) return 0x6D2B79F5
  const snapshot = snapshotStrictRecord(options, ['seed'])
  const seed = snapshot.seed ?? 0x6D2B79F5
  if (
    typeof seed !== 'number' ||
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    seed > 0xFFFF_FFFF
  ) {
    return outOfRange()
  }
  return seed === 0 ? 0x6D2B79F5 : seed
}

/**
 * Deterministic, pure-JS provider for conformance tests and non-production hosts.
 * It deliberately does not claim production-quality entropy.
 */
export const createDeterministicCryptoPrimitiveProvider = (
  options?: DeterministicCryptoPrimitiveProviderOptions
): CryptoPrimitiveProvider => {
  const contexts = createRuntimeWeakMap<object, ReferenceContext>()
  const handles = createRuntimeSet<object>()
  let randomState = resolveSeed(options) >>> 0

  const requireContext = (handle: unknown): ReferenceContext => {
    if ((typeof handle !== 'object' && typeof handle !== 'function') || handle === null) {
      throw new Error('invalid reference context')
    }
    const context = weakMapGet(contexts, handle as object)
    if (context === undefined) throw new Error('invalid reference context')
    return context
  }

  const createContext = (request: CryptoPrimitiveContextRequest): object => {
    const handle = freeze(createNullRecord()) as object
    let context: ReferenceContext
    if (request.kind === 'hash') {
      context = { digest: new ShaDigest(request.algorithm), kind: 'hash' }
    } else if (request.kind === 'hmac') {
      context = { digest: new HmacSha256(request.key), kind: 'hmac' }
    } else {
      context = {
        cipher: new Aes256Gcm(request.key, request.iv, request.kind === 'decipher'),
        kind: request.kind
      }
    }
    weakMapSet(contexts, handle, context)
    runtimeSetAdd(handles, handle)
    return handle
  }

  const update = (handle: unknown, input: Uint8Array): Uint8Array => {
    const context = requireContext(handle)
    if (context.kind === 'hash' || context.kind === 'hmac') {
      context.digest.update(input)
      return new Uint8Array(0)
    }
    return context.cipher.update(input)
  }

  const setAAD = (handle: unknown, aad: Uint8Array): void => {
    const context = requireContext(handle)
    if (context.kind !== 'cipher' && context.kind !== 'decipher') {
      throw new Error('invalid reference context')
    }
    context.cipher.setAAD(aad)
  }

  const setAuthTag = (handle: unknown, authTag: Uint8Array): void => {
    const context = requireContext(handle)
    if (context.kind !== 'decipher') throw new Error('invalid reference context')
    context.cipher.setAuthTag(authTag)
  }

  const digest = (handle: unknown): Uint8Array => {
    const context = requireContext(handle)
    if (context.kind !== 'hash' && context.kind !== 'hmac') {
      throw new Error('invalid reference context')
    }
    return context.digest.digest()
  }

  const final = (handle: unknown): CryptoPrimitiveProviderFinalResult => {
    const context = requireContext(handle)
    if (context.kind !== 'cipher' && context.kind !== 'decipher') {
      throw new Error('invalid reference context')
    }
    return context.cipher.final()
  }

  const disposeContext = (handle: unknown): void => {
    const context = requireContext(handle)
    weakMapDelete(contexts, handle as object)
    runtimeSetDelete(handles, handle as object)
    if (context.kind === 'hash' || context.kind === 'hmac') {
      context.digest.dispose()
    } else {
      context.cipher.dispose()
    }
  }

  const randomBytes = (size: number): Uint8Array => {
    const output = new Uint8Array(size)
    let word = 0
    for (let index = 0; index < size; index += 1) {
      if (index % 4 === 0) {
        let next = randomState
        next ^= next << 13
        next ^= next >>> 17
        next ^= next << 5
        randomState = next >>> 0
        word = randomState
      }
      output[index] = word >>> ((index % 4) * 8)
    }
    return output
  }

  const timingSafeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
    let difference = 0
    for (let index = 0; index < left.byteLength; index += 1) {
      difference |= left[index]! ^ right[index]!
    }
    return difference === 0
  }

  const dispose = (): void => {
    const activeHandles = runtimeSetValues(handles)
    for (let index = 0; index < activeHandles.length; index += 1) {
      disposeContext(activeHandles[index]!)
    }
  }

  return freeze({
    createContext,
    digest,
    dispose,
    disposeContext,
    final,
    randomBytes,
    setAAD,
    setAuthTag,
    timingSafeEqual,
    update
  })
}
