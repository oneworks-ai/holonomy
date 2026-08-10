/* eslint-disable max-lines -- stream lifecycle regressions are kept with their public API suite */

import { describe, expect, it } from 'vitest'

import { Buffer } from '../../src/node-compat/buffer.js'
import {
  PassThrough,
  Readable,
  Transform,
  Writable,
  finished,
  finishedPromise,
  pipeline,
  pipelinePromise
} from '../../src/streams/node-streams.js'
import type { RuntimeStreamCallback } from '../../src/streams/node-streams.js'
import { RuntimeReadableStream } from '../../src/streams/web-streams.js'

const waitForEvent = (
  stream: { once: (event: string, listener: (...args: unknown[]) => void) => unknown },
  event: string
) => new Promise<unknown[]>(resolve => stream.once(event, (...args) => resolve(args)))

describe('memory-only Node stream subset', () => {
  it('runs PassThrough byte chunks through end, finish and close exactly once', async () => {
    const stream = new PassThrough()
    const chunks: string[] = []
    const events: string[] = []
    stream.on('data', chunk => chunks.push((chunk as Buffer).toString()))
    for (const event of ['end', 'finish', 'close']) {
      stream.on(event, () => events.push(event))
    }
    const closed = waitForEvent(stream, 'close')
    expect(stream.write(Buffer.from('a'))).toBe(true)
    stream.end(new Uint8Array([98]))
    await closed
    stream.destroy()
    await Promise.resolve()
    expect(chunks).toEqual(['a', 'b'])
    expect(events).toEqual(['end', 'finish', 'close'])
    expect(stream.readableEnded).toBe(true)
    expect(stream.writableFinished).toBe(true)
  })

  it('supports async iteration over Readable.from without object mode', async () => {
    const stream = Readable.from([
      Buffer.from('one'),
      new Uint8Array([116, 119, 111]),
      'three'
    ])
    const values: string[] = []
    for await (const chunk of stream) values.push(chunk.toString())
    expect(values).toEqual(['one', 'two', 'three'])
    expect(stream.readableEnded).toBe(true)
  })

  it('re-drives asynchronous _read one chunk at a time without reentrancy', async () => {
    const chunks: string[] = []
    let readCalls = 0
    let insideRead = false
    let reentrant = false
    const stream = new Readable({
      highWaterMark: 1,
      read: () => {
        if (insideRead) reentrant = true
        insideRead = true
        readCalls += 1
        const call = readCalls
        queueMicrotask(() => {
          if (call <= 2) stream.push(String(call))
          else stream.push(null)
        })
        insideRead = false
      }
    })
    stream.on('data', chunk => chunks.push((chunk as Buffer).toString()))
    await waitForEvent(stream, 'end')
    expect(chunks).toEqual(['1', '2'])
    expect(readCalls).toBe(3)
    expect(reentrant).toBe(false)
  })

  it('defers data-listener read(0) refill until after the current production turn', async () => {
    let insideRead = false
    let readCalls = 0
    let reentrant = false
    let sawEnd = false
    const stream = new Readable({
      read: () => {
        if (insideRead) reentrant = true
        insideRead = true
        readCalls += 1
        if (readCalls === 1) stream.push('first')
        else stream.push(null)
        insideRead = false
      }
    })
    const ended = new Promise<void>(resolve => {
      stream.on('data', () => {
        stream.once('end', () => {
          sawEnd = true
          resolve()
        })
        stream.read(0)
      })
    })
    await ended
    expect(readCalls).toBe(2)
    expect(reentrant).toBe(false)
    expect(sawEnd).toBe(true)
  })

  it('keeps asynchronous _read in flight through its first push and refill', async () => {
    const releases: Array<() => void> = []
    const values: string[] = []
    let active = 0
    let calls = 0
    let maximumActive = 0
    const stream = new Readable({
      highWaterMark: 1,
      read: () => {
        calls += 1
        active += 1
        maximumActive = Math.max(maximumActive, active)
        const call = calls
        return new Promise<void>(resolve => {
          releases.push(() => {
            active -= 1
            if (call <= 2) stream.push(String(call))
            else stream.push(null)
            resolve()
          })
        })
      }
    })
    stream.on('data', chunk => values.push((chunk as Buffer).toString()))
    stream.read(0)
    stream.read(0)
    expect(calls).toBe(1)
    expect(maximumActive).toBe(1)

    releases.shift()!()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(2)
    expect(maximumActive).toBe(1)
    releases.shift()!()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(3)
    const ended = waitForEvent(stream, 'end')
    releases.shift()!()
    await ended
    expect(values).toEqual(['1', '2'])
    expect(calls).toBe(3)
    expect(maximumActive).toBe(1)
  })

  it('latches byte backpressure until buffered writes drain', async () => {
    const callbacks: RuntimeStreamCallback[] = []
    const events: string[] = []
    const stream = new Writable({
      highWaterMark: 3,
      write: (_chunk, _encoding, callback) => callbacks.push(callback)
    })
    stream.on('drain', () => events.push('drain'))
    stream.on('finish', () => events.push('finish'))
    expect(stream.write('abc')).toBe(false)
    expect(stream.write('d')).toBe(false)
    expect(stream.writableLength).toBe(4)
    callbacks.shift()!()
    await Promise.resolve()
    expect(events).toEqual([])
    callbacks.shift()!()
    await Promise.resolve()
    expect(events).toEqual(['drain'])
    const closed = waitForEvent(stream, 'close')
    stream.end()
    await closed
    expect(events).toEqual(['drain', 'finish'])
  })

  it('pipes with pause/drain backpressure and supports unpipe', async () => {
    const source = new PassThrough({ highWaterMark: 2 })
    const writes: string[] = []
    const writeCallbacks: RuntimeStreamCallback[] = []
    const destination = new Writable({
      highWaterMark: 1,
      write: (chunk, _encoding, callback) => {
        writes.push(chunk.toString())
        writeCallbacks.push(callback)
      }
    })
    source.pipe(destination)
    source.write('a')
    source.write('b')
    expect(source.isPaused()).toBe(true)
    writeCallbacks.shift()!()
    await Promise.resolve()
    await Promise.resolve()
    expect(writes).toEqual(['a', 'b'])
    expect(source.isPaused()).toBe(true)
    writeCallbacks.shift()!()
    await Promise.resolve()
    await Promise.resolve()
    expect(source.isPaused()).toBe(false)
    source.end()
    const closed = waitForEvent(destination, 'close')
    await closed
    expect(writes).toEqual(['a', 'b'])
    source.unpipe(destination)
    expect(source.listenerCount('data')).toBe(0)
  })

  it('does not consume prebuffered pipe data past destination backpressure', async () => {
    const source = new Readable()
    source.push('a')
    source.push('b')
    source.push(null)
    const writes: string[] = []
    const callbacks: RuntimeStreamCallback[] = []
    const destination = new Writable({
      highWaterMark: 1,
      write: (chunk, _encoding, callback) => {
        writes.push(chunk.toString())
        callbacks.push(callback)
      }
    })
    source.pipe(destination)
    expect(writes).toEqual(['a'])
    expect(source.readableLength).toBe(1)
    expect(source.isPaused()).toBe(true)
    callbacks.shift()!()
    await Promise.resolve()
    await Promise.resolve()
    expect(writes).toEqual(['a', 'b'])
    callbacks.shift()!()
    await waitForEvent(destination, 'close')
  })

  it('waits for every piped destination drain and clears blockers on unpipe', async () => {
    const source = new Readable()
    const createDestination = () => {
      const callbacks: RuntimeStreamCallback[] = []
      const writes: string[] = []
      const stream = new Writable({
        highWaterMark: 1,
        write: (chunk, _encoding, callback) => {
          writes.push(chunk.toString())
          callbacks.push(callback)
        }
      })
      return { callbacks, stream, writes }
    }
    const first = createDestination()
    const second = createDestination()
    source.pipe(first.stream, { end: false })
    source.pipe(second.stream, { end: false })
    source.push('a')
    source.push('b')
    expect(first.writes).toEqual(['a'])
    expect(second.writes).toEqual(['a'])
    expect(source.isPaused()).toBe(true)

    first.callbacks.shift()!()
    await Promise.resolve()
    await Promise.resolve()
    expect(first.writes).toEqual(['a'])
    expect(second.writes).toEqual(['a'])
    expect(source.isPaused()).toBe(true)

    second.callbacks.shift()!()
    await Promise.resolve()
    await Promise.resolve()
    expect(first.writes).toEqual(['a', 'b'])
    expect(second.writes).toEqual(['a', 'b'])
    source.push('c')
    expect(source.readableLength).toBe(1)

    first.callbacks.shift()!()
    await Promise.resolve()
    await Promise.resolve()
    expect(source.isPaused()).toBe(true)
    const secondClosed = waitForEvent(second.stream, 'close')
    second.stream.destroy()
    await secondClosed
    expect(first.writes).toEqual(['a', 'b', 'c'])
    expect(second.writes).toEqual(['a', 'b'])
    source.destroy()
    first.stream.destroy()
    second.stream.destroy()
  })

  it('unpipes a destination error before rethrowing once and clearing its drain blocker', async () => {
    const source = new Readable()
    const healthyWrites: string[] = []
    const blocked = new Writable({
      emitClose: false,
      highWaterMark: 1,
      write: () => undefined
    })
    const healthy = new Writable({
      write: (chunk, _encoding, callback) => {
        healthyWrites.push(chunk.toString())
        callback()
      }
    })
    source.pipe(blocked, { end: false })
    source.pipe(healthy, { end: false })
    source.push('a')
    source.push('b')
    expect(source.isPaused()).toBe(true)
    const failure = new Error('destination failed')
    expect(() => blocked.emit('error', failure)).toThrow(failure)
    expect(source.isPaused()).toBe(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(healthyWrites).toEqual(['a', 'b'])
    expect(blocked.listenerCount('drain')).toBe(0)
    expect(blocked.listenerCount('error')).toBe(0)
    expect(blocked.listenerCount('close')).toBe(0)
    source.destroy()
    healthy.destroy()
    blocked.destroy()
  })

  it('cleans a runtime destination before one normal user error listener runs', async () => {
    const source = new Readable()
    const healthyWrites: string[] = []
    const destination = new Writable({
      emitClose: false,
      highWaterMark: 1,
      write: () => undefined
    })
    const healthy = new Writable({
      write: (chunk, _encoding, callback) => {
        healthyWrites.push(chunk.toString())
        callback()
      }
    })
    const failure = new Error('observed destination error')
    const observed: Error[] = []
    const onError = (error: Error) => observed.push(error)
    destination.on('error', onError)
    source.pipe(destination, { end: false })
    source.pipe(healthy, { end: false })
    source.push('a')
    source.push('b')
    expect(source.isPaused()).toBe(true)
    expect(() => destination.emit('error', failure)).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(observed).toEqual([failure])
    expect(source.isPaused()).toBe(false)
    expect(healthyWrites).toEqual(['a', 'b'])
    expect(destination.listenerCount('drain')).toBe(0)
    expect(destination.listenerCount('close')).toBe(0)
    destination.off('error', onError)
    expect(destination.listenerCount('error')).toBe(0)
    source.destroy()
    healthy.destroy()
    destination.destroy()
  })

  it('cleans every runtime pipe before a throwing user error listener propagates', async () => {
    const first = new Readable()
    const second = new Readable()
    const bad = new Writable({
      emitClose: false,
      highWaterMark: 1,
      write: () => undefined
    })
    const healthyWrites: string[] = []
    const healthy = new Writable({
      write: (chunk, _encoding, callback) => {
        healthyWrites.push(chunk.toString())
        callback()
      }
    })
    const failure = new Error('throwing user listener')
    const cleanupStates: boolean[] = []
    const onError = (error: Error) => {
      cleanupStates.push(
        !first.isPaused() && !second.isPaused() && bad.listenerCount('drain') === 0
      )
      throw error
    }
    bad.on('error', onError)
    first.pipe(bad, { end: false })
    second.pipe(bad, { end: false })
    first.pipe(healthy, { end: false })
    second.pipe(healthy, { end: false })
    first.push('one')
    second.push('two')
    expect(first.isPaused()).toBe(true)
    expect(second.isPaused()).toBe(true)
    expect(() => bad.emit('error', failure)).toThrow(failure)
    await Promise.resolve()
    await Promise.resolve()
    first.push('three')
    second.push('four')
    await Promise.resolve()
    await Promise.resolve()
    expect(cleanupStates).toEqual([true])
    expect(healthyWrites).toEqual(['one', 'two', 'three', 'four'])
    expect(bad.listenerCount('drain')).toBe(0)
    expect(bad.listenerCount('close')).toBe(0)
    bad.off('error', onError)
    expect(bad.listenerCount('error')).toBe(0)
    first.destroy()
    second.destroy()
    healthy.destroy()
    bad.destroy()
  })

  it('transforms chunks and propagates transform errors through destroy', async () => {
    const upper = new Transform({
      transform: (chunk, _encoding, callback) => callback(null, chunk.toString().toUpperCase())
    })
    const values: string[] = []
    upper.on('data', chunk => values.push((chunk as Buffer).toString()))
    const closed = waitForEvent(upper, 'close')
    upper.end('hello')
    await closed
    expect(values).toEqual(['HELLO'])

    const failure = new Transform({
      transform: (_chunk, _encoding, callback) => callback(new Error('bad chunk'))
    })
    const errors: string[] = []
    failure.on('error', error => errors.push((error as Error).message))
    const failedClose = waitForEvent(failure, 'close')
    failure.write('x')
    await failedClose
    expect(errors).toEqual(['bad chunk'])
  })

  it('holds Transform write callbacks while readable output is backpressured', async () => {
    const callbacks: string[] = []
    const transformed: string[] = []
    const stream = new Transform({
      highWaterMark: 1,
      transform: (chunk, _encoding, callback) => {
        transformed.push(chunk.toString())
        callback(null, chunk)
      }
    })
    expect(stream.write('a', error => callbacks.push(error?.message ?? 'a'))).toBe(false)
    expect(stream.write('b', error => callbacks.push(error?.message ?? 'b'))).toBe(false)
    await Promise.resolve()
    expect(transformed).toEqual(['a'])
    expect(callbacks).toEqual([])
    expect(stream.readableLength).toBe(1)
    expect(stream.read()?.toString()).toBe('a')
    await Promise.resolve()
    await Promise.resolve()
    expect(callbacks).toEqual(['a'])
    expect(transformed).toEqual(['a', 'b'])
    expect(stream.readableLength).toBe(1)
    expect(stream.read()?.toString()).toBe('b')
    await Promise.resolve()
    await Promise.resolve()
    expect(callbacks).toEqual(['a', 'b'])
  })

  it('adapts a real Web reader and cancels it on destroy', async () => {
    let canceled: unknown
    const web = new RuntimeReadableStream<Uint8Array>({
      cancel: reason => {
        canceled = reason
      },
      start: controller => controller.enqueue(Buffer.from('web'))
    })
    const readable = Readable.fromWeb(web)
    const iterator = readable[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: Buffer.from('web')
    })
    const error = new Error('stop web')
    readable.on('error', () => undefined)
    const closed = waitForEvent(readable, 'close')
    readable.destroy(error)
    await closed
    expect(canceled).toBe(error)
  })

  it('services concurrent Web-adapter reads without stalling', async () => {
    let value = 0
    const web = new RuntimeReadableStream<Uint8Array>({
      pull: controller => {
        value += 1
        if (value <= 2) controller.enqueue(Buffer.from(String(value)))
        else controller.close()
      }
    })
    const iterator = Readable.fromWeb(web)[Symbol.asyncIterator]()
    const [first, second, done] = await Promise.all([
      iterator.next(),
      iterator.next(),
      iterator.next()
    ])
    expect([first.value?.toString(), second.value?.toString(), done.done]).toEqual([
      '1',
      '2',
      true
    ])
  })

  it('settles an active write callback once when destroyed', async () => {
    let complete!: RuntimeStreamCallback
    const callbacks: Array<Error | null | undefined> = []
    const stream = new Writable({
      write: (_chunk, _encoding, callback) => {
        complete = callback
      }
    })
    stream.on('error', () => undefined)
    stream.write('active', error => callbacks.push(error))
    const closed = waitForEvent(stream, 'close')
    const failure = new Error('destroy active')
    stream.destroy(failure)
    await closed
    complete()
    await Promise.resolve()
    expect(callbacks).toEqual([failure])
  })

  it('pipes Readable.from into promise pipeline and destroys on completion', async () => {
    const chunks: string[] = []
    const destination = new Writable({
      write: (chunk, _encoding, callback) => {
        chunks.push(chunk.toString())
        callback()
      }
    })
    await pipelinePromise(Readable.from(['a', 'b']), destination)
    expect(chunks).toEqual(['a', 'b'])
    expect(destination.writableFinished).toBe(true)
  })

  it('implements callback pipeline and returns its destination', async () => {
    const chunks: string[] = []
    const destination = new Writable({
      write: (chunk, _encoding, callback) => {
        chunks.push(chunk.toString())
        callback()
      }
    })
    const completed = new Promise<Error | null | undefined>(resolve => {
      const returned = pipeline(Readable.from(['a', 'b']), destination, resolve)
      expect(returned).toBe(destination)
    })
    await expect(completed).resolves.toBeUndefined()
    expect(chunks).toEqual(['a', 'b'])
  })

  it('delivers callback pipeline errors once and still returns the destination', async () => {
    const failure = new Error('callback pipeline failed')
    const destination = new Writable({
      write: (_chunk, _encoding, callback) => callback(failure)
    })
    const callbacks: Array<Error | null | undefined> = []
    const completed = new Promise<void>(resolve => {
      const returned = pipeline(Readable.from(['bad']), destination, error => {
        callbacks.push(error)
        resolve()
      })
      expect(returned).toBe(destination)
    })
    await completed
    await Promise.resolve()
    expect(callbacks).toEqual([failure])
    expect(destination.listenerCount('error')).toBe(0)
  })

  it('cleans pipeline error listeners and produces no unhandled rejection', async () => {
    const source = Readable.from(['bad'])
    const failure = new Error('pipeline failed')
    const destination = new Writable({
      write: (_chunk, _encoding, callback) => callback(failure)
    })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(pipelinePromise(source, destination)).rejects.toBe(failure)
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
      expect(source.listenerCount('error')).toBe(0)
      expect(destination.listenerCount('error')).toBe(0)
      expect(source.listenerCount('close')).toBe(0)
      expect(destination.listenerCount('close')).toBe(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('rejects emitClose=false pipeline errors without waiting for close', async () => {
    const failure = new Error('no close pipeline failure')
    const source = Readable.from(['bad'])
    const destination = new Writable({
      emitClose: false,
      write: (_chunk, _encoding, callback) => callback(failure)
    })
    const events: string[] = []
    destination.on('error', error => events.push(`error:${(error as Error).message}`))
    destination.on('finish', () => events.push('finish'))
    destination.on('close', () => events.push('close'))
    const baseline = {
      close: destination.listenerCount('close'),
      error: destination.listenerCount('error'),
      finish: destination.listenerCount('finish')
    }
    await expect(pipelinePromise(source, destination)).rejects.toBe(failure)
    expect(destination.destroyed).toBe(true)
    expect(destination.closed).toBe(false)
    expect(events).toEqual(['error:no close pipeline failure'])
    expect(destination.listenerCount('close')).toBe(baseline.close)
    expect(destination.listenerCount('error')).toBe(baseline.error)
    expect(destination.listenerCount('finish')).toBe(baseline.finish)
  })

  it('separates callback finished cleanup from finishedPromise', async () => {
    const stream = new PassThrough()
    stream.on('data', () => undefined)
    const callbacks: Array<Error | null | undefined> = []
    const completed = new Promise<void>(resolve => {
      const cleanup = finished(stream, error => {
        callbacks.push(error)
        resolve()
      })
      expect(typeof cleanup).toBe('function')
    })
    stream.end('done')
    await completed
    stream.destroy()
    await Promise.resolve()
    expect(callbacks).toEqual([undefined])

    const canceled = new PassThrough()
    canceled.on('data', () => undefined)
    let canceledCalls = 0
    const cleanup = finished(canceled, () => {
      canceledCalls += 1
    })
    cleanup()
    canceled.end('ignored')
    await waitForEvent(canceled, 'close')
    expect(canceledCalls).toBe(0)

    const promised = new PassThrough()
    promised.on('data', () => undefined)
    const promise = finishedPromise(promised)
    promised.end('promise')
    await expect(promise).resolves.toBeUndefined()
  })

  it('settles late finished observers from destroy records without close events', async () => {
    const failure = new Error('late destroy error')
    const errored = new Writable({ emitClose: false })
    const observeError = () => undefined
    errored.on('error', observeError)
    errored.destroy(failure)
    await errored.destroyedPromise()
    errored.off('error', observeError)
    let callbackCalls = 0
    const callbackError = await new Promise<Error | null | undefined>(resolve => {
      finished(errored, error => {
        callbackCalls += 1
        resolve(error)
      })
    })
    expect(callbackCalls).toBe(1)
    expect(callbackError).toBe(failure)
    await expect(finishedPromise(errored)).rejects.toBe(failure)
    expect(errored.listenerCount('end')).toBe(0)
    expect(errored.listenerCount('finish')).toBe(0)
    expect(errored.listenerCount('error')).toBe(0)
    expect(errored.listenerCount('close')).toBe(0)

    const premature = new Writable({ emitClose: false })
    premature.destroy()
    await premature.destroyedPromise()
    const callbackPremature = await new Promise<Error | null | undefined>(resolve => {
      finished(premature, resolve)
    })
    await expect(finishedPromise(premature)).rejects.toBe(callbackPremature)
    expect(callbackPremature).toMatchObject({ code: 'ERR_HOLONOMY_STREAM_PREMATURE_CLOSE' })
    expect(premature.listenerCount('end')).toBe(0)
    expect(premature.listenerCount('finish')).toBe(0)
    expect(premature.listenerCount('error')).toBe(0)
    expect(premature.listenerCount('close')).toBe(0)
  })

  it('rejects objectMode and unsupported writable byte admission options', () => {
    expect(() => new Readable({ objectMode: true })).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_STREAM_NOT_SUPPORTED' })
    )
    expect(() => new Writable({ decodeStrings: false })).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_STREAM_NOT_SUPPORTED' })
    )
  })
})
