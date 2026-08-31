/* eslint-disable max-lines -- the readable queue and lock state machine is one lifecycle */

import { createDeferred } from './deferred.js'
import type { Deferred } from './deferred.js'
import { invalidStreamArgument, invalidStreamState, toWebStreamError } from './errors.js'
import { normalizeWebChunkSize, normalizeWebHighWaterMark } from './web-strategy.js'
import type { RuntimeQueuingStrategy } from './web-strategy.js'

export interface RuntimeUnderlyingSource<Chunk> {
  readonly cancel?: (reason?: unknown) => PromiseLike<void> | void
  readonly pull?: (
    controller: RuntimeReadableStreamDefaultController<Chunk>
  ) => PromiseLike<void> | void
  readonly start?: (
    controller: RuntimeReadableStreamDefaultController<Chunk>
  ) => PromiseLike<void> | void
  readonly type?: never
}

export interface RuntimeReadableStreamReadResult<Chunk> {
  readonly done: boolean
  readonly value?: Chunk
}

interface QueuedChunk<Chunk> {
  readonly chunk: Chunk
  readonly size: number
}

type ReadableState = 'closed' | 'errored' | 'readable'

interface ReadableControllerAlgorithms<Chunk> {
  close: () => void
  desiredSize: () => number | null
  enqueue: (chunk: Chunk) => void
  error: (reason?: unknown) => void
}

export class RuntimeReadableStreamDefaultController<Chunk> {
  private readonly algorithms: ReadableControllerAlgorithms<Chunk>

  constructor(algorithms: ReadableControllerAlgorithms<Chunk>) {
    this.algorithms = algorithms
  }

  get desiredSize(): number | null {
    return this.algorithms.desiredSize()
  }

  close(): void {
    this.algorithms.close()
  }

  enqueue(chunk: Chunk): void {
    this.algorithms.enqueue(chunk)
  }

  error(reason?: unknown): void {
    this.algorithms.error(reason)
  }
}

export class RuntimeReadableStream<Chunk = Uint8Array> {
  private readonly closeDeferred = createDeferred<void>()
  private readonly controller: RuntimeReadableStreamDefaultController<Chunk>
  private readonly highWaterMark: number
  private readonly queue: QueuedChunk<Chunk>[] = []
  private readonly readRequests: Deferred<RuntimeReadableStreamReadResult<Chunk>>[] = []
  private readonly source: RuntimeUnderlyingSource<Chunk>
  private readonly strategy: RuntimeQueuingStrategy<Chunk> | undefined
  private closeRequested = false
  private storedError: unknown
  private queueTotalSize = 0
  private pulling = false
  private pullAgain = false
  private reader: RuntimeReadableStreamDefaultReader<Chunk> | undefined
  private started = false
  private state: ReadableState = 'readable'

  constructor(
    source: RuntimeUnderlyingSource<Chunk> = {},
    strategy?: RuntimeQueuingStrategy<Chunk>
  ) {
    if (source.type !== undefined) {
      throw invalidStreamArgument('Byte-oriented Web Streams are not supported')
    }
    this.source = source
    this.strategy = strategy
    this.highWaterMark = normalizeWebHighWaterMark(strategy, 1)
    this.controller = new RuntimeReadableStreamDefaultController({
      close: () => this.controllerClose(),
      desiredSize: () => this.controllerDesiredSize(),
      enqueue: chunk => this.controllerEnqueue(chunk),
      error: reason => this.controllerError(reason)
    })
    let startResult: PromiseLike<void> | void
    try {
      startResult = this.source.start?.(this.controller)
    } catch (error) {
      this.controllerError(error)
      return
    }
    void Promise.resolve(startResult).then(
      () => {
        this.started = true
        this.callPullIfNeeded()
      },
      error => this.controllerError(error)
    )
  }

  get locked(): boolean {
    return this.reader !== undefined
  }

  cancel(reason?: unknown): Promise<void> {
    if (this.locked) {
      return Promise.reject(invalidStreamState('Cannot cancel a locked ReadableStream'))
    }
    return this.cancelInternal(reason)
  }

  getReader(options?: { readonly mode?: unknown }): RuntimeReadableStreamDefaultReader<Chunk> {
    if (options?.mode !== undefined) {
      throw invalidStreamArgument('BYOB readers are not supported')
    }
    return new RuntimeReadableStreamDefaultReader(this)
  }

  acquireReader(reader: RuntimeReadableStreamDefaultReader<Chunk>): void {
    if (this.locked) {
      throw invalidStreamState('ReadableStream is already locked')
    }
    this.reader = reader
  }

  cancelFromReader(
    reader: RuntimeReadableStreamDefaultReader<Chunk>,
    reason?: unknown
  ): Promise<void> {
    this.assertReader(reader)
    return this.cancelInternal(reason)
  }

  closedPromise(reader: RuntimeReadableStreamDefaultReader<Chunk>): Promise<void> {
    this.assertReader(reader)
    return this.closeDeferred.promise
  }

  readFromReader(
    reader: RuntimeReadableStreamDefaultReader<Chunk>
  ): Promise<RuntimeReadableStreamReadResult<Chunk>> {
    this.assertReader(reader)
    if (this.queue.length > 0) {
      const queued = this.queue.shift()!
      this.queueTotalSize = Math.max(0, this.queueTotalSize - queued.size)
      if (this.closeRequested && this.queue.length === 0) {
        this.finishClose()
      } else {
        this.callPullIfNeeded()
      }
      return Promise.resolve({ done: false, value: queued.chunk })
    }
    if (this.state === 'closed') {
      return Promise.resolve({ done: true })
    }
    if (this.state === 'errored') {
      return Promise.reject(this.storedError)
    }
    const request = createDeferred<RuntimeReadableStreamReadResult<Chunk>>()
    this.readRequests.push(request)
    this.callPullIfNeeded()
    return request.promise
  }

  releaseReader(reader: RuntimeReadableStreamDefaultReader<Chunk>): void {
    this.assertReader(reader)
    if (this.readRequests.length > 0) {
      throw invalidStreamState('Cannot release a reader with pending read requests')
    }
    this.reader = undefined
  }

  private assertReader(reader: RuntimeReadableStreamDefaultReader<Chunk>): void {
    if (this.reader !== reader) {
      throw invalidStreamState('Reader no longer owns this ReadableStream')
    }
  }

  private async cancelInternal(reason?: unknown): Promise<void> {
    if (this.state === 'closed') return
    if (this.state === 'errored') throw this.storedError
    this.queue.length = 0
    this.queueTotalSize = 0
    this.closeRequested = true
    this.finishClose()
    await this.source.cancel?.(reason)
  }

  private callPullIfNeeded(): void {
    if (
      !this.started ||
      this.state !== 'readable' ||
      this.closeRequested ||
      (this.readRequests.length === 0 && (this.controllerDesiredSize() ?? 0) <= 0)
    ) {
      return
    }
    if (this.pulling) {
      this.pullAgain = true
      return
    }
    if (this.source.pull === undefined) return
    this.pulling = true
    let pullResult: PromiseLike<void> | void
    try {
      pullResult = this.source.pull(this.controller)
    } catch (error) {
      this.pulling = false
      this.controllerError(error)
      return
    }
    void Promise.resolve(pullResult).then(
      () => {
        this.pulling = false
        if (this.pullAgain) {
          this.pullAgain = false
          this.callPullIfNeeded()
        }
      },
      error => {
        this.pulling = false
        this.controllerError(error)
      }
    )
  }

  private controllerClose(): void {
    if (this.state !== 'readable' || this.closeRequested) {
      throw invalidStreamState('ReadableStream cannot be closed in its current state')
    }
    this.closeRequested = true
    if (this.queue.length === 0) this.finishClose()
  }

  private controllerDesiredSize(): number | null {
    if (this.state === 'errored') return null
    if (this.state === 'closed') return 0
    return this.highWaterMark - this.queueTotalSize
  }

  private controllerEnqueue(chunk: Chunk): void {
    if (this.state !== 'readable' || this.closeRequested) {
      throw invalidStreamState('ReadableStream cannot enqueue in its current state')
    }
    if (this.readRequests.length > 0) {
      this.readRequests.shift()!.resolve({ done: false, value: chunk })
    } else {
      let size: number
      try {
        size = normalizeWebChunkSize(this.strategy, chunk)
      } catch (error) {
        this.controllerError(error)
        throw error
      }
      this.queue.push({ chunk, size })
      this.queueTotalSize += size
    }
    this.callPullIfNeeded()
  }

  private controllerError(reason?: unknown): void {
    if (this.state !== 'readable') return
    const error = toWebStreamError(reason)
    this.state = 'errored'
    this.storedError = error
    this.queue.length = 0
    this.queueTotalSize = 0
    for (const request of this.readRequests.splice(0)) request.reject(error)
    this.closeDeferred.reject(error)
  }

  private finishClose(): void {
    if (this.state !== 'readable') return
    this.state = 'closed'
    for (const request of this.readRequests.splice(0)) request.resolve({ done: true })
    this.closeDeferred.resolve()
  }
}

export class RuntimeReadableStreamDefaultReader<Chunk> {
  private readonly releaseDeferred = createDeferred<never>()
  private readonly closedPromiseCache: Promise<void>
  private owner: RuntimeReadableStream<Chunk> | undefined

  constructor(owner: RuntimeReadableStream<Chunk>) {
    owner.acquireReader(this)
    this.owner = owner
    this.closedPromiseCache = withRelease(owner.closedPromise(this), this.releaseDeferred.promise)
  }

  get closed(): Promise<void> {
    return this.closedPromiseCache
  }

  cancel(reason?: unknown): Promise<void> {
    const owner = this.owner
    if (owner === undefined) {
      return Promise.reject(invalidStreamState('Reader lock has been released'))
    }
    return owner.cancelFromReader(this, reason)
  }

  read(): Promise<RuntimeReadableStreamReadResult<Chunk>> {
    const owner = this.owner
    if (owner === undefined) {
      return Promise.reject(invalidStreamState('Reader lock has been released'))
    }
    return owner.readFromReader(this)
  }

  releaseLock(): void {
    const owner = this.owner
    if (owner === undefined) return
    owner.releaseReader(this)
    this.owner = undefined
    const error = invalidStreamState('Reader lock has been released')
    this.releaseDeferred.reject(error)
  }
}

const withRelease = (source: Promise<void>, release: Promise<never>): Promise<void> => {
  const combined: Promise<void> = Promise.race([source, release])
  // Keep a released, never-observed reader from surfacing an internal
  // unhandled rejection while preserving the externally returned rejection.
  void combined.catch(() => undefined)
  return combined
}
