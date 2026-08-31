import { EventEmitter } from '../node-compat/events.js'

import { createDeferred } from './deferred.js'
import { streamAborted, streamPrematureClose, toStreamError } from './errors.js'
import { runBeforeErrorHooks } from './node-stream-internal.js'
import type { RuntimeStreamCallback, RuntimeStreamDestroyOptions } from './node-stream-types.js'

export class Stream extends EventEmitter {
  closed = false
  destroyed = false
  /** Final destroy state is deliberately independent of the optional close event. */
  destroyCompleted = false
  destroyError: Error | undefined
  private readonly destroyHook: RuntimeStreamDestroyOptions['destroy']
  private readonly destroyDeferred = createDeferred<void>()
  private readonly emitClose: boolean
  private readonly prematureCloseError = streamPrematureClose()

  constructor(options: RuntimeStreamDestroyOptions = {}) {
    super()
    this.destroyHook = options.destroy
    this.emitClose = options.emitClose ?? true
  }

  destroy(error?: Error): this {
    if (this.destroyed) return this
    this.destroyed = true
    let settled = false
    const complete = (destroyError?: Error | null) => {
      if (settled) return
      settled = true
      const finalError = destroyError ?? error
      Promise.resolve().then(() => {
        try {
          this.destroyError = finalError ?? undefined
          this.destroyCompleted = true
          if (finalError != null) this.emit('error', finalError)
          if (this.emitClose && !this.closed) {
            this.closed = true
            this.emit('close')
          }
        } finally {
          this.destroyDeferred.resolve()
        }
      })
    }
    try {
      this._destroy(error ?? null, complete)
    } catch (destroyError) {
      complete(toStreamError(destroyError, streamAborted))
    }
    return this
  }

  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    if (eventName === 'error') runBeforeErrorHooks(this)
    return super.emit(eventName, ...args)
  }

  destroyedPromise(): Promise<void> {
    return this.destroyDeferred.promise
  }

  getPrematureCloseError(): Error {
    return this.prematureCloseError
  }

  protected _destroy(error: Error | null, callback: RuntimeStreamCallback): void {
    if (this.destroyHook === undefined) callback(error)
    else this.destroyHook(error, callback)
  }
}
