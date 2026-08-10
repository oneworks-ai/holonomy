/* eslint-disable max-lines -- Web stream state-machine regressions are kept with their public API suite */

import { describe, expect, it } from 'vitest'

import {
  RuntimeReadableStream,
  RuntimeReadableStreamDefaultReader,
  RuntimeTransformStream,
  RuntimeWritableStream,
  RuntimeWritableStreamDefaultWriter,
  createWebStreamsGlobals
} from '../../src/streams/web-streams.js'
import type {
  RuntimeReadableStreamDefaultController,
  RuntimeTransformStreamDefaultController,
  RuntimeWritableStreamDefaultController
} from '../../src/streams/web-streams.js'

const bytes = (...values: number[]) => new Uint8Array(values)

describe('pure JavaScript Web Streams subset', () => {
  it('exposes explicit globals and drains queued chunks before close', async () => {
    const globals = createWebStreamsGlobals()
    expect(Object.keys(globals).sort()).toEqual([
      'ReadableStream',
      'TransformStream',
      'WritableStream'
    ])
    expect(Object.isFrozen(globals)).toBe(true)

    let controller!: RuntimeReadableStreamDefaultController<Uint8Array>
    const stream = new RuntimeReadableStream<Uint8Array>({
      start: candidate => {
        controller = candidate
      }
    }, {
      highWaterMark: 2,
      size: chunk => chunk.byteLength
    })
    controller.enqueue(bytes(1, 2))
    expect(controller.desiredSize).toBe(0)
    controller.close()

    const reader = stream.getReader()
    await expect(reader.read()).resolves.toEqual({ done: false, value: bytes(1, 2) })
    await expect(reader.read()).resolves.toEqual({ done: true })
    await expect(reader.closed).resolves.toBeUndefined()
    expect(controller.desiredSize).toBe(0)
  })

  it('serializes pulls and invokes cancel once through the reader', async () => {
    let cancelCalls = 0
    let activePulls = 0
    let maximumPulls = 0
    let pullCount = 0
    const stream = new RuntimeReadableStream<number>({
      cancel: () => {
        cancelCalls += 1
      },
      pull: async (controller) => {
        activePulls += 1
        maximumPulls = Math.max(maximumPulls, activePulls)
        await Promise.resolve()
        controller.enqueue(++pullCount)
        activePulls -= 1
      }
    })
    const reader = stream.getReader()
    await expect(stream.cancel()).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_STREAM_INVALID_STATE'
    })
    await expect(reader.read()).resolves.toEqual({ done: false, value: 1 })
    await reader.cancel('done')
    await reader.cancel('again')
    expect(cancelCalls).toBe(1)
    expect(maximumPulls).toBe(1)
  })

  it('rejects pending reads and closed when the controller errors', async () => {
    let controller!: RuntimeReadableStreamDefaultController<number>
    const stream = new RuntimeReadableStream<number>({
      start: candidate => {
        controller = candidate
      }
    })
    const reader = stream.getReader()
    const pending = reader.read()
    const closed = reader.closed
    controller.error(new Error('read failed'))
    await expect(pending).rejects.toThrow('read failed')
    await expect(closed).rejects.toThrow('read failed')
  })

  it('stores readable strategy.size failures as the stream error', async () => {
    const failure = new Error('readable size failed')
    let controller!: RuntimeReadableStreamDefaultController<number>
    const stream = new RuntimeReadableStream<number>({
      start: candidate => {
        controller = candidate
      }
    }, {
      size: () => {
        throw failure
      }
    })
    const reader = stream.getReader()
    const closed = reader.closed
    expect(() => controller.enqueue(1)).toThrow(failure)
    await expect(closed).rejects.toBe(failure)
    await expect(reader.read()).rejects.toBe(failure)
    controller.error(new Error('ignored replacement'))
    await expect(reader.read()).rejects.toBe(failure)
  })

  it('atomically acquires locks through direct reader and writer constructors', () => {
    const readable = new RuntimeReadableStream<number>()
    const reader = new RuntimeReadableStreamDefaultReader(readable)
    expect(readable.locked).toBe(true)
    expect(() => readable.getReader()).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_STREAM_INVALID_STATE' })
    )
    expect(() => new RuntimeReadableStreamDefaultReader(readable)).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_STREAM_INVALID_STATE' })
    )
    reader.releaseLock()
    expect(readable.locked).toBe(false)

    const writable = new RuntimeWritableStream<number>()
    const writer = new RuntimeWritableStreamDefaultWriter(writable)
    expect(writable.locked).toBe(true)
    expect(() => writable.getWriter()).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_STREAM_INVALID_STATE' })
    )
    expect(() => new RuntimeWritableStreamDefaultWriter(writable)).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_STREAM_INVALID_STATE' })
    )
    writer.releaseLock()
    expect(writable.locked).toBe(false)
  })

  it('serializes writes and resolves writer.ready after byte backpressure', async () => {
    const pendingWrites: Array<() => void> = []
    const calls: number[][] = []
    let activeWrites = 0
    let maximumWrites = 0
    let closed = false
    const stream = new RuntimeWritableStream<Uint8Array>({
      close: () => {
        closed = true
      },
      write: async (chunk) => {
        activeWrites += 1
        maximumWrites = Math.max(maximumWrites, activeWrites)
        calls.push([...chunk])
        await new Promise<void>(resolve => pendingWrites.push(resolve))
        activeWrites -= 1
      }
    }, {
      highWaterMark: 2,
      size: chunk => chunk.byteLength
    })
    const writer = stream.getWriter()
    const first = writer.write(bytes(1, 2))
    const second = writer.write(bytes(3))
    expect(writer.desiredSize).toBe(-1)
    let ready = false
    void writer.ready.then(() => {
      ready = true
    })
    await Promise.resolve()
    expect(ready).toBe(false)

    pendingWrites.shift()!()
    await first
    expect(ready).toBe(false)
    pendingWrites.shift()!()
    await second
    await writer.ready
    expect(ready).toBe(true)
    await writer.close()
    await expect(writer.closed).resolves.toBeUndefined()
    expect(calls).toEqual([[1, 2], [3]])
    expect(maximumWrites).toBe(1)
    expect(closed).toBe(true)
  })

  it('waits for the active write before one shared abort invocation', async () => {
    let abortCalls = 0
    let finishWrite!: () => void
    const trace: string[] = []
    const abortFailure = new Error('sink abort failed')
    const abortReason = new Error('stop')
    const stream = new RuntimeWritableStream<number>({
      abort: reason => {
        abortCalls += 1
        trace.push(`abort:${(reason as Error).message}`)
        throw abortFailure
      },
      write: async chunk => {
        trace.push(`write:${chunk}:start`)
        await new Promise<void>(resolve => {
          finishWrite = resolve
        })
        trace.push(`write:${chunk}:end`)
      }
    })
    const writer = stream.getWriter()
    const closed = writer.closed
    const first = writer.write(1)
    const second = writer.write(2)
    await Promise.resolve()
    const abort = writer.abort(abortReason)
    const repeated = writer.abort(new Error('ignored'))
    expect(abort).toBe(repeated)
    expect(trace).toEqual(['write:1:start'])
    await expect(second).rejects.toBe(abortReason)
    finishWrite()
    await expect(first).resolves.toBeUndefined()
    await expect(abort).rejects.toBe(abortFailure)
    await expect(closed).rejects.toBe(abortReason)
    const afterTerminalAbort = writer.abort(new Error('later'))
    expect(afterTerminalAbort).not.toBe(abort)
    await expect(afterTerminalAbort).resolves.toBeUndefined()
    await expect(writer.write(3)).rejects.toBe(abortReason)
    expect(trace).toEqual(['write:1:start', 'write:1:end', 'abort:stop'])
    expect(abortCalls).toBe(1)
  })

  it('defers controller-error abort rejection until the active write settles', async () => {
    let controller!: RuntimeWritableStreamDefaultController
    let finishWrite!: () => void
    let abortCalls = 0
    const failure = new Error('controller failed during write')
    const stream = new RuntimeWritableStream<number>({
      start: candidate => {
        controller = candidate
      },
      abort: () => {
        abortCalls += 1
      },
      write: () =>
        new Promise<void>(resolve => {
          finishWrite = resolve
        })
    })
    const writer = stream.getWriter()
    const closed = writer.closed
    const write = writer.write(1)
    await Promise.resolve()
    controller.error(failure)
    const abort = writer.abort(new Error('ignored abort reason'))
    expect(abort).toBe(writer.abort(new Error('ignored repeated abort reason')))
    let abortSettled = false
    void abort.then(
      () => {
        abortSettled = true
      },
      () => {
        abortSettled = true
      }
    )
    await Promise.resolve()
    expect(abortSettled).toBe(false)
    expect(abortCalls).toBe(0)
    finishWrite()
    await expect(write).resolves.toBeUndefined()
    await expect(abort).rejects.toBe(failure)
    await expect(closed).rejects.toBe(failure)
    await expect(writer.write(2)).rejects.toBe(failure)
    await expect(writer.abort(new Error('post-terminal'))).resolves.toBeUndefined()
    expect(abortCalls).toBe(0)
  })

  it('shares an active close with abort without calling sink.abort', async () => {
    const run = async (closeFailure?: Error) => {
      let finishClose!: () => void
      let abortCalls = 0
      const abortReason = new Error('close abort reason')
      const stream = new RuntimeWritableStream<number>({
        abort: () => {
          abortCalls += 1
        },
        close: () =>
          new Promise<void>((resolve, reject) => {
            finishClose = () => {
              if (closeFailure === undefined) resolve()
              else reject(closeFailure)
            }
          })
      })
      const writer = stream.getWriter()
      const closed = writer.closed
      const close = writer.close()
      await Promise.resolve()
      const abort = writer.abort(abortReason)
      expect(abort).toBe(writer.abort(new Error('same close')))
      expect(abortCalls).toBe(0)
      finishClose()
      if (closeFailure === undefined) {
        await expect(close).resolves.toBeUndefined()
        await expect(abort).resolves.toBeUndefined()
        await expect(closed).resolves.toBeUndefined()
      } else {
        await expect(close).rejects.toBe(closeFailure)
        await expect(abort).rejects.toBe(closeFailure)
        await expect(closed).rejects.toBe(abortReason)
      }
      expect(abortCalls).toBe(0)
      await expect(writer.abort(new Error('post-terminal close abort'))).resolves.toBeUndefined()
    }
    await run()
    await run(new Error('close failed'))
  })

  it('errors writable state when strategy.size throws and never calls the sink', async () => {
    const failure = new Error('writable size failed')
    const calls: number[] = []
    const stream = new RuntimeWritableStream<number>({
      write: chunk => {
        calls.push(chunk)
      }
    }, {
      size: () => {
        throw failure
      }
    })
    const writer = stream.getWriter()
    const closed = writer.closed
    await expect(writer.write(1)).rejects.toBe(failure)
    await expect(writer.write(2)).rejects.toBe(failure)
    await expect(writer.close()).rejects.toBe(failure)
    await expect(closed).rejects.toBe(failure)
    await expect(writer.ready).rejects.toBe(failure)
    expect(writer.desiredSize).toBeNull()
    expect(calls).toEqual([])
  })

  it('lets an active sink write settle before committing strategy or controller errors', async () => {
    const run = async (
      trigger: (
        writer: RuntimeWritableStreamDefaultWriter<number>,
        controller: { error: (reason: unknown) => void },
        failure: Error
      ) => Promise<Error>
    ) => {
      let controller!: { error: (reason: unknown) => void }
      let finishActive!: () => void
      const calls: number[] = []
      const stream = new RuntimeWritableStream<number>({
        start: candidate => {
          controller = candidate
        },
        write: async chunk => {
          calls.push(chunk)
          if (chunk === 1) {
            await new Promise<void>(resolve => {
              finishActive = resolve
            })
          }
        }
      }, {
        size: chunk => {
          if (chunk === 3) throw new Error('strategy active failure')
          return 1
        }
      })
      const writer = stream.getWriter()
      const first = writer.write(1)
      const queued = writer.write(2)
      await Promise.resolve()
      let firstSettled = false
      void first.finally(() => {
        firstSettled = true
      })
      const failure = new Error('controller active failure')
      const storedFailure = await trigger(writer, controller, failure)
      await expect(queued).rejects.toBe(storedFailure)
      expect(firstSettled).toBe(false)
      expect(calls).toEqual([1])
      finishActive()
      await expect(first).resolves.toBeUndefined()
      await expect(writer.closed).rejects.toBe(storedFailure)
      await expect(writer.write(4)).rejects.toBe(storedFailure)
      expect(calls).toEqual([1])
    }

    await run(async (_writer, controller, failure) => {
      controller.error(failure)
      return failure
    })
    await run(async writer => {
      return writer.write(3).then(
        () => {
          throw new Error('strategy.size should reject')
        },
        error => error as Error
      )
    })
  })

  it('rejects captured and future lock promises after release without stranding writes', async () => {
    const readable = new RuntimeReadableStream<number>()
    const reader = readable.getReader()
    const capturedReaderClosed = reader.closed
    expect(reader.closed).toBe(capturedReaderClosed)
    reader.releaseLock()
    const readerRelease = await capturedReaderClosed.catch(error => error)
    expect(readerRelease).toMatchObject({ code: 'ERR_HOLONOMY_STREAM_INVALID_STATE' })
    await expect(reader.closed).rejects.toBe(readerRelease)
    expect(reader.closed).toBe(capturedReaderClosed)
    await expect(reader.read()).rejects.toMatchObject({ code: 'ERR_HOLONOMY_STREAM_INVALID_STATE' })

    let readableController!: RuntimeReadableStreamDefaultController<number>
    const pendingReadable = new RuntimeReadableStream<number>({
      start: controller => {
        readableController = controller
      }
    })
    const pendingReader = pendingReadable.getReader()
    const pendingRead = pendingReader.read()
    expect(() => pendingReader.releaseLock()).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_STREAM_INVALID_STATE' })
    )
    expect(pendingReadable.locked).toBe(true)
    readableController.enqueue(1)
    await expect(pendingRead).resolves.toEqual({ done: false, value: 1 })
    pendingReader.releaseLock()

    let finishWrite!: () => void
    const writable = new RuntimeWritableStream<number>({
      write: () =>
        new Promise<void>(resolve => {
          finishWrite = resolve
        })
    }, { highWaterMark: 1, size: () => 1 })
    const writer = writable.getWriter()
    const pendingWrite = writer.write(1)
    const capturedClosed = writer.closed
    const capturedReady = writer.ready
    expect(writer.closed).toBe(capturedClosed)
    expect(writer.ready).toBe(capturedReady)
    writer.releaseLock()
    const [closedRelease, readyRelease] = await Promise.all([
      capturedClosed.catch(error => error),
      capturedReady.catch(error => error)
    ])
    expect(readyRelease).toBe(closedRelease)
    await expect(writer.closed).rejects.toBe(closedRelease)
    await expect(writer.ready).rejects.toBe(closedRelease)
    expect(writer.closed).toBe(capturedClosed)
    expect(writer.ready).toBe(capturedReady)
    await expect(writer.write(2)).rejects.toMatchObject({ code: 'ERR_HOLONOMY_STREAM_INVALID_STATE' })
    finishWrite()
    await expect(pendingWrite).resolves.toBeUndefined()
    expect(writable.locked).toBe(false)

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const unobservedReader = new RuntimeReadableStream<number>().getReader()
      unobservedReader.releaseLock()
      const unobservedWriter = new RuntimeWritableStream<number>().getWriter()
      unobservedWriter.releaseLock()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('propagates synchronous Transform start errors to both peers', async () => {
    const failure = new Error('transform start failed')
    const stream = new RuntimeTransformStream<number, number>({
      start: controller => controller.error(failure)
    })
    const reader = stream.readable.getReader()
    const writer = stream.writable.getWriter()
    await expect(reader.closed).rejects.toBe(failure)
    await expect(reader.read()).rejects.toBe(failure)
    await expect(writer.closed).rejects.toBe(failure)
    await expect(writer.write(1)).rejects.toBe(failure)
  })

  it('retains Transform HWM=0 demand before or after a write', async () => {
    const create = () =>
      new RuntimeTransformStream<number, number>({
        transform: (chunk, controller) => controller.enqueue(chunk)
      })

    const readFirst = create()
    const readFirstReader = readFirst.readable.getReader()
    const readFirstWriter = readFirst.writable.getWriter()
    const pendingReads = [readFirstReader.read(), readFirstReader.read()]
    await Promise.all([readFirstWriter.write(1), readFirstWriter.write(2)])
    await expect(Promise.all(pendingReads)).resolves.toEqual([
      { done: false, value: 1 },
      { done: false, value: 2 }
    ])

    const writeFirst = create()
    const writeFirstReader = writeFirst.readable.getReader()
    const writeFirstWriter = writeFirst.writable.getWriter()
    const pendingWrites = [writeFirstWriter.write(3), writeFirstWriter.write(4)]
    await expect(Promise.all([writeFirstReader.read(), writeFirstReader.read()])).resolves.toEqual([
      { done: false, value: 3 },
      { done: false, value: 4 }
    ])
    await expect(Promise.all(pendingWrites)).resolves.toEqual([undefined, undefined])
  })

  it('applies TransformStream backpressure and propagates flush output', async () => {
    const stream = new RuntimeTransformStream<Uint8Array, Uint8Array>(
      {
        flush: controller => controller.enqueue(bytes(9)),
        transform: (
          chunk,
          controller: RuntimeTransformStreamDefaultController<Uint8Array>
        ) => controller.enqueue(bytes(...chunk, 0))
      },
      undefined,
      {
        highWaterMark: 1,
        size: () => 1
      }
    )
    const reader = stream.readable.getReader()
    const writer = stream.writable.getWriter()
    await writer.write(bytes(1))
    let secondSettled = false
    const second = writer.write(bytes(2)).then(() => {
      secondSettled = true
    })
    await Promise.resolve()
    expect(secondSettled).toBe(false)
    await expect(reader.read()).resolves.toEqual({ done: false, value: bytes(1, 0) })
    await second
    expect(secondSettled).toBe(true)
    await expect(reader.read()).resolves.toEqual({ done: false, value: bytes(2, 0) })
    await writer.close()
    await expect(reader.read()).resolves.toEqual({ done: false, value: bytes(9) })
    await expect(reader.read()).resolves.toEqual({ done: true })
  })
})
