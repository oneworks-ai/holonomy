import { Buffer as NodeBuffer } from 'node:buffer'
import {
  PassThrough as NodePassThrough,
  Readable as NodeReadable,
  Writable as NodeWritable,
  finished as nodeFinished
} from 'node:stream'
import { finished as nodeFinishedPromise } from 'node:stream/promises'

import { describe, expect, it } from 'vitest'

import { PassThrough, Readable, Writable, finished, finishedPromise } from '../../src/streams/node-streams.js'
import type { RuntimeStreamCallback } from '../../src/streams/node-streams.js'

interface PassThroughLike {
  end: (chunk?: string) => unknown
  on: (event: string, listener: (...args: unknown[]) => void) => unknown
  once: (event: string, listener: (...args: unknown[]) => void) => unknown
  write: (chunk: Uint8Array) => boolean
}

interface ReadableProductionLike {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown
  once: (event: string, listener: (...args: unknown[]) => void) => unknown
  push: (chunk: string | null) => unknown
  read: (size?: number) => unknown
}

const passThroughTrace = async (stream: PassThroughLike) => {
  const trace: string[] = []
  stream.on('data', chunk => trace.push(`data:${NodeBuffer.from(chunk as Uint8Array).toString()}`))
  for (const event of ['end', 'finish', 'close']) {
    stream.on(event, () => trace.push(event))
  }
  const closed = new Promise<void>(resolve => stream.once('close', () => resolve()))
  const writes = [stream.write(new Uint8Array([97]))]
  stream.end('b')
  await closed
  return { trace, writes }
}

describe('stream Node reference subset', () => {
  it('matches Node PassThrough bytes and lifecycle ordering', async () => {
    const reference = await passThroughTrace(new NodePassThrough())
    const runtime = await passThroughTrace(new PassThrough())
    expect(runtime).toEqual(reference)
  })

  it('matches Node byte highWaterMark return and drain behavior', async () => {
    const trace = async (
      create: (callbacks: RuntimeStreamCallback[]) => {
        end: () => unknown
        on: (event: string, listener: () => void) => unknown
        write: (chunk: string) => boolean
      }
    ) => {
      const callbacks: RuntimeStreamCallback[] = []
      const stream = create(callbacks)
      const events: string[] = []
      stream.on('drain', () => events.push('drain'))
      const returns = [stream.write('abc'), stream.write('d')]
      callbacks.shift()!()
      await Promise.resolve()
      const afterFirst = [...events]
      callbacks.shift()!()
      await Promise.resolve()
      stream.end()
      return { afterFirst, events, returns }
    }
    const reference = await trace(callbacks =>
      new NodeWritable({
        highWaterMark: 3,
        write: (_chunk, _encoding, callback) => callbacks.push(callback)
      })
    )
    const runtime = await trace(callbacks =>
      new Writable({
        highWaterMark: 3,
        write: (_chunk, _encoding, callback) => callbacks.push(callback)
      })
    )
    expect(runtime).toEqual(reference)
  })

  it('matches Node data-listener read(0) production turn boundaries', async () => {
    const trace = async (create: (read: () => void) => ReadableProductionLike) => {
      let insideRead = false
      let readCalls = 0
      let reentrant = false
      let sawEnd = false
      const stream = create(() => {
        if (insideRead) reentrant = true
        insideRead = true
        readCalls += 1
        if (readCalls === 1) stream.push('first')
        else stream.push(null)
        insideRead = false
      })
      await new Promise<void>(resolve => {
        stream.on('data', () => {
          stream.once('end', () => {
            sawEnd = true
            resolve()
          })
          stream.read(0)
        })
      })
      return { readCalls, reentrant, sawEnd }
    }
    const reference = await trace(read => new NodeReadable({ read }))
    const runtime = await trace(read => new Readable({ read }))
    expect(runtime).toEqual(reference)
  })

  it('matches Node prebuffered pipe pause and drain consumption', async () => {
    const trace = async (
      source: {
        isPaused: () => boolean
        pipe: unknown
        push: (chunk: string | null) => unknown
        readonly readableLength: number
      },
      destination: {
        once: (event: string, listener: () => void) => unknown
      },
      writes: string[],
      callbacks: RuntimeStreamCallback[]
    ) => {
      source.push('a')
      source.push('b')
      source.push(null)
      if (typeof source.pipe !== 'function') throw new Error('pipe must be callable')
      Reflect.apply(source.pipe, source, [destination])
      await new Promise<void>(resolve => setImmediate(resolve))
      const initial = {
        length: source.readableLength,
        paused: source.isPaused(),
        writes: [...writes]
      }
      callbacks.shift()!()
      await new Promise<void>(resolve => setImmediate(resolve))
      const afterDrain = {
        length: source.readableLength,
        paused: source.isPaused(),
        writes: [...writes]
      }
      const closed = new Promise<void>(resolve => destination.once('close', resolve))
      callbacks.shift()!()
      await closed
      return { afterDrain, initial }
    }
    const create = <ReadableType, WritableType>(
      ReadableConstructor: new() => ReadableType,
      WritableConstructor: new(options: {
        highWaterMark: number
        write: (chunk: Uint8Array, encoding: unknown, callback: RuntimeStreamCallback) => void
      }) => WritableType
    ) => {
      const writes: string[] = []
      const callbacks: RuntimeStreamCallback[] = []
      const source = new ReadableConstructor()
      const destination = new WritableConstructor({
        highWaterMark: 1,
        write: (chunk, _encoding, callback) => {
          writes.push(NodeBuffer.from(chunk).toString())
          callbacks.push(callback)
        }
      })
      return { callbacks, destination, source, writes }
    }
    const node = create(NodeReadable, NodeWritable)
    const runtimeStreams = create(Readable, Writable)
    const reference = await trace(node.source, node.destination, node.writes, node.callbacks)
    const runtime = await trace(
      runtimeStreams.source,
      runtimeStreams.destination,
      runtimeStreams.writes,
      runtimeStreams.callbacks
    )
    expect(runtime).toEqual(reference)
  })

  it('matches Node asynchronous flowing _read continuation without reentrancy', async () => {
    const trace = async (
      create: (read: () => void) => {
        on: (event: string, listener: (chunk: Uint8Array) => void) => unknown
        once: (event: string, listener: () => void) => unknown
        push: (chunk: string | null) => unknown
      }
    ) => {
      const chunks: string[] = []
      let calls = 0
      let inside = false
      let reentrant = false
      const stream = create(() => {
        if (inside) reentrant = true
        inside = true
        calls += 1
        const call = calls
        queueMicrotask(() => stream.push(call <= 2 ? String(call) : null))
        inside = false
      })
      const ended = new Promise<void>(resolve => stream.once('end', resolve))
      stream.on('data', chunk => chunks.push(NodeBuffer.from(chunk).toString()))
      await ended
      return { calls, chunks, reentrant }
    }
    const reference = await trace(read => new NodeReadable({ highWaterMark: 1, read }))
    const runtime = await trace(read => new Readable({ highWaterMark: 1, read }))
    expect(runtime).toEqual(reference)
  })

  it('matches Node all-destination drain and blocked unpipe behavior', async () => {
    const trace = async (
      source: {
        destroy: () => unknown
        isPaused: () => boolean
        pipe: unknown
        push: (chunk: string) => unknown
        unpipe: unknown
      },
      destinations: Array<{
        callbacks: RuntimeStreamCallback[]
        stream: { destroy: () => unknown }
        writes: string[]
      }>
    ) => {
      if (typeof source.pipe !== 'function') throw new Error('pipe must be callable')
      for (const destination of destinations) {
        Reflect.apply(source.pipe, source, [destination.stream, { end: false }])
      }
      source.push('a')
      source.push('b')
      await new Promise<void>(resolve => setImmediate(resolve))
      const initial = destinations.map(destination => [...destination.writes])
      destinations[0]!.callbacks.shift()!()
      await new Promise<void>(resolve => setImmediate(resolve))
      const afterOneDrain = {
        paused: source.isPaused(),
        writes: destinations.map(destination => [...destination.writes])
      }
      destinations[1]!.callbacks.shift()!()
      await new Promise<void>(resolve => setImmediate(resolve))
      for (let attempt = 0; attempt < 5 && destinations[0]!.callbacks.length === 0; attempt += 1) {
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      source.push('c')
      destinations[0]!.callbacks.shift()!()
      await new Promise<void>(resolve => setImmediate(resolve))
      if (typeof source.unpipe !== 'function') throw new Error('unpipe must be callable')
      Reflect.apply(source.unpipe, source, [destinations[1]!.stream])
      await new Promise<void>(resolve => setImmediate(resolve))
      const afterUnpipe = destinations.map(destination => [...destination.writes])
      source.destroy()
      for (const destination of destinations) destination.stream.destroy()
      return { afterOneDrain, afterUnpipe, initial }
    }
    const create = <ReadableType, WritableType>(
      ReadableConstructor: new(options: { read: () => void }) => ReadableType,
      WritableConstructor: new(options: {
        highWaterMark: number
        write: (chunk: Uint8Array, encoding: unknown, callback: RuntimeStreamCallback) => void
      }) => WritableType
    ) => {
      const destinations = [0, 1].map(() => {
        const callbacks: RuntimeStreamCallback[] = []
        const writes: string[] = []
        const stream = new WritableConstructor({
          highWaterMark: 1,
          write: (chunk, _encoding, callback) => {
            writes.push(NodeBuffer.from(chunk).toString())
            callbacks.push(callback)
          }
        })
        return { callbacks, stream, writes }
      })
      return { destinations, source: new ReadableConstructor({ read: () => undefined }) }
    }
    const node = create(NodeReadable, NodeWritable)
    const runtimeStreams = create(Readable, Writable)
    const reference = await trace(node.source, node.destinations)
    const runtime = await trace(runtimeStreams.source, runtimeStreams.destinations)
    expect(runtime).toEqual(reference)
  })

  it('matches Node callback finished cleanup and Promise completion', async () => {
    const trace = async (
      create: () => PassThroughLike,
      callbackFinished: (stream: PassThroughLike, callback: RuntimeStreamCallback) => () => void,
      promiseFinished: (stream: PassThroughLike) => PromiseLike<void>
    ) => {
      const callbackStream = create()
      callbackStream.on('data', () => undefined)
      let callbackCalls = 0
      const callbackDone = new Promise<void>(resolve => {
        const cleanup = callbackFinished(callbackStream, () => {
          callbackCalls += 1
          cleanup()
          resolve()
        })
        callbackStream.end('callback')
      })
      await callbackDone
      const promiseStream = create()
      promiseStream.on('data', () => undefined)
      const promised = Promise.resolve(promiseFinished(promiseStream))
      promiseStream.end('promise')
      await promised
      return { callbackCalls }
    }
    const reference = await trace(
      () => new NodePassThrough(),
      (stream, callback) => nodeFinished(stream as NodePassThrough, callback),
      stream => nodeFinishedPromise(stream as NodePassThrough)
    )
    const runtime = await trace(
      () => new PassThrough(),
      (stream, callback) => finished(stream as PassThrough, callback),
      stream => finishedPromise(stream as PassThrough)
    )
    expect(runtime).toEqual(reference)
  })
})
