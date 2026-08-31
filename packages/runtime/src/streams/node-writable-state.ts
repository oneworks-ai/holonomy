import type { RuntimeBuffer } from '../node-compat/buffer.js'

import { invalidStreamState, streamAborted, toStreamError } from './errors.js'
import type { Stream } from './node-stream-base.js'
import { normalizeChunk, normalizeHighWaterMark } from './node-stream-types.js'
import type { RuntimeStreamCallback, RuntimeStreamChunk, RuntimeWritableOptions } from './node-stream-types.js'

interface WriteRecord {
  readonly callback?: RuntimeStreamCallback
  readonly chunk: RuntimeBuffer
  callbackSettled: boolean
}

export interface WritableOwner extends Stream {
  _finalWrite: (callback: RuntimeStreamCallback) => void
  _writeChunk: (
    chunk: RuntimeBuffer,
    encoding: 'buffer',
    callback: RuntimeStreamCallback
  ) => void
  _writableFinished: () => void
}

export class WritableStateMachine {
  ending = false
  finished = false
  length = 0
  needDrain = false
  writing = false
  private activeRecord: WriteRecord | undefined
  private destroyed = false
  private readonly highWaterMark: number
  private readonly owner: WritableOwner
  private readonly queue: WriteRecord[] = []
  private finalizing = false

  constructor(owner: WritableOwner, options: RuntimeWritableOptions) {
    this.owner = owner
    this.highWaterMark = normalizeHighWaterMark(options.highWaterMark)
  }

  get writableHighWaterMark(): number {
    return this.highWaterMark
  }

  destroy(error?: Error): void {
    if (this.destroyed) return
    this.destroyed = true
    const pendingError = error ?? invalidStreamState('Stream was destroyed before write completion')
    if (this.activeRecord !== undefined) this.settleCallback(this.activeRecord, pendingError)
    for (const record of this.queue.splice(0)) this.settleCallback(record, pendingError)
    this.length = 0
  }

  end(chunk?: RuntimeStreamChunk | RuntimeStreamCallback, callback?: RuntimeStreamCallback): void {
    if (typeof chunk === 'function') {
      callback = chunk
      chunk = undefined
    }
    if (chunk !== undefined) this.write(chunk)
    if (callback !== undefined) {
      if (this.finished) Promise.resolve().then(() => callback?.())
      else this.owner.once('finish', callback)
    }
    if (this.ending) return
    this.ending = true
    this.finishIfReady()
  }

  write(chunk: RuntimeStreamChunk, callback?: RuntimeStreamCallback): boolean {
    if (this.ending || this.finished || this.owner.destroyed) {
      const error = invalidStreamState('Cannot write after stream end')
      Promise.resolve().then(() => callback?.(error))
      this.owner.destroy(error)
      return false
    }
    const bytes = normalizeChunk(chunk)
    this.queue.push({ callback, callbackSettled: false, chunk: bytes })
    this.length += bytes.byteLength
    const belowHighWaterMark = this.length < this.highWaterMark
    if (!belowHighWaterMark) this.needDrain = true
    this.advance()
    return belowHighWaterMark
  }

  private advance(): void {
    if (this.writing || this.owner.destroyed) return
    const record = this.queue.shift()
    if (record === undefined) {
      this.finishIfReady()
      return
    }
    this.writing = true
    this.activeRecord = record
    let settled = false
    const done: RuntimeStreamCallback = (error) => {
      if (settled) return
      settled = true
      Promise.resolve().then(() => {
        this.writing = false
        this.activeRecord = undefined
        this.length = Math.max(0, this.length - record.chunk.byteLength)
        this.settleCallback(record, error)
        if (this.destroyed || this.owner.destroyed) return
        if (error != null) {
          this.owner.destroy(error)
          return
        }
        if (this.needDrain && this.length === 0) {
          this.needDrain = false
          this.owner.emit('drain')
        }
        this.advance()
      })
    }
    try {
      this.owner._writeChunk(record.chunk, 'buffer', done)
    } catch (error) {
      done(toStreamError(error, streamAborted))
    }
  }

  private finishIfReady(): void {
    if (
      !this.ending ||
      this.finished ||
      this.finalizing ||
      this.writing ||
      this.queue.length > 0 ||
      this.owner.destroyed
    ) {
      return
    }
    this.finalizing = true
    let settled = false
    const done: RuntimeStreamCallback = (error) => {
      if (settled) return
      settled = true
      Promise.resolve().then(() => {
        this.finalizing = false
        if (this.destroyed || this.owner.destroyed) return
        if (error != null) {
          this.owner.destroy(error)
          return
        }
        this.finished = true
        this.owner.emit('finish')
        this.owner._writableFinished()
      })
    }
    try {
      this.owner._finalWrite(done)
    } catch (error) {
      done(toStreamError(error, streamAborted))
    }
  }

  private settleCallback(record: WriteRecord, error?: Error | null): void {
    if (record.callbackSettled) return
    record.callbackSettled = true
    record.callback?.(error)
  }
}
