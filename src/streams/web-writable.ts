/* eslint-disable max-lines -- the writable queue and writer lock state machine is one lifecycle */

import { createDeferred } from './deferred.js'
import type { Deferred } from './deferred.js'
import { invalidStreamState, toWebStreamError } from './errors.js'
import { normalizeWebChunkSize, normalizeWebHighWaterMark } from './web-strategy.js'
import type { RuntimeQueuingStrategy } from './web-strategy.js'

export interface RuntimeUnderlyingSink<Chunk> {
  readonly abort?: (reason?: unknown) => PromiseLike<void> | void
  readonly close?: () => PromiseLike<void> | void
  readonly start?: (
    controller: RuntimeWritableStreamDefaultController
  ) => PromiseLike<void> | void
  readonly write?: (
    chunk: Chunk,
    controller: RuntimeWritableStreamDefaultController
  ) => PromiseLike<void> | void
}

type WritableState = 'aborting' | 'closed' | 'errored' | 'erroring' | 'writable'

interface WritableRecord<Chunk> {
  readonly chunk?: Chunk
  readonly deferred: Deferred<void>
  readonly kind: 'close' | 'write'
  readonly size: number
}

interface WritableControllerAlgorithms {
  error: (reason?: unknown) => void
}

export class RuntimeWritableStreamDefaultController {
  private readonly algorithms: WritableControllerAlgorithms

  constructor(algorithms: WritableControllerAlgorithms) {
    this.algorithms = algorithms
  }

  error(reason?: unknown): void {
    this.algorithms.error(reason)
  }
}

export class RuntimeWritableStream<Chunk = Uint8Array> {
  private readonly closeDeferred = createDeferred<void>()
  private readonly controller: RuntimeWritableStreamDefaultController
  private readonly highWaterMark: number
  private readonly queue: WritableRecord<Chunk>[] = []
  private readonly sink: RuntimeUnderlyingSink<Chunk>
  private readonly startPromise: Promise<void>
  private readonly strategy: RuntimeQueuingStrategy<Chunk> | undefined
  private abortPromise: Promise<void> | undefined
  private abortDeferred: Deferred<void> | undefined
  private abortReason: unknown
  private abortStarted = false
  private activeCloseAbortError: unknown
  private activeCloseAbortWriter: RuntimeWritableStreamDefaultWriter<Chunk> | undefined
  private activeRecord: WritableRecord<Chunk> | undefined
  private advancing = false
  private backpressure = false
  private closeRequested = false
  private errorDeferred: Deferred<void> | undefined
  private queueTotalSize = 0
  private readyDeferred = createDeferred<void>()
  private state: WritableState = 'writable'
  private storedError: unknown
  private writer: RuntimeWritableStreamDefaultWriter<Chunk> | undefined

  constructor(
    sink: RuntimeUnderlyingSink<Chunk> = {},
    strategy?: RuntimeQueuingStrategy<Chunk>
  ) {
    this.sink = sink
    this.strategy = strategy
    this.highWaterMark = normalizeWebHighWaterMark(strategy, 1)
    this.controller = new RuntimeWritableStreamDefaultController({
      error: reason => this.errorInternal(reason)
    })
    this.readyDeferred.resolve()
    let startResult: PromiseLike<void> | void
    try {
      startResult = this.sink.start?.(this.controller)
    } catch (error) {
      startResult = Promise.reject(error)
    }
    this.startPromise = Promise.resolve(startResult)
    void this.startPromise.catch(error => this.errorInternal(error))
    this.updateBackpressure()
  }

  get locked(): boolean {
    return this.writer !== undefined
  }

  abort(reason?: unknown): Promise<void> {
    if (this.locked) {
      return Promise.reject(invalidStreamState('Cannot abort a locked WritableStream'))
    }
    return this.abortInternal(reason)
  }

  close(): Promise<void> {
    if (this.locked) {
      return Promise.reject(invalidStreamState('Cannot close a locked WritableStream'))
    }
    return this.closeInternal()
  }

  getWriter(): RuntimeWritableStreamDefaultWriter<Chunk> {
    return new RuntimeWritableStreamDefaultWriter(this)
  }

  acquireWriter(writer: RuntimeWritableStreamDefaultWriter<Chunk>): void {
    if (this.locked) {
      throw invalidStreamState('WritableStream is already locked')
    }
    this.writer = writer
  }

  abortFromPeer(reason?: unknown): Promise<void> {
    return this.abortInternal(reason)
  }

  abortFromWriter(
    writer: RuntimeWritableStreamDefaultWriter<Chunk>,
    reason?: unknown
  ): Promise<void> {
    this.assertWriter(writer)
    return this.abortInternal(reason, writer)
  }

  closeFromWriter(writer: RuntimeWritableStreamDefaultWriter<Chunk>): Promise<void> {
    this.assertWriter(writer)
    return this.closeInternal()
  }

  closedPromise(writer: RuntimeWritableStreamDefaultWriter<Chunk>): Promise<void> {
    this.assertWriter(writer)
    return this.closeDeferred.promise
  }

  desiredSize(writer: RuntimeWritableStreamDefaultWriter<Chunk>): number | null {
    this.assertWriter(writer)
    if (this.state !== 'writable') return null
    return this.highWaterMark - this.queueTotalSize
  }

  readyPromise(writer: RuntimeWritableStreamDefaultWriter<Chunk>): Promise<void> {
    this.assertWriter(writer)
    return this.readyDeferred.promise
  }

  releaseWriter(writer: RuntimeWritableStreamDefaultWriter<Chunk>): void {
    this.assertWriter(writer)
    this.writer = undefined
  }

  writeFromWriter(
    writer: RuntimeWritableStreamDefaultWriter<Chunk>,
    chunk: Chunk
  ): Promise<void> {
    this.assertWriter(writer)
    if (this.state === 'aborting' || this.state === 'errored' || this.state === 'erroring') {
      return Promise.reject(this.storedError)
    }
    if (this.state !== 'writable' || this.closeRequested) {
      return Promise.reject(invalidStreamState('WritableStream is not writable'))
    }
    let size: number
    try {
      size = normalizeWebChunkSize(this.strategy, chunk)
    } catch (error) {
      this.errorInternal(error)
      return Promise.reject(this.storedError)
    }
    const deferred = createDeferred<void>()
    this.queue.push({ chunk, deferred, kind: 'write', size })
    this.queueTotalSize += size
    this.updateBackpressure()
    this.advanceQueue()
    return deferred.promise
  }

  private abortInternal(
    reason?: unknown,
    writer?: RuntimeWritableStreamDefaultWriter<Chunk>
  ): Promise<void> {
    if (this.state === 'closed') return Promise.resolve()
    if (this.state === 'errored') return Promise.resolve()
    if (this.abortPromise !== undefined) return this.abortPromise
    if (this.state === 'erroring') {
      return this.errorDeferred?.promise ?? Promise.reject(this.storedError)
    }
    if (this.activeRecord?.kind === 'close') {
      // Closing is already the terminal sink operation.  An abort here shares
      // its result rather than starting a second, competing sink.abort call.
      this.activeCloseAbortError = toWebStreamError(reason)
      this.activeCloseAbortWriter = writer
      this.abortPromise = this.activeRecord.deferred.promise
      return this.abortPromise
    }
    const error = toWebStreamError(reason)
    this.state = 'aborting'
    this.storedError = error
    this.abortReason = reason
    this.closeRequested = true
    const deferred = createDeferred<void>()
    this.abortDeferred = deferred
    this.abortPromise = deferred.promise
    const activeSize = this.activeRecord?.size ?? 0
    this.queueTotalSize = activeSize
    for (const record of this.queue.splice(0)) record.deferred.reject(error)
    this.closeDeferred.reject(error)
    this.rejectReady(error)
    if (!this.advancing) this.advanceQueue()
    return this.abortPromise
  }

  private assertWriter(writer: RuntimeWritableStreamDefaultWriter<Chunk>): void {
    if (this.writer !== writer) {
      throw invalidStreamState('Writer no longer owns this WritableStream')
    }
  }

  private async advanceQueue(): Promise<void> {
    if (this.advancing) return
    this.advancing = true
    try {
      await this.startPromise
      while (this.state === 'writable' && this.queue.length > 0) {
        const record = this.queue.shift()!
        this.activeRecord = record
        if (record.kind === 'close') {
          try {
            await this.sink.close?.()
          } catch (error) {
            record.deferred.reject(error)
            this.activeCloseAbortWriter?.rejectClosedForActiveCloseAbort(this.activeCloseAbortError)
            this.errorInternal(error)
            return
          }
          if (this.isPendingTerminal()) {
            record.deferred.reject(this.storedError)
            return
          }
          if (this.state !== 'writable') return
          this.activeRecord = undefined
          this.state = 'closed'
          record.deferred.resolve()
          this.closeDeferred.resolve()
          this.updateBackpressure()
          return
        }
        try {
          await this.sink.write?.(record.chunk as Chunk, this.controller)
        } catch (error) {
          this.queueTotalSize = Math.max(0, this.queueTotalSize - record.size)
          record.deferred.reject(error)
          if (this.isPendingTerminal()) return
          this.errorInternal(error)
          return
        }
        if (this.isPendingTerminal()) {
          this.activeRecord = undefined
          this.queueTotalSize = Math.max(0, this.queueTotalSize - record.size)
          record.deferred.resolve()
          return
        }
        if (this.state !== 'writable') return
        this.activeRecord = undefined
        this.queueTotalSize = Math.max(0, this.queueTotalSize - record.size)
        record.deferred.resolve()
        this.updateBackpressure()
      }
    } catch (error) {
      if (this.isPendingTerminal()) return
      this.errorInternal(error)
    } finally {
      this.activeRecord = undefined
      this.advancing = false
      if (this.state === 'aborting') this.finishAbort()
      else if (this.state === 'erroring') this.finishError()
    }
  }

  private closeInternal(): Promise<void> {
    if (this.state === 'aborting' || this.state === 'errored' || this.state === 'erroring') {
      return Promise.reject(this.storedError)
    }
    if (this.state !== 'writable' || this.closeRequested) {
      return Promise.reject(invalidStreamState('WritableStream cannot be closed twice'))
    }
    this.closeRequested = true
    const deferred = createDeferred<void>()
    this.queue.push({ deferred, kind: 'close', size: 0 })
    this.advanceQueue()
    return deferred.promise
  }

  private errorInternal(reason?: unknown): void {
    if (this.state !== 'writable') return
    const error = toWebStreamError(reason)
    this.state = 'erroring'
    this.storedError = error
    this.errorDeferred ??= createDeferred<void>()
    this.queueTotalSize = this.activeRecord?.size ?? 0
    for (const record of this.queue.splice(0)) record.deferred.reject(error)
    this.closeDeferred.reject(error)
    this.rejectReady(error)
    if (!this.advancing) this.finishError()
  }

  private finishAbort(): void {
    if (this.abortStarted || this.state !== 'aborting') return
    this.abortStarted = true
    let result: PromiseLike<void> | void
    try {
      result = this.sink.abort?.(this.abortReason)
    } catch (error) {
      this.state = 'errored'
      this.abortDeferred?.reject(error)
      return
    }
    void Promise.resolve(result).then(
      () => {
        this.state = 'errored'
        this.abortDeferred?.resolve()
      },
      error => {
        this.state = 'errored'
        this.abortDeferred?.reject(error)
      }
    )
  }

  private finishError(): void {
    if (this.state !== 'erroring') return
    this.state = 'errored'
    this.errorDeferred?.reject(this.storedError)
  }

  private isPendingTerminal(): boolean {
    return this.state === 'aborting' || this.state === 'erroring'
  }

  private rejectReady(error: unknown): void {
    if (!this.backpressure) this.readyDeferred = createDeferred<void>()
    this.readyDeferred.reject(error)
  }

  private updateBackpressure(): void {
    if (this.state !== 'writable') return
    const next = this.highWaterMark - this.queueTotalSize <= 0
    if (next === this.backpressure) return
    this.backpressure = next
    if (next) {
      this.readyDeferred = createDeferred<void>()
    } else {
      this.readyDeferred.resolve()
    }
  }
}

export class RuntimeWritableStreamDefaultWriter<Chunk> {
  private readonly closedAbortDeferred = createDeferred<never>()
  private readonly releaseDeferred = createDeferred<never>()
  private closedPromiseCache!: Promise<void>
  private owner: RuntimeWritableStream<Chunk> | undefined
  private readyPromiseCache!: Promise<void>
  private readySource!: Promise<void>

  constructor(owner: RuntimeWritableStream<Chunk>) {
    owner.acquireWriter(this)
    this.owner = owner
    this.closedPromiseCache = withRelease(
      owner.closedPromise(this),
      this.releaseDeferred.promise,
      this.closedAbortDeferred.promise
    )
    this.readySource = owner.readyPromise(this)
    this.readyPromiseCache = withRelease(this.readySource, this.releaseDeferred.promise)
  }

  get closed(): Promise<void> {
    return this.closedPromiseCache
  }

  get desiredSize(): number | null {
    const owner = this.requireOwner()
    return owner.desiredSize(this)
  }

  get ready(): Promise<void> {
    const owner = this.owner
    if (owner !== undefined) {
      const source = owner.readyPromise(this)
      if (source !== this.readySource) {
        this.readySource = source
        this.readyPromiseCache = withRelease(source, this.releaseDeferred.promise)
      }
    }
    return this.readyPromiseCache
  }

  abort(reason?: unknown): Promise<void> {
    const owner = this.owner
    if (owner === undefined) {
      return Promise.reject(invalidStreamState('Writer lock has been released'))
    }
    return owner.abortFromWriter(this, reason)
  }

  close(): Promise<void> {
    const owner = this.owner
    if (owner === undefined) {
      return Promise.reject(invalidStreamState('Writer lock has been released'))
    }
    return owner.closeFromWriter(this)
  }

  releaseLock(): void {
    const owner = this.owner
    if (owner === undefined) return
    owner.releaseWriter(this)
    this.owner = undefined
    const error = invalidStreamState('Writer lock has been released')
    this.releaseDeferred.reject(error)
  }

  write(chunk: Chunk): Promise<void> {
    const owner = this.owner
    if (owner === undefined) {
      return Promise.reject(invalidStreamState('Writer lock has been released'))
    }
    return owner.writeFromWriter(this, chunk)
  }

  rejectClosedForActiveCloseAbort(reason: unknown): void {
    this.closedAbortDeferred.reject(reason)
  }

  private requireOwner(): RuntimeWritableStream<Chunk> {
    if (this.owner === undefined) {
      throw invalidStreamState('Writer lock has been released')
    }
    return this.owner
  }
}

const withRelease = (
  source: Promise<void>,
  release: Promise<never>,
  activeCloseAbort?: Promise<never>
): Promise<void> => {
  const combined: Promise<void> = Promise.race(
    activeCloseAbort === undefined ? [source, release] : [source, release, activeCloseAbort]
  )
  // A released lock is permitted to reject even if consumer code never read
  // its lifecycle getter.  Observe the wrapper without changing its result.
  void combined.catch(() => undefined)
  return combined
}
