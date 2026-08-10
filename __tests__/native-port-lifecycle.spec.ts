import { describe, expect, it } from 'vitest'

import { NATIVE_PORT_ERROR_MESSAGES } from '../src/index.js'
import { setupNativeBridge } from './native-port-fixture.js'

import type { NativePortEvent, NativeRequest } from '../src/index.js'

const request = (
  id: string,
  args: NativeRequest['args'] = {}
): NativeRequest => ({
  args,
  id,
  module: 'runtime.test',
  operation: 'echo'
})

describe('native bridge request lifecycle', () => {
  it('selects exactly one terminal and ignores duplicate or late payloads before inspection', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const result = bridge.request(request('exactly-once'))

    port.emit('exactly-once', {
      id: 'exactly-once',
      type: 'result',
      value: { accepted: true }
    })
    expect(loop.getSnapshot()).toMatchObject({
      hasPendingWork: true,
      isAlive: true
    })
    loop.runTurn()
    await expect(result).resolves.toEqual({ value: { accepted: true } })

    const hostileLateEvent = new Proxy({}, {
      ownKeys() {
        throw new Error('late payload must not be inspected')
      }
    })
    expect(() =>
      port.latest('exactly-once').sink(
        hostileLateEvent as NativePortEvent
      )
    ).not.toThrow()
    expect(bridge.cancel('exactly-once')).toBe(false)
    expect(bridge.getSnapshot().pendingRequests).toBe(0)
  })

  it('makes the first executed side of cancel/result races win deterministically', async () => {
    const cancelFirst = setupNativeBridge()
    const cancelled = cancelFirst.bridge.request(request('cancel-first'))

    expect(cancelFirst.bridge.cancel('cancel-first', 'caller')).toBe(true)
    cancelFirst.port.emit('cancel-first', {
      id: 'cancel-first',
      type: 'result',
      value: 'late'
    })
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })
    expect(cancelFirst.port.cancellations[0]).toMatchObject({ reason: 'caller' })

    const resultFirst = setupNativeBridge()
    const completed = resultFirst.bridge.request(request('result-first'))
    resultFirst.port.emit('result-first', {
      id: 'result-first',
      type: 'result',
      value: 'winner'
    })
    resultFirst.loop.runTurn()
    expect(resultFirst.bridge.cancel('result-first')).toBe(false)
    await expect(completed).resolves.toEqual({ value: 'winner' })
  })

  it('isolates reused ids from old sinks and call tokens', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const firstStream = bridge.stream(request('reused'))
    const oldCall = port.latest('reused')
    oldCall.sink({ id: 'reused', type: 'end' })
    loop.runTurn()
    await expect(firstStream.next()).resolves.toEqual({ done: true, value: {} })

    const second = bridge.request(request('reused'))
    const newCall = port.latest('reused')
    expect(newCall.context.callToken).not.toBe(oldCall.context.callToken)
    oldCall.sink({
      id: 'reused',
      type: 'result',
      value: 'late old result'
    })
    expect(firstStream.close('old handle')).toBe(false)
    expect(bridge.getSnapshot().pendingRequests).toBe(1)

    newCall.sink({
      id: 'reused',
      type: 'result',
      value: 'current result'
    })
    loop.runTurn()
    await expect(second).resolves.toEqual({ value: 'current result' })
  })

  it('enforces absolute deadlines, relative timeouts and AbortSignal cancellation', async () => {
    const deadlineCase = setupNativeBridge()
    const deadline = deadlineCase.bridge.request({
      ...request('deadline'),
      deadlineMs: 10
    })
    deadlineCase.host.advanceTo(10)
    deadlineCase.loop.runTurn()
    await expect(deadline).rejects.toMatchObject({ code: 'timeout' })
    expect(deadlineCase.port.cancellations[0]).toMatchObject({ reason: 'timeout' })

    const timeoutCase = setupNativeBridge()
    timeoutCase.host.advanceTo(25)
    const timeout = timeoutCase.bridge.request(request('relative-timeout'), {
      timeoutMs: 5
    })
    expect(timeoutCase.port.latest('relative-timeout').request.deadlineMs).toBe(30)
    timeoutCase.host.advanceTo(30)
    timeoutCase.loop.runTurn()
    await expect(timeout).rejects.toMatchObject({ code: 'timeout' })

    const abortCase = setupNativeBridge()
    const controller = new AbortController()
    const aborted = abortCase.bridge.request(request('abort'), {
      signal: controller.signal
    })
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ code: 'cancelled' })
    expect(abortCase.port.cancellations[0]).toMatchObject({ reason: 'abort' })
  })

  it('orders queued result against its retained absolute deadline by ready time', async () => {
    const resultFirst = setupNativeBridge()
    const completed = resultFirst.bridge.request({
      ...request('result-at-nine'),
      deadlineMs: 10
    })
    resultFirst.host.advanceTo(9)
    resultFirst.port.emit('result-at-nine', {
      id: 'result-at-nine',
      type: 'result',
      value: 'winner'
    })
    resultFirst.host.advanceTo(20)

    expect(resultFirst.loop.runTurn().taskKind).toBe('native-completion')
    await expect(completed).resolves.toEqual({ value: 'winner' })
    expect(resultFirst.port.cancellations).toHaveLength(0)
    expect(resultFirst.loop.getSnapshot().hasPendingWork).toBe(false)

    const timeoutFirst = setupNativeBridge()
    const timedOut = timeoutFirst.bridge.request({
      ...request('result-at-twenty'),
      deadlineMs: 10
    })
    timeoutFirst.host.advanceTo(20)
    timeoutFirst.port.emit('result-at-twenty', {
      id: 'result-at-twenty',
      type: 'result',
      value: 'too-late'
    })

    expect(timeoutFirst.loop.runTurn().taskKind).toBe('timer')
    await expect(timedOut).rejects.toMatchObject({ code: 'timeout' })
    expect(timeoutFirst.port.cancellations).toHaveLength(1)
    expect(timeoutFirst.loop.getSnapshot().hasPendingWork).toBe(false)
  })

  it('lets abort and direct cancel beat a queued but undelivered result', async () => {
    const abortCase = setupNativeBridge()
    const controller = new AbortController()
    const aborted = abortCase.bridge.request(request('queued-abort'), {
      signal: controller.signal
    })
    abortCase.port.emit('queued-abort', {
      id: 'queued-abort',
      type: 'result',
      value: 'queued'
    })
    controller.abort()

    await expect(aborted).rejects.toMatchObject({ code: 'cancelled' })
    expect(abortCase.port.cancellations).toEqual([
      expect.objectContaining({ reason: 'abort' })
    ])
    expect(abortCase.loop.runTurn().status).toBe('idle')

    const directCase = setupNativeBridge()
    const cancelled = directCase.bridge.request(request('queued-cancel'))
    directCase.port.emit('queued-cancel', {
      id: 'queued-cancel',
      type: 'result',
      value: 'queued'
    })
    expect(directCase.bridge.cancel('queued-cancel', 'caller')).toBe(true)

    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })
    expect(directCase.port.cancellations).toEqual([
      expect.objectContaining({ reason: 'caller' })
    ])
    expect(directCase.loop.runTurn().status).toBe('idle')
  })

  it('disposes every pending request and all retained resources idempotently', async () => {
    const { bridge, port } = setupNativeBridge()
    const unary = bridge.request({
      ...request('dispose-unary'),
      binary: [{ data: new Uint8Array([1, 2, 3]), handle: 'input' }]
    })
    const stream = bridge.stream(request('dispose-stream'))
    const read = stream.next()

    expect(bridge.getSnapshot()).toEqual({
      inFlightBinaryBytes: 3,
      inFlightBinaryHandles: 1,
      openHandles: 2,
      openResources: 0,
      outstandingCredits: 1,
      pendingRequests: 2
    })
    bridge.dispose()
    bridge.dispose()

    await expect(unary).rejects.toMatchObject({ code: 'disposed' })
    await expect(read).rejects.toMatchObject({ code: 'disposed' })
    expect(port.disposeCount).toBe(1)
    expect(port.cancellations).toHaveLength(2)
    expect(bridge.getSnapshot()).toEqual({
      inFlightBinaryBytes: 0,
      inFlightBinaryHandles: 0,
      openHandles: 0,
      openResources: 0,
      outstandingCredits: 0,
      pendingRequests: 0
    })
    await expect(bridge.request(request('after-dispose'))).rejects.toMatchObject({
      code: 'disposed'
    })
  })

  it('enforces pending, inline, binary and aggregate handle quotas', async () => {
    const pendingCase = setupNativeBridge({ maxPendingRequests: 1 })
    const held = pendingCase.bridge.request(request('held'))
    await expect(
      pendingCase.bridge.request(request('pending-overflow'))
    ).rejects.toMatchObject({ code: 'limit_exceeded' })
    pendingCase.bridge.cancel('held')
    await expect(held).rejects.toMatchObject({ code: 'cancelled' })

    const inlineCase = setupNativeBridge({ maxInlineBytes: 8 })
    await expect(
      inlineCase.bridge.request(request('inline-overflow', 'too long'))
    ).rejects.toMatchObject({ code: 'limit_exceeded' })

    const binaryCase = setupNativeBridge({
      maxBinaryBytes: 3,
      maxHandles: 2,
      maxInFlightBinaryBytes: 3
    })
    const binaryHeld = binaryCase.bridge.request({
      ...request('binary-held'),
      binary: [
        { data: new Uint8Array([1, 2]), handle: 'first' },
        { data: new Uint8Array([3]), handle: 'second' }
      ]
    })
    await expect(binaryCase.bridge.request({
      ...request('binary-overflow'),
      binary: [{ data: new Uint8Array([4]), handle: 'third' }]
    })).rejects.toMatchObject({ code: 'limit_exceeded' })
    expect(() => binaryCase.bridge.stream(request('handle-overflow'))).toThrowError(
      expect.objectContaining({ code: 'limit_exceeded' })
    )
    binaryCase.bridge.cancel('binary-held')
    await expect(binaryHeld).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('rejects cyclic input and malformed provider JSON without leaking values', async () => {
    const inputCase = setupNativeBridge()
    const cyclicInput: Record<string, unknown> = {}
    cyclicInput.self = cyclicInput
    await expect(inputCase.bridge.request({
      ...request('cyclic-input'),
      args: cyclicInput as NativeRequest['args']
    })).rejects.toMatchObject({ code: 'invalid_value' })
    expect(inputCase.port.calls).toHaveLength(0)

    const outputCase = setupNativeBridge()
    const terminal = outputCase.bridge.request(request('cyclic-output'))
    const cyclicOutput: Record<string, unknown> = {}
    cyclicOutput.self = cyclicOutput
    outputCase.port.emit('cyclic-output', {
      id: 'cyclic-output',
      type: 'result',
      value: cyclicOutput
    } as unknown as NativePortEvent)
    outputCase.loop.runTurn()
    await expect(terminal).rejects.toMatchObject({
      code: 'protocol_error',
      message: NATIVE_PORT_ERROR_MESSAGES.protocol_error
    })
  })

  it('copies input and output bytes without base64 or shared mutation', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const input = new Uint8Array([1, 2, 3])
    const completed = bridge.request({
      ...request('binary-copy'),
      binary: [{ data: input, handle: 'input' }]
    })
    input[0] = 99

    const dispatched = port.latest('binary-copy').request
    expect(dispatched.binary?.[0]?.data).toBeInstanceOf(Uint8Array)
    expect([...dispatched.binary![0].data]).toEqual([1, 2, 3])
    expect(dispatched.binary?.[0]?.data).not.toBe(input)

    const output = new Uint8Array([5, 8, 13])
    port.emit('binary-copy', {
      binary: [{ data: output.buffer, handle: 'output' }],
      id: 'binary-copy',
      type: 'result'
    })
    output[0] = 42
    expect(bridge.getSnapshot().inFlightBinaryBytes).toBe(6)
    loop.runTurn()

    const result = await completed
    expect(result.binary?.[0]?.data).toBeInstanceOf(Uint8Array)
    expect([...result.binary![0].data]).toEqual([5, 8, 13])
    expect(bridge.getSnapshot().inFlightBinaryBytes).toBe(0)
  })

  it('normalizes provider failures and never exposes platform exception text', async () => {
    const dispatchFailure = setupNativeBridge()
    dispatchFailure.port.throwOnDispatch = true
    const failed = dispatchFailure.bridge.request(request('dispatch-failure'))
    dispatchFailure.loop.runTurn()
    await expect(failed).rejects.toMatchObject({
      code: 'internal',
      message: NATIVE_PORT_ERROR_MESSAGES.internal
    })
    await expect(failed).rejects.not.toMatchObject({
      message: expect.stringContaining('secret')
    })

    const providerFailure = setupNativeBridge()
    const terminal = providerFailure.bridge.request(request('provider-failure'))
    providerFailure.port.emit('provider-failure', {
      error: { code: 'operation_unsupported' },
      id: 'provider-failure',
      type: 'error'
    })
    providerFailure.loop.runTurn()
    await expect(terminal).rejects.toMatchObject({
      code: 'operation_unsupported',
      message: NATIVE_PORT_ERROR_MESSAGES.operation_unsupported
    })

    const invalidError = setupNativeBridge()
    const invalidTerminal = invalidError.bridge.request(request('invalid-error'))
    invalidError.port.emit('invalid-error', {
      error: { code: 'platform_stack_trace' },
      id: 'invalid-error',
      type: 'error'
    } as unknown as NativePortEvent)
    invalidError.loop.runTurn()
    await expect(invalidTerminal).rejects.toMatchObject({
      code: 'protocol_error',
      message: NATIVE_PORT_ERROR_MESSAGES.protocol_error
    })
  })

  it.each(
    [
      ['fs', 'not_found', 'file'],
      ['fs', 'exists', 'directory'],
      ['fs', 'permission_denied', 'file'],
      ['network', 'unavailable', 'host'],
      ['network', 'timeout', 'socket'],
      ['network', 'connection_refused', 'socket']
    ] as const
  )(
    'maps bounded %s/%s provider errors without native messages',
    async (domain, code, resource) => {
      const { bridge, loop, port } = setupNativeBridge()
      const terminal = bridge.request(request(`domain-${domain}-${code}`))
      port.emit(`domain-${domain}-${code}`, {
        error: {
          code,
          details: { resource, retryable: domain === 'network' },
          domain
        },
        id: `domain-${domain}-${code}`,
        type: 'error'
      })
      loop.runTurn()
      await expect(terminal).rejects.toMatchObject({
        code,
        details: { resource, retryable: domain === 'network' },
        domain,
        message: NATIVE_PORT_ERROR_MESSAGES[code]
      })
    }
  )

  it('rejects provider messages outside the bounded error envelope', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const terminal = bridge.request(request('native-message'))
    port.emit('native-message', {
      error: {
        code: 'not_found',
        domain: 'fs',
        message: 'secret native filesystem path'
      },
      id: 'native-message',
      type: 'error'
    } as unknown as NativePortEvent)
    loop.runTurn()
    await expect(terminal).rejects.toMatchObject({
      code: 'protocol_error',
      message: NATIVE_PORT_ERROR_MESSAGES.protocol_error
    })
  })

  it('injects frozen authority and call identity out-of-band for re-authorization', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const completed = bridge.request(request('authority'))
    const call = port.latest('authority')

    expect(Object.keys(call.request).sort()).toEqual([
      'args',
      'id',
      'module',
      'operation'
    ])
    expect(call.context.authority).toEqual({
      capabilities: ['runtime.echo', 'runtime.read'],
      principal: 'guest-1'
    })
    expect(call.context.callToken).not.toBe('authority')
    expect(call.context.mode).toBe('result')
    expect(call.context.resources).toEqual([])
    expect(Object.isFrozen(call.context)).toBe(true)
    expect(Object.isFrozen(call.context.authority)).toBe(true)
    expect(Object.isFrozen(call.context.authority.capabilities)).toBe(true)

    port.emit('authority', { id: 'authority', type: 'result', value: null })
    loop.runTurn()
    await completed
  })
})
