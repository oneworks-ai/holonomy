import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { createCapabilityChildProcessOverrideV1 } from '../../../src/capability-runtime/guest-child-process-facade.js'
import { snapshotChildProcessStdinDataV1 } from '../../../src/capability-runtime/guest-child-process-support.js'

const errorSnapshot = (code: string) => ({
  code,
  message: `Controlled child process failed: ${code}`,
  name: 'Error',
  retryable: false
})

const childSnapshot = (id: number) => ({
  binding: { bindingId: `process-${id}`, generation: 1 },
  pid: id,
  resourceType: 'process.child',
  stderr: null,
  stdin: {
    binding: { bindingId: `process-${id}-stdin`, generation: 1 },
    resourceType: 'process.stdin'
  },
  stdout: null
})

describe('controlled child process stdin callbacks', () => {
  it('copies only fixed byte-view slots without invoking guest properties', () => {
    const backing = Uint8Array.from([9, 0, 255, 1, 10, 65, 9])
    const view = new Uint8Array(backing.buffer, 1, 5)
    let reads = 0
    const trap = () => {
      reads += 1
      throw new Error('guest getter must not run')
    }
    for (const key of ['buffer', 'byteLength', 'length', 'constructor']) {
      Object.defineProperty(view, key, { get: trap })
    }
    Object.defineProperty(view, Symbol.iterator, { get: trap })
    Object.defineProperty(view, Symbol.species, { get: trap })
    const snapshot = snapshotChildProcessStdinDataV1(view)
    const expected = {
      base64: 'AP8BCkE=',
      byteLength: 5,
      sha256: createHash('sha256').update(Buffer.from([0, 255, 1, 10, 65])).digest('hex')
    }
    expect(snapshot).toEqual(expected)
    backing.fill(0)
    expect(snapshot).toEqual(expected)
    expect(reads).toBe(0)

    const proxied = new Proxy(new Uint8Array(1), { get: trap, getPrototypeOf: trap })
    expect(() => snapshotChildProcessStdinDataV1(proxied)).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' })
    )
    const fake = Object.create(Uint8Array.prototype, { length: { get: trap } })
    expect(() => snapshotChildProcessStdinDataV1(fake)).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' })
    )
    expect(reads).toBe(0)
  })

  it('rejects detached, shared, resizable and oversized byte views', () => {
    const detached = new ArrayBuffer(2)
    const view = new Uint8Array(detached)
    structuredClone(detached, { transfer: [detached] })
    expect(() => snapshotChildProcessStdinDataV1(view)).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' })
    )
    expect(() => snapshotChildProcessStdinDataV1(new Uint8Array(new SharedArrayBuffer(2)))).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' })
    )
    const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
    if (resizableGetter != null) {
      const Resizable = ArrayBuffer as unknown as new(length: number, options: { maxByteLength: number }) => ArrayBuffer
      const resizable = new Resizable(2, { maxByteLength: 4 })
      if (resizableGetter.call(resizable) === true) {
        expect(() => snapshotChildProcessStdinDataV1(new Uint8Array(resizable))).toThrowError(
          expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' })
        )
      }
    }
    expect(() => snapshotChildProcessStdinDataV1(new Uint8Array(16 * 1024 * 1024 + 1))).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' })
    )
  })

  it('matches SHA-256 across empty and multi-block copied input', () => {
    for (const bytes of [new Uint8Array(), Uint8Array.from({ length: 100 }, (_, index) => index)]) {
      const snapshot = snapshotChildProcessStdinDataV1(bytes) as { byteLength: number; sha256: string }
      expect(snapshot.byteLength).toBe(bytes.byteLength)
      expect(snapshot.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    }
  })

  it('binds write and end callbacks to Host resource terminals', async () => {
    const listeners = new Map<string, (event: string) => void>()
    const requests: Record<string, unknown>[] = []
    const child = childSnapshot(1)
    const terminal = (value: unknown) => JSON.stringify({ ok: true, value })
    const binding = createCapabilityChildProcessOverrideV1({
      invoke: async () => terminal({}),
      invokeImmediate: source => {
        const request = JSON.parse(source) as Record<string, unknown>
        requests.push(request)
        if (request.member === 'spawn') return terminal(child)
        if (request.member === 'ChildProcess.stdin.write') return terminal(false)
        if (request.member === 'ChildProcess.stdin.end') return terminal(child.stdin)
        throw new Error(`Unexpected member: ${String(request.member)}`)
      },
      invokeSync: () => terminal({}),
      subscribeResource: (bindingId, listener) => {
        listeners.set(bindingId, listener)
        return () => listeners.delete(bindingId)
      }
    }, {})!
    const process = (binding.namespace as Record<string, Function>).spawn('tool')
    const stdin = process.stdin as Record<string, Function>
    const delivered: unknown[][] = []

    let writing = true
    const accepted = stdin.write('first', function(error: unknown) {
      delivered.push([arguments.length, error, writing])
    })
    writing = false
    expect(accepted).toBe(false)
    expect(delivered).toEqual([])
    const first = requests.at(-1) as { providerData: { callbackId: number } }
    listeners.get('process-1-stdin')!(JSON.stringify({
      callbackId: first.providerData.callbackId,
      error: null,
      event: 'callback'
    }))
    await Promise.resolve()
    expect(delivered).toEqual([[1, null, false]])

    stdin.write(Buffer.from([0, 255, 1, 10, 65]))
    expect((requests.at(-1) as { arguments: unknown }).arguments).toEqual({
      base64: 'AP8BCkE=',
      byteLength: 5,
      sha256: createHash('sha256').update(Buffer.from([0, 255, 1, 10, 65])).digest('hex')
    })

    stdin.write('second', function(error: unknown) {
      delivered.push([arguments.length, (error as { code: string }).code])
    })
    const second = requests.at(-1) as { providerData: { callbackId: number } }
    listeners.get('process-1-stdin')!(JSON.stringify({
      callbackId: second.providerData.callbackId,
      error: errorSnapshot('EIO'),
      event: 'callback'
    }))
    await Promise.resolve()
    expect(delivered.at(-1)).toEqual([1, 'EIO'])

    let endArguments = 0
    expect(stdin.end(function(error: unknown) {
      endArguments = arguments.length
      delivered.push([error])
    })).toBe(stdin)
    expect(endArguments).toBe(0)
    const ending = requests.at(-1) as { providerData: { callbackId: number } }
    listeners.get('process-1-stdin')!(JSON.stringify({
      callbackId: ending.providerData.callbackId,
      error: null,
      event: 'callback'
    }))
    await Promise.resolve()
    expect(endArguments).toBe(1)
    const hostWrites = requests.filter(request => request.member === 'ChildProcess.stdin.write').length
    expect(() => stdin.write('after-end')).toThrowError(expect.objectContaining({ code: 'ERR_INVALID_STATE' }))
    expect(requests.filter(request => request.member === 'ChildProcess.stdin.write')).toHaveLength(hostWrites)
  })

  it('settles an in-flight callback once when the stdin resource closes', async () => {
    const listeners = new Map<string, (event: string) => void>()
    let callbackId = 0
    const child = childSnapshot(2)
    const terminal = (value: unknown) => JSON.stringify({ ok: true, value })
    const binding = createCapabilityChildProcessOverrideV1({
      invoke: async () => terminal({}),
      invokeImmediate: source => {
        const request = JSON.parse(source) as {
          member: string
          providerData?: { callbackId: number }
        }
        if (request.member === 'spawn') return terminal(child)
        callbackId = request.providerData!.callbackId
        return terminal(true)
      },
      invokeSync: () => terminal({}),
      subscribeResource: (bindingId, listener) => {
        listeners.set(bindingId, listener)
        return () => listeners.delete(bindingId)
      }
    }, {})!
    const process = (binding.namespace as Record<string, Function>).spawn('tool')
    const codes: string[] = []
    process.stdin.write('pending', (error: { code: string }) => codes.push(error.code))

    const listener = listeners.get('process-2-stdin')!
    listener(JSON.stringify({ event: 'close' }))
    await Promise.resolve()
    listener(JSON.stringify({ callbackId, error: null, event: 'callback' }))
    await Promise.resolve()
    expect(codes).toEqual(['ERR_INVALID_STATE'])
  })

  it('delivers queued stdin callbacks before child close in one resource batch', async () => {
    const listeners = new Map<string, (event: string) => void>()
    const requests: Record<string, unknown>[] = []
    const child = childSnapshot(3)
    const terminal = (value: unknown) => JSON.stringify({ ok: true, value })
    const binding = createCapabilityChildProcessOverrideV1({
      invoke: async () => terminal({}),
      invokeImmediate: source => {
        const request = JSON.parse(source) as Record<string, unknown>
        requests.push(request)
        if (request.member === 'spawn') return terminal(child)
        if (request.member === 'ChildProcess.stdin.write') return terminal(true)
        if (request.member === 'ChildProcess.stdin.end') return terminal(child.stdin)
        throw new Error(`Unexpected member: ${String(request.member)}`)
      },
      invokeSync: () => terminal({}),
      subscribeResource: (bindingId, listener) => {
        listeners.set(bindingId, listener)
        return () => listeners.delete(bindingId)
      }
    }, {})!
    const process = (binding.namespace as Record<string, Function>).spawn('tool')
    const delivered: string[] = []
    process.on('close', () => delivered.push('close'))
    process.stdin.write('payload', () => delivered.push('write'))
    const writeId = (requests.at(-1) as { providerData: { callbackId: number } }).providerData.callbackId
    process.stdin.end(() => delivered.push('end'))
    const endId = (requests.at(-1) as { providerData: { callbackId: number } }).providerData.callbackId
    const stdinEvent = listeners.get('process-3-stdin')!
    stdinEvent(JSON.stringify({ callbackId: writeId, error: null, event: 'callback' }))
    stdinEvent(JSON.stringify({ callbackId: endId, error: null, event: 'callback' }))
    stdinEvent(JSON.stringify({ event: 'close' }))
    listeners.get('process-3')!(JSON.stringify({ event: 'close', tuple: [0, null] }))
    expect(delivered).toEqual([])
    await Promise.resolve()
    expect(delivered).toEqual(['write', 'end', 'close'])
  })
})
