import { parseFsResultWithoutResources } from './contract.js'
import { createFsError, mapNativeBridgeError } from './errors.js'
import { readResultRecord, readResultString } from './result-validation.js'

import type { NativeStream } from '../native-port/types.js'
import type { FsWatchEvent, FsWatcher } from './types.js'

export class HolonomyFsWatcher implements FsWatcher {
  #closed = false

  constructor(
    private readonly stream: NativeStream,
    private readonly onClose: (watcher: HolonomyFsWatcher) => void
  ) {}

  get isClosed() {
    return this.#closed
  }
  [Symbol.asyncIterator]() {
    return this
  }

  async next(): Promise<IteratorResult<FsWatchEvent>> {
    if (this.#closed) return { done: true, value: undefined }
    try {
      const item = await this.stream.next()
      if (item.done) {
        parseFsResultWithoutResources(item.value ?? {}, 'watch')
        this.finish()
        return { done: true, value: undefined }
      }
      const output = parseFsResultWithoutResources(item.value, 'watch')
      const record = readResultRecord(output.value, ['eventType', 'filename'], 'watch')
      const eventType = readResultString(record, 'eventType', 'watch')
      if (eventType !== 'change' && eventType !== 'rename') throw createFsError('EIO', 'watch')
      return { done: false, value: { eventType, filename: readResultString(record, 'filename', 'watch') } }
    } catch (error) {
      this.close('malformed_watch_stream')
      throw mapNativeBridgeError(error, 'watch')
    }
  }

  async return(): Promise<IteratorResult<FsWatchEvent>> {
    this.close('watch_closed')
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
    if (!this.#closed) {
      this.#closed = true
      this.onClose(this)
    }
  }
}
