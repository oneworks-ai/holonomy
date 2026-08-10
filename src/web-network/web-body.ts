/* eslint-disable max-lines -- reader locking and cancellation epochs are one body-delivery state machine. */

import { createWebNetworkError } from './errors.js'
import { decodeUtf8 } from './utf8.js'

export interface WebBodySource {
  cancel(reason?: string): void
  clone?(): WebBodySource
  pull(): Promise<Uint8Array | undefined>
}

class InlineBodySource implements WebBodySource {
  private delivered = false

  constructor(private readonly bytes: Uint8Array) {}

  cancel() {
    this.delivered = true
  }

  clone() {
    return new InlineBodySource(this.bytes.slice())
  }

  async pull() {
    if (this.delivered) return undefined
    this.delivered = true
    return this.bytes.slice()
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
  private consumed = false
  private cancellationEpoch = 0
  private done = false
  private readerOwner?: symbol
  private pulling = false

  constructor(private readonly source: WebBodySource | undefined) {
    this.stream = new WebBodyStream(this)
  }

  get bodyUsed() {
    return this.consumed
  }

  get hasBody() {
    return this.source != null
  }

  clone() {
    if (this.consumed || this.readerOwner != null) {
      throw new TypeError('Body has already been consumed or locked')
    }
    if (this.source == null) return new WebBodyController(undefined)
    if (this.source.clone == null) {
      throw createWebNetworkError('network.not_supported')
    }
    return new WebBodyController(this.source.clone())
  }

  acquireReader() {
    if (this.readerOwner != null) throw new TypeError('Body stream is already locked')
    const owner = Symbol('body-reader')
    this.readerOwner = owner
    return owner
  }

  releaseReader(owner: symbol) {
    if (this.readerOwner !== owner) throw new TypeError('Reader does not own this body stream')
    if (this.pulling) throw new TypeError('Cannot release a reader with a pending read')
    this.readerOwner = undefined
  }

  async next(owner?: symbol): Promise<IteratorResult<Uint8Array, undefined>> {
    this.assertReader(owner)
    if (this.done || this.source == null) return { done: true, value: undefined }
    if (this.pulling) throw new TypeError('Body is already being read')
    this.consumed = true
    this.pulling = true
    const cancellationEpoch = this.cancellationEpoch
    try {
      let value: Uint8Array | undefined
      try {
        value = await this.source.pull()
      } catch (error) {
        if (!this.isPullCurrent(cancellationEpoch)) throw createWebNetworkError('network.cancelled')
        throw error
      }
      if (!this.isPullCurrent(cancellationEpoch)) {
        throw createWebNetworkError('network.cancelled')
      }
      if (value == null) {
        this.done = true
        return { done: true, value: undefined }
      }
      return { done: false, value }
    } finally {
      this.pulling = false
    }
  }

  cancel(reason?: string, owner?: symbol) {
    this.assertReader(owner, true)
    if (this.done) return
    this.cancellationEpoch += 1
    this.consumed = this.source != null
    this.done = true
    this.source?.cancel(reason)
  }

  cancelFromStream(reason?: string) {
    if (this.readerOwner != null) throw new TypeError('Cannot cancel a locked body stream')
    this.cancel(reason)
  }

  async bytes(maxBytes: number) {
    if (this.consumed || this.readerOwner != null) {
      throw new TypeError('Body has already been consumed or locked')
    }
    if (this.source == null) return new Uint8Array()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const result = await this.next()
      if (result.done) break
      total += result.value.byteLength
      if (total > maxBytes) {
        this.cancel('response_too_large')
        throw createWebNetworkError('network.response_too_large')
      }
      chunks.push(result.value)
    }
    const joined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return joined
  }

  async text(maxBytes: number) {
    return decodeUtf8(await this.bytes(maxBytes))
  }

  private assertReader(owner: symbol | undefined, allowForced = false) {
    if (allowForced && owner == null) return
    if (this.readerOwner != null && this.readerOwner !== owner) {
      throw new TypeError('Body stream is locked')
    }
    if (this.readerOwner == null && owner != null) {
      throw new TypeError('Reader lock has been released')
    }
  }

  private isPullCurrent(cancellationEpoch: number) {
    return !this.done && this.cancellationEpoch === cancellationEpoch
  }
}

export const createInlineBody = (bytes: Uint8Array | undefined) => (
  new WebBodyController(bytes == null ? undefined : new InlineBodySource(bytes))
)
