import { describe, expect, it } from 'vitest'

import { setupNativeBridge } from './native-port-fixture.js'

import type { NativePortEvent, NativeRequest } from '../src/index.js'

const request = (id: string): NativeRequest => ({
  args: {},
  id,
  module: 'runtime.test',
  operation: 'read'
})

describe('native bridge stream credit and lifecycle', () => {
  it('grants credit only on pull and releases outstanding credit on end', async () => {
    const { bridge, host, loop, port } = setupNativeBridge()
    const stream = bridge.stream(request('credit'))
    const callToken = port.latest('credit').context.callToken

    expect(port.credits).toEqual([])
    const first = stream.next()
    expect(port.credits).toEqual([{ callToken, credits: 1 }])
    expect(bridge.getSnapshot().outstandingCredits).toBe(1)

    port.emit('credit', {
      id: 'credit',
      sequence: 0,
      type: 'chunk',
      value: 'first'
    })
    expect(bridge.getSnapshot().outstandingCredits).toBe(0)
    expect(loop.runTurn().taskKind).toBe('macrotask')
    expect(host.checkpointCount).toBe(1)
    await expect(first).resolves.toEqual({
      done: false,
      value: { sequence: 0, value: 'first' }
    })

    const final = stream.next()
    port.emit('credit', {
      id: 'credit',
      type: 'end',
      value: { count: 1 }
    })
    expect(loop.runTurn().taskKind).toBe('macrotask')
    expect(host.checkpointCount).toBe(2)
    await expect(final).resolves.toEqual({
      done: true,
      value: { value: { count: 1 } }
    })
    expect(bridge.getSnapshot()).toEqual({
      inFlightBinaryBytes: 0,
      inFlightBinaryHandles: 0,
      openHandles: 0,
      openResources: 0,
      outstandingCredits: 0,
      pendingRequests: 0
    })
  })

  it('rejects provider push without credit and ignores all late chunks', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const stream = bridge.stream(request('push'))

    port.emit('push', {
      id: 'push',
      sequence: 0,
      type: 'chunk',
      value: 'uncredited'
    })
    const read = stream.next()
    loop.runTurn()
    await expect(read).rejects.toMatchObject({ code: 'protocol_error' })
    expect(port.cancellations[0]).toMatchObject({ reason: 'protocol_error' })

    const hostileLateChunk = new Proxy({}, {
      ownKeys() {
        throw new Error('late chunks must not be inspected')
      }
    })
    expect(() =>
      port.latest('push').sink(
        hostileLateChunk as NativePortEvent
      )
    ).not.toThrow()
  })

  it('closes idempotently and releases request, handle and credit reservations', async () => {
    const { bridge, port } = setupNativeBridge()
    const stream = bridge.stream({
      ...request('close'),
      binary: [{ data: new Uint8Array([1, 2]), handle: 'input' }]
    })
    const read = stream.next()

    expect(bridge.getSnapshot()).toEqual({
      inFlightBinaryBytes: 2,
      inFlightBinaryHandles: 1,
      openHandles: 2,
      openResources: 0,
      outstandingCredits: 1,
      pendingRequests: 1
    })
    expect(stream.close('reader_done')).toBe(true)
    expect(stream.close('again')).toBe(false)
    await expect(read).rejects.toMatchObject({ code: 'cancelled' })
    expect(port.cancellations[0]).toMatchObject({ reason: 'reader_done' })
    expect(bridge.getSnapshot()).toEqual({
      inFlightBinaryBytes: 0,
      inFlightBinaryHandles: 0,
      openHandles: 0,
      openResources: 0,
      outstandingCredits: 0,
      pendingRequests: 0
    })
  })

  it('caps concurrent credits per stream without terminating a valid request', async () => {
    const { bridge, loop, port } = setupNativeBridge({
      maxCreditsPerStream: 1,
      maxOutstandingCredits: 1
    })
    const stream = bridge.stream(request('credit-limit'))
    const first = stream.next()

    await expect(stream.next()).rejects.toMatchObject({ code: 'limit_exceeded' })
    expect(bridge.getSnapshot().pendingRequests).toBe(1)
    expect(port.credits).toHaveLength(1)

    port.emit('credit-limit', {
      id: 'credit-limit',
      sequence: 0,
      type: 'chunk',
      value: 'accepted'
    })
    loop.runTurn()
    await expect(first).resolves.toMatchObject({
      done: false,
      value: { sequence: 0 }
    })
    stream.close()
  })

  it('normalizes invalid sequence and oversized chunks to stable terminals', async () => {
    const invalidSequence = setupNativeBridge()
    const sequenceStream = invalidSequence.bridge.stream(request('sequence'))
    const sequenceRead = sequenceStream.next()
    invalidSequence.port.emit('sequence', {
      id: 'sequence',
      sequence: 1,
      type: 'chunk'
    })
    invalidSequence.loop.runTurn()
    await expect(sequenceRead).rejects.toMatchObject({ code: 'protocol_error' })

    const oversized = setupNativeBridge({ maxInlineBytes: 8 })
    const oversizedStream = oversized.bridge.stream(request('oversized'))
    const oversizedRead = oversizedStream.next()
    oversized.port.emit('oversized', {
      id: 'oversized',
      sequence: 0,
      type: 'chunk',
      value: 'too long'
    })
    oversized.loop.runTurn()
    await expect(oversizedRead).rejects.toMatchObject({ code: 'limit_exceeded' })
  })

  it('rejects the retained reader when chunk reservation exceeds host quota', async () => {
    const { bridge, loop, port } = setupNativeBridge({
      maxBinaryBytes: 4,
      maxInFlightBinaryBytes: 5
    })
    const stream = bridge.stream({
      ...request('chunk-reservation'),
      binary: [{ data: new Uint8Array([1, 2, 3]), handle: 'input' }]
    })
    const read = stream.next()

    port.emit('chunk-reservation', {
      binary: [{ data: new Uint8Array([4, 5, 6]), handle: 'output' }],
      id: 'chunk-reservation',
      sequence: 0,
      type: 'chunk'
    })
    expect(bridge.getSnapshot()).toMatchObject({
      outstandingCredits: 0,
      pendingRequests: 1
    })

    loop.runTurn()
    await expect(read).rejects.toMatchObject({ code: 'limit_exceeded' })
    expect(port.cancellations).toHaveLength(1)
    expect(bridge.getSnapshot()).toEqual({
      inFlightBinaryBytes: 0,
      inFlightBinaryHandles: 0,
      openHandles: 0,
      openResources: 0,
      outstandingCredits: 0,
      pendingRequests: 0
    })
  })

  it('copies chunk bytes and ignores a chunk delivered after end', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const stream = bridge.stream(request('late-chunk'))
    const read = stream.next()
    const bytes = new Uint8Array([2, 3, 5])

    port.emit('late-chunk', {
      binary: [{ data: bytes, handle: 'chunk' }],
      id: 'late-chunk',
      sequence: 0,
      type: 'chunk'
    })
    bytes[0] = 99
    loop.runTurn()
    const chunk = await read
    expect(chunk.done).toBe(false)
    if (!chunk.done) expect([...chunk.value.binary![0].data]).toEqual([2, 3, 5])

    port.emit('late-chunk', { id: 'late-chunk', type: 'end' })
    port.emit('late-chunk', {
      id: 'late-chunk',
      sequence: 1,
      type: 'chunk',
      value: 'late'
    })
    const final = stream.next()
    loop.runTurn()
    await expect(final).resolves.toEqual({ done: true, value: {} })
  })
})
