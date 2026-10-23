/* eslint-disable max-lines -- reader locking and cancellation epochs are one body-delivery state machine. */

import { createWebNetworkError } from './errors.js'
import { decodeUtf8 } from './utf8.js'

const APPLY = Reflect.apply
const NATIVE_UINT8_ARRAY = Uint8Array
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as Uint8Array
const BYTE_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'byteLength')!.get!
const TYPED_SET = TYPED_ARRAY_PROTOTYPE.set
const copyBytes = (value: Uint8Array) => {
  // Internal-slot access neither trusts a mutable byteLength getter nor calls
  // a Guest conversion while accounting for a Response body.
  const length = APPLY(BYTE_LENGTH, value, []) as number
  const copy = new NATIVE_UINT8_ARRAY(length)
  APPLY(TYPED_SET, copy, [value])
  return copy
}

// The wrapper distinguishes every Guest value, including null and undefined.
export interface WebBodyFailure {
  readonly reason: unknown
}

export interface WebBodySource {
  cancel(reason?: string): void
  clone?(): WebBodySource
  getAbortFailure?(): WebBodyFailure | undefined
  pull(): Promise<Uint8Array | undefined>
}

class InlineBodySource implements WebBodySource {
  private delivered = false

  constructor(private readonly bytes: Uint8Array) {}

  cancel() {
    this.delivered = true
  }

  clone() {
    return new InlineBodySource(copyBytes(this.bytes))
  }

  async pull() {
    if (this.delivered) return undefined
    this.delivered = true
    return copyBytes(this.bytes)
  }
}

export class WebBodyReader {
  private released = false

  constructor(
    private readonly controller: WebBodyController,
    private readonly owner: symbol
  ) {}

  read() {
    if (this.released) throw new TypeError('Reader lock has been released')
    return this.controller.next(this.owner)
  }

  async cancel(reason?: string) {
    if (this.released) throw new TypeError('Reader lock has been released')
    this.controller.cancel(reason, this.owner)
  }

  releaseLock() {
    if (this.released) return
    this.controller.releaseReader(this.owner)
    this.released = true
  }
}

export class WebBodyStream implements AsyncIterableIterator<Uint8Array> {
  constructor(private readonly controller: WebBodyController) {}

  [Symbol.asyncIterator]() {
    return this
  }

  next() {
    return this.controller.next()
  }

  async return() {
    this.controller.cancelFromStream('reader_closed')
    return { done: true as const, value: undefined }
  }

  getReader() {
    const owner = this.controller.acquireReader()
    return new WebBodyReader(this.controller, owner)
  }

  async cancel(reason?: string) {
    this.controller.cancelFromStream(reason)
  }
}

export class WebBodyController {
  readonly stream: WebBodyStream
  #consumed = false
  #cancellationEpoch = 0
  #done = false
  #readerOwner?: symbol
  #pulling = false
  #terminalDelivered = false
  #source: WebBodySource | undefined
  #onTerminal: (() => void) | undefined

  constructor(
    source: WebBodySource | undefined,
    onTerminal?: () => void
  ) {
    this.#source = source
    this.#onTerminal = onTerminal
    this.stream = new WebBodyStream(this)
  }

  get bodyUsed() {
    return this.#consumed
  }

  get hasBody() {
    return this.#source != null
  }

  clone(onTerminal?: () => void) {
    if (this.#consumed || this.#readerOwner != null) {
      throw new TypeError('Body has already been consumed or locked')
    }
    if (this.#source == null) return new WebBodyController(undefined, onTerminal)
    if (this.#source.clone == null) {
      throw createWebNetworkError('network.not_supported')
    }
    return new WebBodyController(this.#source.clone(), onTerminal)
  }

  acquireReader() {
    if (this.#readerOwner != null) throw new TypeError('Body stream is already locked')
    const owner = Symbol('body-reader')
    this.#readerOwner = owner
    return owner
  }

  releaseReader(owner: symbol) {
    if (this.#readerOwner !== owner) throw new TypeError('Reader does not own this body stream')
    if (this.#pulling) throw new TypeError('Cannot release a reader with a pending read')
    this.#readerOwner = undefined
  }

  async next(owner?: symbol): Promise<IteratorResult<Uint8Array, undefined>> {
    return this.#next(owner)
  }

  async #next(owner?: symbol): Promise<IteratorResult<Uint8Array, undefined>> {
    this.#assertReader(owner)
    if (this.#done) return { done: true, value: undefined }
    if (this.#source == null) {
      this.#done = true
      this.#finish()
      return { done: true, value: undefined }
    }
    if (this.#pulling) throw new TypeError('Body is already being read')
    this.#consumed = true
    this.#pulling = true
    const cancellationEpoch = this.#cancellationEpoch
    try {
      let value: Uint8Array | undefined
      try {
        value = await this.#source.pull()
      } catch (error) {
        this.#finish()
        const abortFailure = this.#source.getAbortFailure?.()
        if (abortFailure != null) throw abortFailure.reason
        if (!this.#isPullCurrent(cancellationEpoch)) throw createWebNetworkError('network.cancelled')
        throw error
      }
      const abortFailure = this.#source.getAbortFailure?.()
      if (abortFailure != null) {
        this.#finish()
        throw abortFailure.reason
      }
      if (!this.#isPullCurrent(cancellationEpoch)) {
        this.#finish()
        throw createWebNetworkError('network.cancelled')
      }
      if (value == null) {
        this.#done = true
        this.#finish()
        return { done: true, value: undefined }
      }
      return { done: false, value }
    } finally {
      this.#pulling = false
    }
  }

  cancel(reason?: string, owner?: symbol) {
    this.#cancel(reason, owner)
  }

  #cancel(reason?: string, owner?: symbol) {
    this.#assertReader(owner, true)
    if (this.#done) return
    if (this.#source?.getAbortFailure?.() != null) {
      this.#finish()
      return
    }
    this.#cancellationEpoch += 1
    this.#consumed = this.#source != null
    this.#done = true
    try {
      this.#source?.cancel(reason)
    } finally {
      this.#finish()
    }
  }

  cancelFromStream(reason?: string) {
    if (this.#readerOwner != null) throw new TypeError('Cannot cancel a locked body stream')
    this.#cancel(reason)
  }

  async bytes(maxBytes: number) {
    if (this.#consumed || this.#readerOwner != null) {
      throw new TypeError('Body has already been consumed or locked')
    }
    if (this.#source == null) {
      this.#done = true
      this.#finish()
      return new NATIVE_UINT8_ARRAY()
    }
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const result = await this.#next()
      if (result.done) break
      const chunk = copyBytes(result.value)
      total += APPLY(BYTE_LENGTH, chunk, []) as number
      if (total > maxBytes) {
        this.#cancel('response_too_large')
        throw createWebNetworkError('network.response_too_large')
      }
      chunks.push(chunk)
    }
    const joined = new NATIVE_UINT8_ARRAY(total)
    let offset = 0
    for (const chunk of chunks) {
      APPLY(TYPED_SET, joined, [chunk, offset])
      offset += APPLY(BYTE_LENGTH, chunk, []) as number
    }
    return joined
  }

  async text(maxBytes: number) {
    return decodeUtf8(await this.bytes(maxBytes))
  }

  #assertReader(owner: symbol | undefined, allowForced = false) {
    if (allowForced && owner == null) return
    if (this.#readerOwner != null && this.#readerOwner !== owner) {
      throw new TypeError('Body stream is locked')
    }
    if (this.#readerOwner == null && owner != null) {
      throw new TypeError('Reader lock has been released')
    }
  }

  #isPullCurrent(cancellationEpoch: number) {
    return !this.#done && this.#cancellationEpoch === cancellationEpoch
  }

  #finish() {
    if (this.#terminalDelivered) return
    this.#terminalDelivered = true
    try {
      this.#onTerminal?.()
    } catch {
      // Capability cleanup cannot replace the already selected body terminal.
    }
  }
}

export const createInlineBody = (bytes: Uint8Array | undefined) => (
  new WebBodyController(bytes == null ? undefined : new InlineBodySource(bytes))
)
