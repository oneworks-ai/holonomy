import { CapabilityInvocationError } from '@holonomyjs/runtime/kernel/errors'
import { sha256Hex } from '@holonomyjs/runtime/module-loader/sha256'
import { decodeBase64, encodeBase64 } from '@holonomyjs/runtime/node-compat/encoding'

import type { NetworkRequestBodyMetadataV1 } from './network-invocation-types.js'

export interface NetworkRequestBodyReaderBindingV1 {
  readonly bodySha256: string
  readonly kind: 'networkRequestBodyReader'
  readonly generation: number
  readonly requestId: string
  read(options?: Readonly<{ maxBytes: number }>): Promise<Uint8Array>
}

interface ReaderState {
  active: boolean
  bytes: Uint8Array
  closed: boolean
  copies: Set<Uint8Array>
  release?: () => void
  signal?: AbortSignal
  stop?: () => void
  used: boolean
}

const states = new WeakMap<NetworkRequestBodyReaderBindingV1, ReaderState>()
const FILL = Uint8Array.prototype.fill
const APPLY = Reflect.apply
const BYTES = Uint8Array
const unavailable = (): never => {
  throw new TypeError('Network request body reader is unavailable')
}
const invalidBody = (): never => {
  throw new CapabilityInvocationError('argument.invalid', 'network.fetch.request')
}
const closeState = (state: ReaderState) => {
  if (state.closed) return
  state.closed = true
  try {
    state.stop?.()
  } catch { /* Cleanup still revokes and zeroes the reader. */ }
  for (const bytes of [state.bytes, ...state.copies]) {
    try {
      APPLY(FILL, bytes, [0])
    } catch { /* Detached retained copies cannot be zeroed. */ }
  }
  state.copies.clear()
  state.release?.()
  state.release = undefined
}

/** Trusted Broker activation; arbitrary lookalike bindings cannot be installed. */
export const activateNetworkRequestBodyReaderV1 = (
  binding: NetworkRequestBodyReaderBindingV1,
  requestId: string,
  bodySha256: unknown,
  signal: AbortSignal
) => {
  const state = states.get(binding)
  if (
    state == null || state.closed || state.active || binding.requestId !== requestId ||
    binding.bodySha256 !== bodySha256
  ) {
    return unavailable()
  }
  state.active = true
  state.signal = signal
  const abort = () => closeState(state)
  signal.addEventListener('abort', abort, { once: true })
  state.stop = () => signal.removeEventListener('abort', abort)
  if (signal.aborted) abort()
  return () => closeState(state)
}

export class NetworkRequestBodyReaderRegistryV1 {
  readonly timeoutMs: number
  readonly #active = new Set<ReaderState>()
  readonly #maxReadBytes: number
  readonly #maxReads: number
  readonly #generation: number
  #closed = false
  #reads = 0
  #activeBytes = 0

  constructor(options: Readonly<{ generation: number; maxReadBytes: number; maxReads: number; timeoutMs?: number }>) {
    if (
      !Number.isSafeInteger(options.maxReadBytes) || options.maxReadBytes < 1 || options.maxReadBytes > 1024 * 1024 ||
      !Number.isSafeInteger(options.maxReads) || options.maxReads < 1 || options.maxReads > 1024 ||
      !Number.isSafeInteger(options.generation) || options.generation < 1 ||
      !Number.isSafeInteger(options.timeoutMs ?? 30_000) || (options.timeoutMs ?? 30_000) < 1 ||
      (options.timeoutMs ?? 30_000) > 120_000
    ) {
      throw new TypeError('Invalid Network request body reader limits')
    }
    this.#maxReadBytes = options.maxReadBytes
    this.#maxReads = options.maxReads
    this.#generation = options.generation
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const state of this.#active) closeState(state)
    this.#active.clear()
  }

  create(body: NetworkRequestBodyMetadataV1, requestId: string, base64: string | undefined) {
    if (this.#closed) return unavailable()
    if (
      body.kind === 'none' || body.length > this.#maxReadBytes || base64 == null || this.#reads >= this.#maxReads ||
      this.#active.size >= Math.min(this.#maxReads, 64) || this.#activeBytes + body.length > 1024 * 1024
    ) {
      return undefined
    }
    if (typeof base64 !== 'string' || base64.length > Math.ceil(this.#maxReadBytes / 3) * 4) return invalidBody()
    const bytes = decodeBase64(base64)
    if (encodeBase64(bytes, false) !== base64 || bytes.byteLength !== body.length || sha256Hex(bytes) !== body.sha256) {
      APPLY(FILL, bytes, [0])
      return invalidBody()
    }
    const state: ReaderState = { active: false, bytes, closed: false, copies: new Set(), used: false }
    this.#active.add(state)
    this.#activeBytes += bytes.byteLength
    state.release = () => {
      this.#active.delete(state)
      this.#activeBytes -= bytes.byteLength
    }
    const binding: NetworkRequestBodyReaderBindingV1 = Object.freeze({
      bodySha256: body.sha256,
      kind: 'networkRequestBodyReader',
      generation: this.#generation,
      requestId,
      read: async (options?: Readonly<{ maxBytes: number }>) => {
        if (
          this.#closed || !state.active || state.closed || state.used || state.signal?.aborted ||
          this.#reads >= this.#maxReads
        ) {
          return unavailable()
        }
        const descriptor = options != null && typeof options === 'object'
          ? Object.getOwnPropertyDescriptor(options, 'maxBytes')
          : undefined
        const maximum = options === undefined
          ? this.#maxReadBytes
          : descriptor != null && 'value' in descriptor
          ? descriptor.value as number
          : Number.NaN
        if (
          !Number.isSafeInteger(maximum) || maximum < 1 ||
          options != null && Object.keys(options).some(key => key !== 'maxBytes')
        ) {
          return unavailable()
        }
        state.used = true
        this.#reads += 1
        const copy = new BYTES(Math.min(maximum, bytes.byteLength))
        for (let index = 0; index < copy.byteLength; index++) copy[index] = bytes[index]!
        state.copies.add(copy)
        return copy
      }
    })
    states.set(binding, state)
    return Object.freeze({
      binding,
      close: () => {
        closeState(state)
      }
    })
  }
}
