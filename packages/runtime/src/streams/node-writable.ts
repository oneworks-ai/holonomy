import type { RuntimeBuffer } from '../node-compat/buffer.js'

import { streamNotSupported } from './errors.js'
import { Stream } from './node-stream-base.js'
import { assertByteMode } from './node-stream-types.js'
import type { RuntimeStreamCallback, RuntimeStreamChunk, RuntimeWritableOptions } from './node-stream-types.js'
import { WritableStateMachine } from './node-writable-state.js'
import type { WritableOwner } from './node-writable-state.js'

export class Writable extends Stream implements WritableOwner {
  writable = true
  private readonly autoDestroy: boolean
  private readonly finalHook: RuntimeWritableOptions['final']
  private readonly state: WritableStateMachine
  private readonly writeHook: RuntimeWritableOptions['write']

  constructor(options: RuntimeWritableOptions = {}) {
    assertByteMode(options.objectMode)
    if (options.decodeStrings === false) {
      throw streamNotSupported('Writable decodeStrings=false')
    }
    super(options)
    this.autoDestroy = options.autoDestroy ?? true
    this.finalHook = options.final
    this.writeHook = options.write
    this.state = new WritableStateMachine(this, options)
  }

  get writableEnded(): boolean {
    return this.state.ending
  }

  get writableFinished(): boolean {
    return this.state.finished
  }

  get writableHighWaterMark(): number {
    return this.state.writableHighWaterMark
  }

  get writableLength(): number {
    return this.state.length
  }

  get writableNeedDrain(): boolean {
    return this.state.needDrain
  }

  end(chunk?: RuntimeStreamChunk | RuntimeStreamCallback, callback?: RuntimeStreamCallback): this {
    this.state.end(chunk, callback)
    return this
  }

  write(chunk: RuntimeStreamChunk, callback?: RuntimeStreamCallback): boolean {
    return this.state.write(chunk, callback)
  }

  _finalWrite(callback: RuntimeStreamCallback): void {
    if (this.finalHook === undefined) this._final(callback)
    else Reflect.apply(this.finalHook, this, [callback])
  }

  _writableFinished(): void {
    this.writable = false
    if (this.autoDestroy) this.destroy()
  }

  _writeChunk(
    chunk: RuntimeBuffer,
    encoding: 'buffer',
    callback: RuntimeStreamCallback
  ): void {
    if (this.writeHook === undefined) this._write(chunk, encoding, callback)
    else Reflect.apply(this.writeHook, this, [chunk, encoding, callback])
  }

  protected override _destroy(error: Error | null, callback: RuntimeStreamCallback): void {
    this.writable = false
    this.state.destroy(error ?? undefined)
    super._destroy(error, callback)
  }

  protected _final(callback: RuntimeStreamCallback): void {
    callback()
  }

  protected _write(
    _chunk: RuntimeBuffer,
    _encoding: 'buffer',
    callback: RuntimeStreamCallback
  ): void {
    callback(streamNotSupported('Writable._write without an implementation'))
  }
}
