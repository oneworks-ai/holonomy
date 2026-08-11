import {
  ReadableStream as NodeReadableStream,
  TransformStream as NodeTransformStream,
  WritableStream as NodeWritableStream
} from 'node:stream/web'

import { describe, expect, it } from 'vitest'

import {
  RuntimeReadableStream,
  RuntimeTransformStream,
  RuntimeWritableStream
} from '../../../src/streams/web-streams.js'

describe('stream Web reference subset', () => {
  it('matches Node default-reader desiredSize and queued-close results', async () => {
    const trace = async (
      create: (source: {
        start: (controller: {
          close: () => void
          readonly desiredSize: number | null
          enqueue: (chunk: Uint8Array) => void
        }) => void
      }, strategy: { highWaterMark: number; size: (chunk: Uint8Array) => number }) => {
        getReader: () => { read: () => PromiseLike<{ done: boolean; value?: Uint8Array }> }
      }
    ) => {
      let controller!: {
        close: () => void
        readonly desiredSize: number | null
        enqueue: (chunk: Uint8Array) => void
      }
      const stream = create({
        start: candidate => {
          controller = candidate
        }
      }, { highWaterMark: 2, size: chunk => chunk.byteLength })
      const desired = [controller.desiredSize]
      controller.enqueue(new Uint8Array([1, 2]))
      desired.push(controller.desiredSize)
      controller.close()
      const reader = stream.getReader()
      const first = await reader.read()
      desired.push(controller.desiredSize)
      const second = await reader.read()
      return { desired, first: [...(first.value ?? [])], secondDone: second.done }
    }
    const reference = await trace((source, strategy) =>
      new NodeReadableStream<Uint8Array>(source as never, strategy as never)
    )
    const runtime = await trace((source, strategy) => new RuntimeReadableStream(source, strategy))
    expect(runtime).toEqual(reference)
  })

  it('matches Web readable strategy failure identity and terminal state', async () => {
    const trace = async (
      create: (source: { start: (controller: { enqueue: (chunk: number) => void }) => void }, strategy: {
        size: () => number
      }) => { getReader: () => { readonly closed: PromiseLike<void>; read: () => PromiseLike<unknown> } }
    ) => {
      const failure = new Error('readable size failure')
      let controller!: { enqueue: (chunk: number) => void }
      const stream = create({
        start: candidate => {
          controller = candidate
        }
      }, {
        size: () => {
          throw failure
        }
      })
      const reader = stream.getReader()
      const closed = Promise.resolve(reader.closed).catch(error => error)
      let thrown: unknown
      try {
        controller.enqueue(1)
      } catch (error) {
        thrown = error
      }
      const future = await Promise.resolve(reader.read()).catch(error => error)
      return { closedSame: await closed === failure, futureSame: future === failure, thrownSame: thrown === failure }
    }
    const reference = await trace((source, strategy) => new NodeReadableStream(source, strategy))
    const runtime = await trace((source, strategy) => new RuntimeReadableStream(source, strategy))
    expect(runtime).toEqual(reference)
  })

  it('matches Web writable strategy failure identity and sink suppression', async () => {
    const trace = async (
      create: (sink: { write: (chunk: number) => void }, strategy: { size: () => number }) => {
        getWriter: () => {
          readonly closed: PromiseLike<void>
          readonly ready: PromiseLike<void>
          write: (chunk: number) => PromiseLike<void>
        }
      }
    ) => {
      const failure = new Error('writable size failure')
      const calls: number[] = []
      const stream = create({ write: chunk => calls.push(chunk) }, {
        size: () => {
          throw failure
        }
      })
      const writer = stream.getWriter()
      const closed = Promise.resolve(writer.closed).catch(error => error)
      const first = await Promise.resolve(writer.write(1)).catch(error => error)
      const second = await Promise.resolve(writer.write(2)).catch(error => error)
      const ready = await Promise.resolve(writer.ready).catch(error => error)
      return {
        calls,
        closedSame: await closed === failure,
        firstSame: first === failure,
        readySame: ready === failure,
        secondSame: second === failure
      }
    }
    const reference = await trace((sink, strategy) => new NodeWritableStream(sink, strategy))
    const runtime = await trace((sink, strategy) => new RuntimeWritableStream(sink, strategy))
    expect(runtime).toEqual(reference)
  })

  it('matches Web active-write settlement before strategy error terminal state', async () => {
    const trace = async (
      create: (
        sink: { write: (chunk: number) => PromiseLike<void> },
        strategy: { highWaterMark: number; size: (chunk: number) => number }
      ) => {
        getWriter: () => {
          readonly closed: PromiseLike<void>
          write: (chunk: number) => PromiseLike<void>
        }
      }
    ) => {
      let finish!: () => void
      const calls: number[] = []
      const failure = new Error('active strategy failure')
      const stream = create({
        write: chunk => {
          calls.push(chunk)
          return new Promise<void>(resolve => {
            finish = resolve
          })
        }
      }, {
        highWaterMark: 1,
        size: chunk => {
          if (chunk === 3) throw failure
          return 1
        }
      })
      const writer = stream.getWriter()
      const first = Promise.resolve(writer.write(1))
      const queued = Promise.resolve(writer.write(2)).catch(error => error)
      await Promise.resolve()
      let firstSettled = false
      void first.finally(() => {
        firstSettled = true
      })
      const trigger = await Promise.resolve(writer.write(3)).catch(error => error)
      const beforeFinish = {
        calls: [...calls],
        firstSettled,
        triggerSame: trigger === failure
      }
      finish()
      await first
      const queuedError = await queued
      const closed = await Promise.resolve(writer.closed).catch(error => error)
      return { beforeFinish, closedSame: closed === failure, queuedSame: queuedError === failure }
    }
    const reference = await trace((sink, strategy) => new NodeWritableStream(sink, strategy as never))
    const runtime = await trace((sink, strategy) => new RuntimeWritableStream(sink, strategy))
    expect(runtime).toEqual(reference)
  })

  it('matches released Web writer promises while an admitted write completes', async () => {
    const trace = async (
      create: (sink: { write: () => PromiseLike<void> }, strategy: { highWaterMark: number }) => {
        getWriter: () => {
          readonly closed: PromiseLike<void>
          readonly ready: PromiseLike<void>
          releaseLock: () => void
          write: (chunk: number) => PromiseLike<void>
        }
      }
    ) => {
      let finish!: () => void
      const stream = create({
        write: () =>
          new Promise<void>(resolve => {
            finish = resolve
          })
      }, { highWaterMark: 1 })
      const writer = stream.getWriter()
      const pending = Promise.resolve(writer.write(1))
      const closed = Promise.resolve(writer.closed).catch(error => error)
      const ready = Promise.resolve(writer.ready).catch(error => error)
      writer.releaseLock()
      const [closedError, readyError] = await Promise.all([closed, ready])
      const futureClosed = await Promise.resolve(writer.closed).catch(error => error)
      const futureReady = await Promise.resolve(writer.ready).catch(error => error)
      finish()
      await pending
      return {
        capturedSame: closedError === readyError,
        futureClosedSame: futureClosed === closedError,
        futureReadySame: futureReady === closedError
      }
    }
    const reference = await trace((sink, strategy) => new NodeWritableStream(sink, strategy))
    const runtime = await trace((sink, strategy) => new RuntimeWritableStream(sink, strategy))
    expect(runtime).toEqual(reference)
  })

  it('matches released Web reader closed and read rejections', async () => {
    const trace = async (
      create: () => {
        getReader: () => {
          readonly closed: PromiseLike<void>
          read: () => PromiseLike<unknown>
          releaseLock: () => void
        }
      }
    ) => {
      const reader = create().getReader()
      const captured = Promise.resolve(reader.closed).catch(error => error)
      reader.releaseLock()
      const capturedError = await captured
      const futureClosed = await Promise.resolve(reader.closed).catch(error => error)
      const futureRead = await Promise.resolve(reader.read()).catch(error => error)
      return {
        futureClosedSame: futureClosed === capturedError,
        futureReadSame: futureRead === capturedError
      }
    }
    const reference = await trace(() => new NodeReadableStream())
    const runtime = await trace(() => new RuntimeReadableStream())
    expect(runtime).toEqual(reference)
  })

  it('matches Web Transform HWM=0 read/write rendezvous in either order', async () => {
    const trace = async (
      create: () => {
        readonly readable: { getReader: () => { read: () => PromiseLike<{ done: boolean; value?: number }> } }
        readonly writable: { getWriter: () => { write: (chunk: number) => PromiseLike<void> } }
      }
    ) => {
      const readFirst = create()
      const readFirstReader = readFirst.readable.getReader()
      const readFirstWriter = readFirst.writable.getWriter()
      const pendingReads = [Promise.resolve(readFirstReader.read()), Promise.resolve(readFirstReader.read())]
      await Promise.all([readFirstWriter.write(1), readFirstWriter.write(2)])
      const readFirstResults = await Promise.all(pendingReads)

      const writeFirst = create()
      const writeFirstReader = writeFirst.readable.getReader()
      const writeFirstWriter = writeFirst.writable.getWriter()
      const pendingWrites = [
        Promise.resolve(writeFirstWriter.write(3)),
        Promise.resolve(writeFirstWriter.write(4))
      ]
      const writeFirstResults = await Promise.all([
        writeFirstReader.read(),
        writeFirstReader.read()
      ])
      await Promise.all(pendingWrites)
      return [
        ...readFirstResults.map(result => result.value),
        ...writeFirstResults.map(result => result.value)
      ]
    }
    const transformer = {
      transform: (chunk: number, controller: { enqueue: (value: number) => void }) => {
        controller.enqueue(chunk)
      }
    }
    const reference = await trace(() => new NodeTransformStream(transformer))
    const runtime = await trace(() => new RuntimeTransformStream(transformer))
    expect(runtime).toEqual(reference)
  })
})
