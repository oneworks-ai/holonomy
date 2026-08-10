/* eslint-disable max-lines -- readable/writable peer coordination is one transform lifecycle */

import { createDeferred } from './deferred.js'
import type { Deferred } from './deferred.js'
import { invalidStreamArgument, invalidStreamState, toWebStreamError } from './errors.js'
import { RuntimeReadableStream } from './web-readable.js'
import type { RuntimeReadableStreamDefaultController } from './web-readable.js'
import { normalizeWebHighWaterMark } from './web-strategy.js'
import type { RuntimeQueuingStrategy } from './web-strategy.js'
import { RuntimeWritableStream } from './web-writable.js'

export interface RuntimeTransformer<Input, Output> {
  readonly flush?: (
    controller: RuntimeTransformStreamDefaultController<Output>
  ) => PromiseLike<void> | void
  readonly readableType?: never
  readonly start?: (
    controller: RuntimeTransformStreamDefaultController<Output>
  ) => PromiseLike<void> | void
  readonly transform?: (
    chunk: Input,
    controller: RuntimeTransformStreamDefaultController<Output>
  ) => PromiseLike<void> | void
  readonly writableType?: never
}

type TransformState = 'active' | 'errored' | 'terminated'

interface TransformControllerAlgorithms<Output> {
  desiredSize: () => number | null
  enqueue: (chunk: Output) => void
  error: (reason?: unknown) => void
  terminate: () => void
}

export class RuntimeTransformStreamDefaultController<Output> {
  private readonly algorithms: TransformControllerAlgorithms<Output>

  constructor(algorithms: TransformControllerAlgorithms<Output>) {
    this.algorithms = algorithms
  }

  get desiredSize(): number | null {
    return this.algorithms.desiredSize()
  }

  enqueue(chunk: Output): void {
    this.algorithms.enqueue(chunk)
  }

  error(reason?: unknown): void {
    this.algorithms.error(reason)
  }

  terminate(): void {
    this.algorithms.terminate()
  }
}

export class RuntimeTransformStream<Input = Uint8Array, Output = Uint8Array> {
  readonly readable: RuntimeReadableStream<Output>
  readonly writable: RuntimeWritableStream<Input>

  constructor(
    transformer: RuntimeTransformer<Input, Output> = {},
    writableStrategy?: RuntimeQueuingStrategy<Input>,
    readableStrategy?: RuntimeQueuingStrategy<Output>
  ) {
    if (transformer.readableType !== undefined || transformer.writableType !== undefined) {
      throw invalidStreamArgument('Typed TransformStream sides are not supported')
    }
    const startDeferred = createDeferred<void>()
    const capacityWaiters: Deferred<void>[] = []
    const readableHighWaterMark = normalizeWebHighWaterMark(readableStrategy, 0)
    let zeroHighWaterMarkCredits = 0
    let state: TransformState = 'active'
    let storedError: unknown
    let readableController!: RuntimeReadableStreamDefaultController<Output>
    let writable: RuntimeWritableStream<Input> | undefined
    const resolveCapacity = () => {
      for (const waiter of capacityWaiters.splice(0)) waiter.resolve()
    }
    const signalCapacity = () => {
      if (readableHighWaterMark !== 0) {
        resolveCapacity()
        return
      }
      const waiter = capacityWaiters.shift()
      if (waiter === undefined) zeroHighWaterMarkCredits += 1
      else waiter.resolve()
    }
    const errorTransform = (reason?: unknown) => {
      if (state !== 'active') return
      const error = toWebStreamError(reason)
      state = 'errored'
      storedError = error
      readableController.error(error)
      for (const waiter of capacityWaiters.splice(0)) waiter.reject(error)
      if (writable !== undefined) void writable.abortFromPeer(error)
    }
    const controller = new RuntimeTransformStreamDefaultController<Output>({
      desiredSize: () => readableController.desiredSize,
      enqueue: chunk => {
        if (state !== 'active') {
          throw invalidStreamState('TransformStream is not active')
        }
        readableController.enqueue(chunk)
      },
      error: errorTransform,
      terminate: () => {
        if (state !== 'active') return
        state = 'terminated'
        storedError = streamPrematureTransformTermination()
        readableController.close()
        resolveCapacity()
        if (writable !== undefined) {
          void writable.abortFromPeer(storedError)
        }
      }
    })
    const waitForCapacity = async () => {
      if (state !== 'active') {
        throw toWebStreamError(storedError)
      }
      if ((readableController.desiredSize ?? 0) > 0) return
      if (readableHighWaterMark === 0 && zeroHighWaterMarkCredits > 0) {
        zeroHighWaterMarkCredits -= 1
        return
      }
      const waiter = createDeferred<void>()
      capacityWaiters.push(waiter)
      await waiter.promise
    }
    this.readable = new RuntimeReadableStream<Output>({
      cancel: async (reason) => {
        if (state !== 'active') return
        state = 'terminated'
        storedError = toWebStreamError(reason)
        resolveCapacity()
        await writable?.abortFromPeer(storedError)
      },
      pull: () => signalCapacity(),
      start: (candidate) => {
        readableController = candidate
        return startDeferred.promise
      }
    }, readableStrategy ?? { highWaterMark: readableHighWaterMark })
    writable = new RuntimeWritableStream<Input>({
      abort: (reason) => {
        if (state !== 'active') return
        state = 'errored'
        storedError = toWebStreamError(reason)
        readableController.error(storedError)
        for (const waiter of capacityWaiters.splice(0)) waiter.reject(storedError)
      },
      close: async () => {
        if (state !== 'active') throw toWebStreamError(storedError)
        try {
          await transformer.flush?.(controller)
          if (state === 'active') {
            state = 'terminated'
            readableController.close()
            resolveCapacity()
          }
        } catch (error) {
          errorTransform(error)
          throw error
        }
      },
      start: async () => {
        try {
          await transformer.start?.(controller)
          if (state !== 'active') {
            const error = toWebStreamError(storedError)
            startDeferred.reject(error)
            throw error
          }
          startDeferred.resolve()
        } catch (error) {
          startDeferred.reject(error)
          errorTransform(error)
          throw error
        }
      },
      write: async (chunk) => {
        await waitForCapacity()
        if (state !== 'active') throw toWebStreamError(storedError)
        try {
          if (transformer.transform === undefined) {
            controller.enqueue(chunk as unknown as Output)
          } else {
            await transformer.transform(chunk, controller)
          }
          if (state !== 'active') throw toWebStreamError(storedError)
        } catch (error) {
          errorTransform(error)
          throw error
        }
      }
    }, writableStrategy)
    this.writable = writable
  }
}

const streamPrematureTransformTermination = () => invalidStreamState('TransformStream was terminated')
