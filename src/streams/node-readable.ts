/* eslint-disable max-lines -- the readable queue, flow and adapter state share one lifecycle */

import type { RuntimeBuffer } from '../node-compat/buffer.js'
import type { NodeEventListener, NodeEventName } from '../node-compat/events.js'

import { createDeferred } from './deferred.js'
import type { Deferred } from './deferred.js'
import {
  invalidStreamArgument,
  invalidStreamState,
  streamAborted,
  streamPrematureClose,
  toStreamError
} from './errors.js'
import { Stream } from './node-stream-base.js'
import { registerBeforeErrorHook } from './node-stream-internal.js'
import { assertByteMode, normalizeChunk, normalizeHighWaterMark } from './node-stream-types.js'
import type {
  PipeRecord,
  RuntimePipeDestination,
  RuntimeReadableOptions,
  RuntimeStreamCallback,
  RuntimeStreamChunk,
  RuntimeWebReadableStream
} from './node-stream-types.js'

export class Readable extends Stream implements AsyncIterable<RuntimeBuffer> {
  readable = true
  readableEnded = false
  readableFlowing: boolean | null = null
  private readonly asyncReads: Deferred<IteratorResult<RuntimeBuffer>>[] = []
  private readonly autoDestroy: boolean
  private readonly awaitingDrain = new Set<RuntimePipeDestination>()
  private readonly capacityWaiters: RuntimeStreamCallback[] = []
  private readonly highWaterMark: number
  private readonly pipes = new Map<RuntimePipeDestination, PipeRecord>()
  private readonly queue: RuntimeBuffer[] = []
  private readonly readHook: RuntimeReadableOptions['read']
  private endEmitted = false
  private ended = false
  private flowReading = false
  private queueBytes = 0
  private readReleaseScheduled = false
  /**
   * A read request remains in flight until its producer makes progress.  This
   * intentionally differs from a synchronous call-stack guard: async _read
   * implementations commonly schedule their first push in a microtask.
   */
  private activeReadToken: number | undefined
  private nextReadToken = 0

  constructor(options: RuntimeReadableOptions = {}) {
    assertByteMode(options.objectMode)
    super(options)
    this.autoDestroy = options.autoDestroy ?? true
    this.highWaterMark = normalizeHighWaterMark(options.highWaterMark)
    this.readHook = options.read
  }

  static from(
    iterable: AsyncIterable<RuntimeStreamChunk> | Iterable<RuntimeStreamChunk>,
    options: RuntimeReadableOptions = {}
  ): Readable {
    const asyncIterable = iterable as Partial<AsyncIterable<RuntimeStreamChunk>>
    const getAsyncIterator = asyncIterable[Symbol.asyncIterator]
    const asyncIterator = getAsyncIterator !== undefined
      ? Reflect.apply(getAsyncIterator, iterable, [])
      : toAsyncIterator((iterable as Iterable<RuntimeStreamChunk>)[Symbol.iterator]())
    let pumping = false
    let readable!: Readable
    const pump = async () => {
      if (pumping || readable.destroyed) return
      pumping = true
      try {
        const result = await asyncIterator.next()
        if (result.done) readable.push(null)
        else readable.push(result.value)
      } catch (error) {
        readable.destroy(toStreamError(error, streamAborted))
      } finally {
        pumping = false
        if (
          !readable.destroyed &&
          !readable.readableEnded &&
          readable.readableLength < readable.readableHighWaterMark
        ) {
          readable.read(0)
        }
      }
    }
    readable = new Readable({
      ...options,
      destroy: (error, callback) => {
        Promise.resolve(asyncIterator.return?.()).then(
          () => callback(error),
          returnError => callback(toStreamError(returnError, streamAborted))
        )
      },
      read: () => void pump()
    })
    return readable
  }

  static fromWeb(
    stream: RuntimeWebReadableStream<RuntimeStreamChunk>,
    options: RuntimeReadableOptions = {}
  ): Readable {
    if (stream == null || typeof stream.getReader !== 'function') {
      throw invalidStreamArgument('Readable.fromWeb expects a Web ReadableStream')
    }
    const reader = stream.getReader()
    let pulling = false
    let readable!: Readable
    const pull = async () => {
      if (pulling || readable.destroyed) return
      pulling = true
      try {
        const result = await reader.read()
        if (result.done) readable.push(null)
        else if (result.value === undefined) {
          throw invalidStreamArgument('Web stream produced an undefined chunk')
        } else {
          readable.push(result.value)
        }
      } catch (error) {
        readable.destroy(toStreamError(error, streamAborted))
      } finally {
        pulling = false
        if (
          !readable.destroyed &&
          !readable.readableEnded &&
          readable.readableLength < readable.readableHighWaterMark
        ) {
          readable.read(0)
        }
      }
    }
    readable = new Readable({
      ...options,
      destroy: (error, callback) => {
        if (readable.readableEnded) {
          callback(error)
          return
        }
        Promise.resolve(reader.cancel(error ?? undefined)).then(
          () => {
            reader.releaseLock()
            callback(error)
          },
          cancelError => callback(toStreamError(cancelError, streamAborted))
        )
      },
      read: () => void pull()
    })
    readable.once('end', () => reader.releaseLock())
    return readable
  }

  get readableHighWaterMark(): number {
    return this.highWaterMark
  }

  get readableLength(): number {
    return this.queueBytes
  }

  override on(eventName: NodeEventName, listener: NodeEventListener): this {
    super.on(eventName, listener)
    if (eventName === 'data') this.resume()
    return this
  }

  override addListener(eventName: NodeEventName, listener: NodeEventListener): this {
    return this.on(eventName, listener)
  }

  isPaused(): boolean {
    return this.readableFlowing === false
  }

  pause(): this {
    this.readableFlowing = false
    return this
  }

  pipe<Destination extends RuntimePipeDestination>(
    destination: Destination,
    options: { readonly end?: boolean } = {}
  ): Destination {
    const onData = (chunk: RuntimeBuffer) => {
      if (!destination.write(chunk)) {
        this.awaitingDrain.add(destination)
        this.pause()
      }
    }
    const onDrain = () => {
      this.awaitingDrain.delete(destination)
      if (this.awaitingDrain.size === 0) this.resume()
    }
    const onDestinationClose = () => this.unpipe(destination)
    const onDestinationError = (error: Error) => {
      this.unpipe(destination)
      if (destination.listenerCount?.('error') === 0) throw error
    }
    let unregisterDestinationError: () => void = () => undefined
    const onEnd = () => {
      if (options.end !== false) destination.end()
      this.unpipe(destination)
    }
    const onError = (error: Error) => destination.destroy?.(error)
    const cleanup = () => {
      this.off('data', onData)
      this.off('end', onEnd)
      this.off('error', onError)
      destination.off('drain', onDrain)
      unregisterDestinationError()
      destination.off('error', onDestinationError)
      destination.off('close', onDestinationClose)
      this.awaitingDrain.delete(destination)
    }
    this.pipes.set(destination, { cleanup, destination })
    super.on('data', onData)
    this.once('end', onEnd)
    this.on('error', onError)
    destination.on('drain', onDrain)
    if (destination instanceof Stream) {
      unregisterDestinationError = registerBeforeErrorHook(destination, () => this.unpipe(destination))
    } else {
      destination.once('error', onDestinationError)
    }
    destination.once('close', onDestinationClose)
    destination.emit?.('pipe', this)
    this.resume()
    return destination
  }

  push(chunk: RuntimeStreamChunk | null): boolean {
    if (this.destroyed) return false
    if (chunk === null) {
      if (this.ended) return false
      this.finishReadRequest()
      this.ended = true
      this.maybeEmitEnd()
      return false
    }
    if (this.ended) {
      this.destroy(invalidStreamState('Cannot push after EOF'))
      return false
    }
    const bytes = normalizeChunk(chunk)
    const asyncRead = this.asyncReads.shift()
    if (asyncRead !== undefined) {
      asyncRead.resolve({ done: false, value: bytes })
    } else if (this.readableFlowing === true) {
      this.emit('data', bytes)
    } else {
      this.queue.push(bytes)
      this.queueBytes += bytes.byteLength
    }
    this.scheduleReadRelease()
    return this.hasReadableCapacity()
  }

  read(size?: number): RuntimeBuffer | null {
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) {
      throw invalidStreamArgument('Readable.read size must be a non-negative safe integer')
    }
    if (size === 0) {
      this.requestRead()
      return null
    }
    if (this.queue.length === 0) {
      this.requestRead()
      if (this.queue.length === 0) {
        if (!this.flowReading) this.maybeEmitEnd()
        return null
      }
    }
    const first = this.queue[0]!
    const requested = size ?? first.byteLength
    let output: RuntimeBuffer
    if (requested >= first.byteLength) {
      output = this.queue.shift()!
    } else {
      output = first.subarray(0, requested)
      this.queue[0] = first.subarray(requested)
    }
    this.queueBytes -= output.byteLength
    this.notifyReadableCapacity()
    if (!this.flowReading) this.requestReadIfNeeded()
    if (!this.flowReading) this.maybeEmitEnd()
    return output
  }

  resume(): this {
    if (this.destroyed) return this
    if (this.awaitingDrain.size > 0) {
      this.readableFlowing = false
      return this
    }
    this.readableFlowing = true
    this.flow()
    return this
  }

  unpipe(destination?: RuntimePipeDestination): this {
    const records = destination === undefined
      ? [...this.pipes.values()]
      : [this.pipes.get(destination)].filter((value): value is PipeRecord => value !== undefined)
    for (const record of records) {
      record.cleanup()
      this.pipes.delete(record.destination)
      record.destination.emit?.('unpipe', this)
    }
    if (this.pipes.size === 0 && this.listenerCount('data') === 0) this.pause()
    else if (this.awaitingDrain.size === 0) this.resume()
    return this
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeBuffer> {
    return {
      next: () => this.nextAsyncChunk(),
      return: async () => {
        this.destroy()
        return { done: true, value: undefined }
      }
    }
  }

  protected override _destroy(error: Error | null, callback: RuntimeStreamCallback): void {
    this.readable = false
    this.queue.length = 0
    this.queueBytes = 0
    this.activeReadToken = undefined
    this.unpipe()
    const pendingError = error ?? streamPrematureClose()
    for (const read of this.asyncReads.splice(0)) read.reject(pendingError)
    for (const waiter of this.capacityWaiters.splice(0)) waiter(pendingError)
    super._destroy(error, callback)
  }

  protected maybeAutoDestroy(): void {
    if (this.autoDestroy) this.destroy()
  }

  protected waitForReadableCapacity(callback: RuntimeStreamCallback): void {
    if (this.destroyed) {
      Promise.resolve().then(() => callback(streamPrematureClose()))
      return
    }
    if (this.hasReadableCapacity()) {
      Promise.resolve().then(() => callback())
      return
    }
    this.capacityWaiters.push(callback)
  }

  private flow(): void {
    while (this.readableFlowing === true && !this.destroyed) {
      this.flowReading = true
      const chunk = this.read()
      this.flowReading = false
      if (chunk === null) {
        this.maybeEmitEnd()
        break
      }
      this.emit('data', chunk)
      this.maybeEmitEnd()
      if (this.readableFlowing === true) this.requestReadIfNeeded()
    }
  }

  private maybeEmitEnd(): void {
    if (!this.ended || this.queue.length > 0 || this.endEmitted) return
    this.endEmitted = true
    this.readable = false
    this.readableEnded = true
    for (const read of this.asyncReads.splice(0)) {
      read.resolve({ done: true, value: undefined })
    }
    this.emit('end')
    this.maybeAutoDestroy()
  }

  private nextAsyncChunk(): Promise<IteratorResult<RuntimeBuffer>> {
    const chunk = this.read()
    if (chunk !== null) return Promise.resolve({ done: false, value: chunk })
    if (this.readableEnded) return Promise.resolve({ done: true, value: undefined })
    if (this.destroyed) return Promise.reject(streamPrematureClose())
    const pending = createDeferred<IteratorResult<RuntimeBuffer>>()
    this.asyncReads.push(pending)
    this.requestRead()
    return pending.promise
  }

  private requestRead(): void {
    if (this.activeReadToken !== undefined || this.ended || this.destroyed) return
    const token = ++this.nextReadToken
    this.activeReadToken = token
    try {
      const result = this.readHook === undefined
        ? this._read(this.highWaterMark)
        : Reflect.apply(this.readHook, this, [this.highWaterMark])
      if (isPromiseLike(result)) {
        void Promise.resolve(result).then(
          () => this.finishReadRequest(token),
          error => this.destroy(toStreamError(error, streamAborted))
        )
      }
    } catch (error) {
      this.destroy(toStreamError(error, streamAborted))
    }
  }

  private finishReadRequest(token = this.activeReadToken): boolean {
    if (token === undefined || this.activeReadToken !== token) return false
    this.activeReadToken = undefined
    return true
  }

  private requestReadIfNeeded(): void {
    if (this.hasReadableCapacity()) this.requestRead()
  }

  private scheduleReadRelease(): void {
    const token = this.activeReadToken
    if (token === undefined || this.readReleaseScheduled || this.ended || this.destroyed) return
    this.readReleaseScheduled = true
    Promise.resolve().then(() => {
      this.readReleaseScheduled = false
      if (!this.finishReadRequest(token) || this.ended || this.destroyed) return
      if (this.readableFlowing === true || this.asyncReads.length > 0) {
        this.requestReadIfNeeded()
      }
    })
  }

  private hasReadableCapacity(): boolean {
    return this.highWaterMark === 0
      ? this.queueBytes === 0
      : this.queueBytes < this.highWaterMark
  }

  private notifyReadableCapacity(): void {
    if (!this.hasReadableCapacity()) return
    for (const waiter of this.capacityWaiters.splice(0)) waiter()
  }

  protected _read(_size: number): void {}
}
const toAsyncIterator = <Value>(iterator: Iterator<Value>): AsyncIterator<Value> => ({
  next: async () => iterator.next(),
  return: iterator.return === undefined
    ? undefined
    : async () => iterator.return!()
})

const isPromiseLike = (value: unknown): value is PromiseLike<void> =>
  value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function'
