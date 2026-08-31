import { parseFsResultWithoutResources, readSingleBinary } from './contract.js'
import { mapNativeBridgeError } from './errors.js'

import type { NativeStream } from '@holonomyjs/runtime/native-port/types'
import type { FsReadStream } from './types.js'

export class HolonomyFsReadStream implements FsReadStream {
  #closed = false

  constructor(
    private readonly stream: NativeStream,
    private readonly onClose: (stream: HolonomyFsReadStream) => void
  ) {}

  get isClosed() {
    return this.#closed
  }

  [Symbol.asyncIterator]() {
    return this
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    if (this.#closed) return { done: true, value: undefined }
    try {
      const item = await this.stream.next()
      if (item.done) {
        parseFsResultWithoutResources(item.value ?? {}, 'createReadStream')
        this.finish()
        return { done: true, value: undefined }
      }
      const output = parseFsResultWithoutResources(item.value, 'createReadStream')
      return { done: false, value: readSingleBinary(output.binary, 'createReadStream') }
    } catch (error) {
      this.close('malformed_read_stream')
      throw mapNativeBridgeError(error, 'createReadStream')
    }
  }

  async return(): Promise<IteratorResult<Uint8Array>> {
    this.close('stream_closed')
    return { done: true, value: undefined }
  }

  close(reason?: string) {
    if (this.#closed) return false
    this.#closed = true
    const closed = this.stream.close(reason)
    this.onClose(this)
    return closed
  }

  private finish() {
    if (this.#closed) return
    this.#closed = true
    this.onClose(this)
  }
}
