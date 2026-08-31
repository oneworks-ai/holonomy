import type { RuntimeBuffer } from '../node-compat/buffer.js'

import { streamNotSupported } from './errors.js'
import { Duplex } from './node-duplex.js'
import type { RuntimeStreamCallback, RuntimeTransformCallback, RuntimeTransformOptions } from './node-stream-types.js'

export class Transform extends Duplex {
  private readonly flushHook: RuntimeTransformOptions['flush']
  private readonly transformHook: RuntimeTransformOptions['transform']

  constructor(options: RuntimeTransformOptions = {}) {
    super(options)
    this.flushHook = options.flush
    this.transformHook = options.transform
  }

  protected override _final(callback: RuntimeStreamCallback): void {
    const complete: RuntimeTransformCallback = (error, output) => {
      if (error != null) {
        callback(error)
        return
      }
      if (output === undefined || this.push(output)) {
        this.push(null)
        callback()
        return
      }
      this.waitForReadableCapacity(capacityError => {
        if (capacityError != null) callback(capacityError)
        else {
          this.push(null)
          callback()
        }
      })
    }
    if (this.flushHook === undefined) complete()
    else Reflect.apply(this.flushHook, this, [complete])
  }

  protected override _write(
    chunk: RuntimeBuffer,
    encoding: 'buffer',
    callback: RuntimeStreamCallback
  ): void {
    let completed = false
    const complete: RuntimeTransformCallback = (error, output) => {
      if (completed) return
      completed = true
      if (error != null) {
        callback(error)
        return
      }
      if (output === undefined || this.push(output)) callback()
      else this.waitForReadableCapacity(callback)
    }
    if (this.transformHook === undefined) this._transform(chunk, encoding, complete)
    else Reflect.apply(this.transformHook, this, [chunk, encoding, complete])
  }

  protected _transform(
    _chunk: RuntimeBuffer,
    _encoding: 'buffer',
    callback: RuntimeTransformCallback
  ): void {
    callback(streamNotSupported('Transform._transform without an implementation'))
  }
}

export class PassThrough extends Transform {
  protected override _transform(
    chunk: RuntimeBuffer,
    _encoding: 'buffer',
    callback: RuntimeTransformCallback
  ): void {
    callback(null, chunk)
  }
}
