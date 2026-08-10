/* eslint-disable max-lines -- hostile admission, async port and resource conformance share one bridge fixture. */

import { describe, expect, it } from 'vitest'

import { RuntimeEventLoop, createNativeBridge } from '../src/index.js'
import {
  ControlledNativePort,
  VirtualNativeHost,
  createDeferred,
  providerToken,
  setupNativeBridge
} from './native-port-fixture.js'

import type { NativeCallOptions, NativePortEvent, NativeRequest, NativeResourceHandle } from '../src/index.js'
const request = (
  id: string,
  args: NativeRequest['args'] = {}
): NativeRequest => ({
  args,
  id,
  module: 'runtime.test',
  operation: 'echo'
})

describe('native bridge event-loop integration and hostile admission', () => {
  it('keeps the loop alive and delivers provider completion in a turn before checkpoint', async () => {
    const { bridge, host, loop, port } = setupNativeBridge()
    let promiseReactionRan = false
    const completed = bridge.request(request('loop-order'))
    void completed.then(() => {
      promiseReactionRan = true
    })

    expect(loop.getSnapshot()).toEqual({
      hasPendingWork: true,
      isAlive: true,
      nextWakeupAt: null
    })
    port.emit('loop-order', {
      id: 'loop-order',
      type: 'result',
      value: 'done'
    })
    expect(promiseReactionRan).toBe(false)
    expect(host.checkpointCount).toBe(0)

    expect(loop.runTurn()).toMatchObject({
      hasPendingWork: false,
      isAlive: false,
      taskKind: 'native-completion'
    })
    expect(host.checkpointCount).toBe(1)
    await expect(completed).resolves.toEqual({ value: 'done' })
    expect(promiseReactionRan).toBe(true)
  })

  it('atomically rejects admission and tears down the bridge on wakeup failure', async () => {
    const { bridge, host, loop, port } = setupNativeBridge()
    host.throwOnWakeup = true

    await expect(bridge.request(request('wakeup-failure'))).rejects.toMatchObject({
      code: 'internal'
    })
    expect(port.calls).toHaveLength(0)
    expect(port.disposeCount).toBe(1)
    expect(bridge.getSnapshot().pendingRequests).toBe(0)
    expect(loop.getSnapshot().hasPendingWork).toBe(false)
  })

  it('composes loop shutdown with pending, resource and provider disposal once', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const opened = bridge.request(request('loop-resource'))
    port.emit('loop-resource', {
      id: 'loop-resource',
      resources: [{
        providerToken: providerToken('loop-resource-token'),
        type: 'fs.file'
      }],
      type: 'result'
    })
    loop.runTurn()
    const handle = (await opened).resources![0]
    const unary = bridge.request(request('loop-unary'))
    const stream = bridge.stream(request('loop-stream'))
    const read = stream.next()

    loop.shutdown()
    bridge.dispose()

    await expect(unary).rejects.toMatchObject({ code: 'disposed' })
    await expect(read).rejects.toMatchObject({ code: 'disposed' })
    expect(handle.close()).toBe(false)
    expect(port.cancellations).toHaveLength(2)
    expect(port.closedResources).toContainEqual(expect.objectContaining({
      providerToken: 'loop-resource-token',
      reason: 'loop_shutdown'
    }))
    expect(port.disposeCount).toBe(1)
    expect(bridge.getSnapshot()).toEqual({
      inFlightBinaryBytes: 0,
      inFlightBinaryHandles: 0,
      openHandles: 0,
      openResources: 0,
      outstandingCredits: 0,
      pendingRequests: 0
    })
  })

  it('propagates fatal loop teardown to the bridge independent of call order', async () => {
    const fatal = setupNativeBridge()
    const pending = fatal.bridge.request(request('loop-fatal'))
    fatal.host.advanceTo(10)
    fatal.loop.getCurrentTime()
    fatal.host.advanceTo(9)

    expect(() => fatal.loop.getCurrentTime()).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_CLOCK_NOT_MONOTONIC' })
    )
    await expect(pending).rejects.toMatchObject({ code: 'internal' })
    expect(fatal.port.cancellations[0]).toMatchObject({ reason: 'loop_error' })
    expect(fatal.port.disposeCount).toBe(1)

    const bridgeFirst = setupNativeBridge()
    bridgeFirst.bridge.dispose()
    bridgeFirst.loop.shutdown()
    expect(bridgeFirst.port.disposeCount).toBe(1)
  })

  it('rolls back args ownKeys reentry without dispatch or Map overwrite', async () => {
    const { bridge, port } = setupNativeBridge()
    let nested: Promise<unknown> | undefined
    const args = new Proxy({}, {
      ownKeys(target) {
        nested = bridge.request(request('reentrant'))
        return Reflect.ownKeys(target)
      }
    })

    const outer = bridge.request(request('reentrant', args))
    await expect(outer).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(nested).rejects.toMatchObject({ code: 'invalid_request' })
    expect(port.calls).toHaveLength(0)
    expect(bridge.getSnapshot().pendingRequests).toBe(0)
  })

  it('rolls back when the loop clock disposes during commit', async () => {
    const { bridge, host, loop, port } = setupNativeBridge()
    host.nowHook = () => bridge.dispose()

    await expect(bridge.request(request('clock-dispose'))).rejects.toMatchObject({
      code: 'disposed'
    })
    expect(port.calls).toHaveLength(0)
    expect(bridge.getSnapshot().pendingRequests).toBe(0)
    expect(loop.getSnapshot()).toEqual({
      hasPendingWork: false,
      isAlive: false,
      nextWakeupAt: null
    })
  })

  it('rejects accessor signal/options without invoking guest getters', async () => {
    const { bridge, port } = setupNativeBridge()
    let getterRan = false
    const options = Object.defineProperty({}, 'signal', {
      enumerable: true,
      get() {
        getterRan = true
        throw new Error('guest getter')
      }
    }) as NativeCallOptions

    await expect(bridge.request(request('signal-getter'), options)).rejects.toMatchObject({
      code: 'invalid_request'
    })
    expect(getterRan).toBe(false)
    expect(port.calls).toHaveLength(0)
  })

  it('snapshots authority data without invoking accessors or proxy traps', () => {
    const host = new VirtualNativeHost()
    const loop = new RuntimeEventLoop(host)
    const port = new ControlledNativePort()
    let principalGetterRan = false
    const authority = Object.defineProperties({}, {
      capabilities: { enumerable: true, value: [] },
      principal: {
        enumerable: true,
        get() {
          principalGetterRan = true
          throw new Error('authority getter')
        }
      }
    })

    expect(() =>
      createNativeBridge(port, {
        authority: authority as { capabilities: string[]; principal: string },
        eventLoop: loop
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }))
    expect(principalGetterRan).toBe(false)

    expect(() =>
      createNativeBridge(port, {
        authority: new Proxy({}, {
          ownKeys() {
            throw new Error('authority proxy')
          }
        }) as { capabilities: string[]; principal: string },
        eventLoop: loop
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }))

    let optionsOwnKeysCalls = 0
    expect(() =>
      createNativeBridge(
        port,
        new Proxy({
          authority: { capabilities: [], principal: 'guest-1' },
          eventLoop: loop
        }, {
          ownKeys() {
            optionsOwnKeysCalls += 1
            return []
          }
        }) as unknown as Parameters<typeof createNativeBridge>[1]
      )
    ).not.toThrow()
    expect(optionsOwnKeysCalls).toBe(0)
  })

  it('uses captured AbortSignal methods instead of hostile instance accessors', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const controller = new AbortController()
    let instanceGetterRan = false
    Object.defineProperty(controller.signal, 'addEventListener', {
      configurable: true,
      get() {
        instanceGetterRan = true
        throw new Error('signal method getter')
      }
    })

    const completed = bridge.request(request('captured-signal'), {
      signal: controller.signal
    })
    port.emit('captured-signal', { id: 'captured-signal', type: 'result' })
    loop.runTurn()
    await expect(completed).resolves.toEqual({})
    expect(instanceGetterRan).toBe(false)
  })

  it('captures loop methods once and treats a backwards clock as fatal', async () => {
    const host = new VirtualNativeHost()
    const loop = new RuntimeEventLoop(host)
    const port = new ControlledNativePort()
    const bridge = createNativeBridge(port, {
      authority: { capabilities: [], principal: 'guest-1' },
      eventLoop: loop
    })
    Object.defineProperty(loop, 'registerNativeRequest', {
      value: () => {
        throw new Error('mutated method must not run')
      }
    })

    const completed = bridge.request(request('bound-loop'))
    port.emit('bound-loop', { id: 'bound-loop', type: 'result' })
    loop.runTurn()
    await expect(completed).resolves.toEqual({})

    host.advanceTo(10)
    expect(loop.getCurrentTime()).toBe(10)
    host.advanceTo(9)
    expect(() => loop.getCurrentTime()).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_CLOCK_NOT_MONOTONIC' })
    )
    expect(loop.isDisposed).toBe(true)
  })

  it('keeps an absolute deadline on loop timers even when one timer is clamped', async () => {
    const host = new VirtualNativeHost()
    const loop = new RuntimeEventLoop(host, { maxTimerDelayMs: 5 })
    const port = new ControlledNativePort()
    const bridge = createNativeBridge(port, {
      authority: { capabilities: [], principal: 'guest-1' },
      eventLoop: loop
    })
    let rejected = false
    const pending = bridge.request({
      ...request('clamped-deadline'),
      deadlineMs: 12
    }).catch(error => {
      rejected = true
      throw error
    })

    host.advanceTo(5)
    loop.runTurn()
    expect(rejected).toBe(false)
    expect(bridge.getSnapshot().pendingRequests).toBe(1)
    host.advanceTo(10)
    loop.runTurn()
    expect(rejected).toBe(false)
    host.advanceTo(12)
    loop.runTurn()
    await expect(pending).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('native port async generation and output quota conformance', () => {
  it('normalizes an asynchronous dispatch rejection through a loop completion', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const dispatch = createDeferred()
    port.dispatchResult = dispatch.promise
    const completed = bridge.request(request('async-dispatch'))

    dispatch.reject(new Error('secret async failure'))
    await Promise.resolve()
    expect(loop.getSnapshot()).toMatchObject({ isAlive: true })
    loop.runTurn()
    await expect(completed).rejects.toMatchObject({ code: 'internal' })
  })

  it('isolates an old asynchronous cancel from immediate guest-id reuse', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const oldCancel = createDeferred()
    port.cancelResult = oldCancel.promise
    const first = bridge.request(request('reuse-after-cancel'))
    const oldToken = port.latest('reuse-after-cancel').context.callToken
    expect(bridge.cancel('reuse-after-cancel', 'replace')).toBe(true)
    await expect(first).rejects.toMatchObject({ code: 'cancelled' })

    port.cancelResult = undefined
    const second = bridge.request(request('reuse-after-cancel'))
    const current = port.latest('reuse-after-cancel')
    expect(current.context.callToken).not.toBe(oldToken)
    oldCancel.reject(new Error('late old cancel'))
    await Promise.resolve()
    expect(bridge.getSnapshot().pendingRequests).toBe(1)

    current.sink({
      id: 'reuse-after-cancel',
      type: 'result',
      value: 'current'
    })
    loop.runTurn()
    await expect(second).resolves.toEqual({ value: 'current' })
  })

  it('preflights host-wide output quota before accepting a second copy', async () => {
    const { bridge, loop, port } = setupNativeBridge({
      maxBinaryBytes: 4,
      maxInFlightBinaryBytes: 5
    })
    const first = bridge.request(request('output-first'))
    const second = bridge.request(request('output-second'))
    port.emit('output-first', {
      binary: [{ data: new Uint8Array([1, 2, 3]), handle: 'first' }],
      id: 'output-first',
      type: 'result'
    })
    expect(bridge.getSnapshot().inFlightBinaryBytes).toBe(3)
    port.emit('output-second', {
      binary: [{ data: new Uint8Array([4, 5, 6]), handle: 'second' }],
      id: 'output-second',
      type: 'result'
    })
    expect(bridge.getSnapshot().inFlightBinaryBytes).toBe(3)

    loop.runTurn()
    loop.runTurn()
    await expect(first).resolves.toMatchObject({ binary: expect.any(Array) })
    await expect(second).rejects.toMatchObject({ code: 'limit_exceeded' })
    expect(bridge.getSnapshot().inFlightBinaryBytes).toBe(0)
  })

  it('consumes asynchronous credit, close, cancel and dispose failures', async () => {
    const creditCase = setupNativeBridge()
    const creditFailure = createDeferred()
    creditCase.port.grantCreditsResult = creditFailure.promise
    const stream = creditCase.bridge.stream(request('credit-reject'))
    const read = stream.next()
    creditFailure.reject(new Error('credit'))
    await Promise.resolve()
    creditCase.loop.runTurn()
    await expect(read).rejects.toMatchObject({ code: 'internal' })

    const disposeFailure = createDeferred()
    creditCase.port.disposeResult = disposeFailure.promise
    creditCase.bridge.dispose()
    disposeFailure.reject(new Error('dispose'))
    await Promise.resolve()
  })
})

describe('opaque native resource lifecycle', () => {
  it('binds a resource across requests without exposing its provider token', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const token = providerToken('file-descriptor-7')
    const opened = bridge.request(request('open-resource'))
    port.emit('open-resource', {
      id: 'open-resource',
      resources: [{ providerToken: token, type: 'fs.file' }],
      type: 'result'
    })
    loop.runTurn()
    const handle = (await opened).resources![0]

    expect(Reflect.ownKeys(handle).sort()).toEqual(['close', 'type'])
    expect(JSON.stringify(handle)).not.toContain('file-descriptor-7')
    expect(bridge.getSnapshot()).toMatchObject({
      openHandles: 1,
      openResources: 1
    })

    const used = bridge.request(request('use-resource', { file: handle }))
    const useCall = port.latest('use-resource')
    expect(useCall.request.args).toEqual({
      file: { resource: 'resource:0' }
    })
    expect(useCall.context.resources).toEqual([{
      ownerCallToken: port.latest('open-resource').context.callToken,
      providerToken: token,
      reference: { resource: 'resource:0' },
      type: 'fs.file'
    }])
    expect((useCall.request.args as { file: object }).file).toBe(
      useCall.context.resources[0]!.reference
    )
    expect(useCall.request.args).not.toEqual(expect.objectContaining({
      providerToken: token
    }))
    useCall.sink({ id: 'use-resource', type: 'result' })
    loop.runTurn()
    await used

    expect(handle.close('guest-close')).toBe(true)
    expect(handle.close('duplicate')).toBe(false)
    expect(bridge.revokeResource(handle)).toBe(false)
    expect(port.closedResources).toHaveLength(1)
    expect(port.closedResources[0]).toMatchObject({
      providerToken: token,
      reason: 'guest-close'
    })
    await expect(bridge.request(request('closed-resource', {
      file: handle
    }))).rejects.toMatchObject({ code: 'resource_invalid' })
    expect(bridge.getSnapshot()).toMatchObject({
      openHandles: 0,
      openResources: 0
    })
  })

  it('rejects cross-controller/principal handles and supports provider revoke', async () => {
    const owner = setupNativeBridge()
    const foreign = setupNativeBridge({}, 'guest-2')
    const token = providerToken('socket-1')
    const opened = owner.bridge.request(request('open-socket'))
    owner.port.emit('open-socket', {
      id: 'open-socket',
      resources: [{ providerToken: token, type: 'network.websocket' }],
      type: 'result'
    })
    owner.loop.runTurn()
    const handle = (await opened).resources![0]

    await expect(foreign.bridge.request(request('foreign-use', {
      socket: handle
    }))).rejects.toMatchObject({ code: 'resource_invalid' })
    owner.port.revoke('open-socket', { providerToken: token, type: 'revoke' })
    expect(owner.bridge.getSnapshot().openResources).toBe(1)
    owner.loop.runTurn()
    expect(handle.close()).toBe(false)
    expect(owner.port.closedResources).toHaveLength(0)
    expect(owner.bridge.getSnapshot().openResources).toBe(0)
  })

  it('enforces open-resource quota and closes open resources once on dispose', async () => {
    const { bridge, loop, port } = setupNativeBridge({ maxOpenResources: 1 })
    const first = bridge.request(request('first-resource'))
    port.emit('first-resource', {
      id: 'first-resource',
      resources: [{
        providerToken: providerToken('first-token'),
        type: 'sqlite.database'
      }],
      type: 'result'
    })
    loop.runTurn()
    const handle = (await first).resources![0]

    const overflow = bridge.request(request('overflow-resource'))
    port.emit('overflow-resource', {
      id: 'overflow-resource',
      resources: [{
        providerToken: providerToken('second-token'),
        type: 'sqlite.database'
      }],
      type: 'result'
    })
    expect(port.operations.slice(-2)).toEqual([
      'close:second-token:undelivered',
      'cancel:limit_exceeded'
    ])
    loop.runTurn()
    await expect(overflow).rejects.toMatchObject({ code: 'limit_exceeded' })

    const closeFailure = createDeferred()
    port.closeResourceResult = closeFailure.promise
    bridge.dispose()
    closeFailure.reject(new Error('async close'))
    await Promise.resolve()
    expect(handle.close()).toBe(false)
    expect(port.closedResources).toHaveLength(2)
    expect(bridge.getSnapshot()).toEqual({
      inFlightBinaryBytes: 0,
      inFlightBinaryHandles: 0,
      openHandles: 0,
      openResources: 0,
      outstandingCredits: 0,
      pendingRequests: 0
    })
  })

  it('closes every unique collided grant before cancelling its call', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const pending = bridge.request(request('duplicate-grant'))
    const token = providerToken('duplicate-token')
    port.emit('duplicate-grant', {
      id: 'duplicate-grant',
      resources: [
        { providerToken: token, type: 'fs.file' },
        { providerToken: token, type: 'fs.file' }
      ],
      type: 'result'
    })

    expect(port.closedResources).toHaveLength(1)
    expect(port.operations).toEqual([
      'close:duplicate-token:undelivered',
      'cancel:protocol_error'
    ])
    loop.runTurn()
    await expect(pending).rejects.toMatchObject({ code: 'protocol_error' })
    expect(bridge.getSnapshot()).toMatchObject({
      openHandles: 0,
      openResources: 0
    })
  })

  it('locks quota failure before synchronous close and cancel sink reentry', async () => {
    const { bridge, loop, port } = setupNativeBridge({ maxOpenResources: 2 })
    const opened = bridge.request(request('reentry-open'))
    port.emit('reentry-open', {
      id: 'reentry-open',
      resources: [{
        providerToken: providerToken('retained-token'),
        type: 'fs.file'
      }],
      type: 'result'
    })
    loop.runTurn()
    const retained = (await opened).resources![0]

    const failed = bridge.request(request('reentry-undelivered'))
    const staleResult = () => {
      port.latest('reentry-undelivered').sink({
        id: 'reentry-undelivered',
        type: 'result',
        value: 'stale-result'
      })
      port.latest('reentry-undelivered').sink({
        id: 'reentry-undelivered',
        sequence: 0,
        type: 'chunk',
        value: 'stale-chunk'
      } as NativePortEvent)
    }
    port.closeResourceHook = staleResult
    port.cancelHook = staleResult

    port.emit('reentry-undelivered', {
      id: 'reentry-undelivered',
      resources: [
        { providerToken: providerToken('undelivered-a'), type: 'fs.file' },
        { providerToken: providerToken('undelivered-b'), type: 'fs.file' }
      ],
      type: 'result'
    })

    expect(port.operations).toEqual([
      'close:undelivered-a:undelivered',
      'close:undelivered-b:undelivered',
      'cancel:limit_exceeded'
    ])
    expect(port.closedResources.map(resource => resource.providerToken)).toEqual([
      'undelivered-a',
      'undelivered-b'
    ])
    expect(port.cancellations).toHaveLength(1)
    loop.runTurn()
    await expect(failed).rejects.toMatchObject({ code: 'limit_exceeded' })
    expect(bridge.getSnapshot()).toMatchObject({
      openResources: 1,
      pendingRequests: 0
    })
    expect(retained.close()).toBe(true)
  })

  it.each(
    [
      { grants: [], label: 'zero' },
      {
        grants: [{ providerToken: providerToken('error-one'), type: 'fs.file' }],
        label: 'one'
      },
      {
        grants: [
          { providerToken: providerToken('error-two-a'), type: 'fs.file' },
          { providerToken: providerToken('error-two-b'), type: 'fs.file' }
        ],
        label: 'two'
      }
    ] as const
  )(
    'closes $label verifiable grants from a malformed provider error',
    async ({ grants, label }) => {
      const { bridge, loop, port } = setupNativeBridge()
      const id = `malformed-error-${label}`
      const pending = bridge.request(request(id))
      port.emit(id, {
        error: { code: 'operation_unsupported' },
        id,
        resources: grants,
        type: 'error'
      } as unknown as NativePortEvent)

      expect(port.closedResources.map(resource => resource.providerToken)).toEqual(
        grants.map(grant => grant.providerToken)
      )
      expect(port.cancellations).toHaveLength(1)
      loop.runTurn()
      await expect(pending).rejects.toMatchObject({ code: 'protocol_error' })
      expect(bridge.getSnapshot()).toEqual({
        inFlightBinaryBytes: 0,
        inFlightBinaryHandles: 0,
        openHandles: 0,
        openResources: 0,
        outstandingCredits: 0,
        pendingRequests: 0
      })
    }
  )

  it('deduplicates and collision-rejects malformed error grants before cleanup', async () => {
    const duplicate = setupNativeBridge()
    const duplicatePending = duplicate.bridge.request(request('error-duplicate'))
    const duplicateToken = providerToken('error-duplicate-token')
    duplicate.port.emit('error-duplicate', {
      error: { code: 'operation_unsupported' },
      id: 'error-duplicate',
      resources: [
        { providerToken: duplicateToken, type: 'fs.file' },
        { providerToken: duplicateToken, type: 'fs.file' }
      ],
      type: 'error'
    } as unknown as NativePortEvent)
    expect(duplicate.port.closedResources).toHaveLength(1)
    expect(duplicate.port.cancellations).toHaveLength(1)
    duplicate.loop.runTurn()
    await expect(duplicatePending).rejects.toMatchObject({ code: 'protocol_error' })
    expect(duplicate.bridge.getSnapshot().openResources).toBe(0)

    const collision = setupNativeBridge()
    const opened = collision.bridge.request(request('error-collision-open'))
    const collisionToken = providerToken('error-collision-token')
    collision.port.emit('error-collision-open', {
      id: 'error-collision-open',
      resources: [{ providerToken: collisionToken, type: 'fs.file' }],
      type: 'result'
    })
    collision.loop.runTurn()
    const retained = (await opened).resources![0]
    const collided = collision.bridge.request(request('error-collision'))
    collision.port.emit('error-collision', {
      error: { code: 'operation_unsupported' },
      id: 'error-collision',
      resources: [{ providerToken: collisionToken, type: 'fs.file' }],
      type: 'error'
    } as unknown as NativePortEvent)
    expect(collision.port.closedResources).toHaveLength(0)
    expect(collision.port.cancellations).toHaveLength(1)
    collision.loop.runTurn()
    await expect(collided).rejects.toMatchObject({ code: 'protocol_error' })
    expect(retained.close()).toBe(true)
    expect(collision.port.closedResources).toHaveLength(1)
    expect(collision.bridge.getSnapshot().openResources).toBe(0)
  })

  it('contains reentry, throw and async close rejection for malformed error grants', async () => {
    const reentry = setupNativeBridge()
    const reentryPending = reentry.bridge.request(request('error-reentry'))
    const staleSink = () => {
      reentry.port.latest('error-reentry').sink({
        id: 'error-reentry',
        type: 'result',
        value: 'stale'
      })
    }
    reentry.port.closeResourceHook = staleSink
    reentry.port.cancelHook = staleSink
    reentry.port.emit('error-reentry', {
      error: { code: 'operation_unsupported' },
      id: 'error-reentry',
      resources: [
        { providerToken: providerToken('error-reentry-a'), type: 'fs.file' },
        { providerToken: providerToken('error-reentry-b'), type: 'fs.file' }
      ],
      type: 'error'
    } as unknown as NativePortEvent)
    expect(reentry.port.operations).toEqual([
      'close:error-reentry-a:undelivered',
      'close:error-reentry-b:undelivered',
      'cancel:protocol_error'
    ])
    reentry.loop.runTurn()
    await expect(reentryPending).rejects.toMatchObject({ code: 'protocol_error' })

    const thrown = setupNativeBridge()
    const thrownPending = thrown.bridge.request(request('error-close-throw'))
    thrown.port.closeResourceHook = () => {
      throw new Error('provider close failure')
    }
    thrown.port.emit('error-close-throw', {
      error: { code: 'operation_unsupported' },
      id: 'error-close-throw',
      resources: [{
        providerToken: providerToken('error-close-throw-token'),
        type: 'fs.file'
      }],
      type: 'error'
    } as unknown as NativePortEvent)
    thrown.loop.runTurn()
    await expect(thrownPending).rejects.toMatchObject({ code: 'protocol_error' })
    expect(thrown.port.cancellations).toHaveLength(1)

    const asynchronous = setupNativeBridge()
    const close = createDeferred()
    asynchronous.port.closeResourceResult = close.promise
    const asynchronousPending = asynchronous.bridge.request(request('error-close-async'))
    asynchronous.port.emit('error-close-async', {
      error: { code: 'operation_unsupported' },
      id: 'error-close-async',
      resources: [{
        providerToken: providerToken('error-close-async-token'),
        type: 'fs.file'
      }],
      type: 'error'
    } as unknown as NativePortEvent)
    close.reject(new Error('provider async close failure'))
    await Promise.resolve()
    asynchronous.loop.runTurn()
    await expect(asynchronousPending).rejects.toMatchObject({
      code: 'protocol_error'
    })
    expect(asynchronous.port.cancellations).toHaveLength(1)
  })

  it('consumes hostile close thenables without replacing the first terminal', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const rawDetail = 'native thenable rejection must remain private'
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    let reentered = false
    const thenable = Object.defineProperty({}, 'then', {
      get() {
        if (!reentered) {
          reentered = true
          port.emit('hostile-close-thenable', {
            error: { code: 'operation_unsupported' },
            id: 'hostile-close-thenable',
            resources: [{
              providerToken: providerToken('hostile-thenable-second'),
              type: 'fs.file'
            }],
            type: 'error'
          } as unknown as NativePortEvent)
        }
        return (_resolve: () => void, reject: (reason: unknown) => void) => {
          reject(new Error(rawDetail))
        }
      }
    }) as PromiseLike<void>
    port.closeResourceResult = thenable
    process.on('unhandledRejection', onUnhandled)
    try {
      const pending = bridge.request(request('hostile-close-thenable'))
      port.emit('hostile-close-thenable', {
        error: { code: 'operation_unsupported' },
        id: 'hostile-close-thenable',
        resources: [{
          providerToken: providerToken('hostile-thenable-first'),
          type: 'fs.file'
        }],
        type: 'error'
      } as unknown as NativePortEvent)
      expect(port.closedResources.map(item => item.providerToken)).toEqual([
        'hostile-thenable-first',
        'hostile-thenable-second'
      ])
      expect(port.cancellations).toEqual([expect.objectContaining({
        reason: 'protocol_error'
      })])
      await Promise.resolve()
      await Promise.resolve()
      loop.runTurn()
      await pending.then(
        () => {
          throw new Error('expected protocol_error')
        },
        error => {
          expect(error).toMatchObject({ code: 'protocol_error' })
          expect(String(error.message)).not.toContain(rawDetail)
          expect(JSON.stringify(error)).not.toContain(rawDetail)
        }
      )
      expect(unhandled).toEqual([])
      expect(bridge.getSnapshot()).toEqual({
        inFlightBinaryBytes: 0,
        inFlightBinaryHandles: 0,
        openHandles: 0,
        openResources: 0,
        outstandingCredits: 0,
        pendingRequests: 0
      })
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('cleans an outer preflight grant after a descriptor trap locks the inner terminal', async () => {
    const success = setupNativeBridge()
    const rawDetail = 'outer provider detail must not reach the guest'
    let successDescriptorReads = 0
    const successTarget = {
      id: 'preflight-reentry-success',
      resources: [{
        providerToken: providerToken('preflight-success-outer'),
        type: 'fs.file'
      }],
      type: 'result',
      value: () => rawDetail
    }
    const successOuter = new Proxy(successTarget, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'value') {
          successDescriptorReads += 1
          success.port.emit('preflight-reentry-success', {
            id: 'preflight-reentry-success',
            type: 'result',
            value: 'inner-wins'
          })
        }
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })
    const successPending = success.bridge.request(request('preflight-reentry-success'))
    success.port.emit(
      'preflight-reentry-success',
      successOuter as unknown as NativePortEvent
    )
    expect(successDescriptorReads).toBe(1)
    expect(success.port.closedResources).toEqual([expect.objectContaining({
      providerToken: 'preflight-success-outer',
      reason: 'undelivered'
    })])
    expect(success.port.cancellations).toHaveLength(0)
    success.loop.runTurn()
    await expect(successPending).resolves.toEqual({ value: 'inner-wins' })
    expect(success.bridge.getSnapshot()).toEqual({
      inFlightBinaryBytes: 0,
      inFlightBinaryHandles: 0,
      openHandles: 0,
      openResources: 0,
      outstandingCredits: 0,
      pendingRequests: 0
    })

    const failure = setupNativeBridge()
    let failureDescriptorReads = 0
    const failureTarget = {
      id: 'preflight-reentry-failure',
      resources: [{
        providerToken: providerToken('preflight-failure-outer'),
        type: 'fs.file'
      }],
      type: 'result',
      value: () => rawDetail
    }
    const failureOuter = new Proxy(failureTarget, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'value') {
          failureDescriptorReads += 1
          failure.port.emit('preflight-reentry-failure', {
            error: { code: 'operation_unsupported' },
            id: 'preflight-reentry-failure',
            resources: [{
              providerToken: providerToken('preflight-failure-inner'),
              type: 'fs.file'
            }],
            type: 'error'
          } as unknown as NativePortEvent)
        }
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })
    const failurePending = failure.bridge.request(request('preflight-reentry-failure'))
    failure.port.emit(
      'preflight-reentry-failure',
      failureOuter as unknown as NativePortEvent
    )
    expect(failureDescriptorReads).toBe(1)
    expect(failure.port.closedResources.map(item => item.providerToken)).toEqual([
      'preflight-failure-inner',
      'preflight-failure-outer'
    ])
    expect(failure.port.cancellations).toEqual([expect.objectContaining({
      reason: 'protocol_error'
    })])
    failure.loop.runTurn()
    await failurePending.then(
      () => {
        throw new Error('expected inner protocol failure')
      },
      error => {
        expect(error).toMatchObject({ code: 'protocol_error' })
        expect(String(error.message)).not.toContain(rawDetail)
        expect(JSON.stringify(error)).not.toContain(rawDetail)
      }
    )
    expect(failure.bridge.getSnapshot()).toEqual({
      inFlightBinaryBytes: 0,
      inFlightBinaryHandles: 0,
      openHandles: 0,
      openResources: 0,
      outstandingCredits: 0,
      pendingRequests: 0
    })
  })

  it('cleans a preflight grant with its old token when the id is reused', async () => {
    const reused = setupNativeBridge()
    const reusedId = 'preflight-generation-reuse'
    const rawDetail = 'old generation provider detail must remain private'
    let reuseDescriptorReads = 0
    let newGeneration: Promise<unknown> | undefined
    const reuseTarget = {
      id: reusedId,
      resources: [{
        providerToken: providerToken('preflight-reuse-outer'),
        type: 'fs.file'
      }],
      type: 'result',
      value: () => rawDetail
    }
    const reuseOuter = new Proxy(reuseTarget, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'value') {
          reuseDescriptorReads += 1
          expect(reused.bridge.cancel(reusedId, 'old-generation')).toBe(true)
          newGeneration = reused.bridge.request(request(reusedId))
          reused.port.emit(reusedId, {
            id: reusedId,
            type: 'result',
            value: 'new-generation-wins'
          })
        }
        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })
    const oldGeneration = reused.bridge.request(request(reusedId))
    void oldGeneration.catch(() => undefined)
    const oldCallToken = String(reused.port.latest(reusedId).context.callToken)
    reused.port.emit(reusedId, reuseOuter as unknown as NativePortEvent)
    expect(reuseDescriptorReads).toBe(1)
    expect(newGeneration).toBeDefined()
    expect(reused.port.cancellations).toEqual([expect.objectContaining({
      callToken: oldCallToken,
      reason: 'old-generation'
    })])
    expect(reused.port.closedResources).toEqual([expect.objectContaining({
      ownerCallToken: oldCallToken,
      providerToken: 'preflight-reuse-outer',
      reason: 'undelivered'
    })])
    reused.loop.runTurn()
    await oldGeneration.then(
      () => {
        throw new Error('expected old generation cancellation')
      },
      error => {
        expect(error).toMatchObject({ code: 'cancelled' })
        expect(String(error.message)).not.toContain(rawDetail)
        expect(JSON.stringify(error)).not.toContain(rawDetail)
      }
    )
    await expect(newGeneration).resolves.toEqual({ value: 'new-generation-wins' })
    expect(reused.bridge.getSnapshot()).toEqual({
      inFlightBinaryBytes: 0,
      inFlightBinaryHandles: 0,
      openHandles: 0,
      openResources: 0,
      outstandingCredits: 0,
      pendingRequests: 0
    })
  })

  it('rejects malformed getter/proxy error resources without unsafe enumeration', async () => {
    const getterCase = setupNativeBridge()
    let getterRan = false
    const getterEvent = Object.defineProperty(
      {
        error: { code: 'operation_unsupported' },
        id: 'error-resource-getter',
        type: 'error'
      },
      'resources',
      {
        enumerable: true,
        get() {
          getterRan = true
          throw new Error('getter must not run')
        }
      }
    )
    const getterPending = getterCase.bridge.request(request('error-resource-getter'))
    getterCase.port.emit('error-resource-getter', getterEvent as NativePortEvent)
    expect(getterRan).toBe(false)
    getterCase.loop.runTurn()
    await expect(getterPending).rejects.toMatchObject({ code: 'protocol_error' })

    const proxyCase = setupNativeBridge({ maxOpenResources: 1 })
    const proxyTarget: unknown[] = []
    proxyTarget.length = 1_000_000
    let proxyOwnKeysRan = false
    const excessiveResources = new Proxy(proxyTarget, {
      ownKeys() {
        proxyOwnKeysRan = true
        throw new Error('must not enumerate oversized resources')
      }
    })
    const proxyPending = proxyCase.bridge.request(request('error-resource-proxy'))
    proxyCase.port.emit('error-resource-proxy', {
      error: { code: 'operation_unsupported' },
      id: 'error-resource-proxy',
      resources: excessiveResources,
      type: 'error'
    } as unknown as NativePortEvent)
    expect(proxyOwnKeysRan).toBe(false)
    proxyCase.loop.runTurn()
    await expect(proxyPending).rejects.toMatchObject({ code: 'limit_exceeded' })
  })

  it('releases stream readers and pending state after malformed error grant cleanup', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const stream = bridge.stream(request('error-stream-cleanup'))
    const read = stream.next()
    port.emit('error-stream-cleanup', {
      error: { code: 'operation_unsupported' },
      id: 'error-stream-cleanup',
      resources: [{
        providerToken: providerToken('error-stream-token'),
        type: 'fs.file'
      }],
      type: 'error'
    } as unknown as NativePortEvent)
    loop.runTurn()
    await expect(read).rejects.toMatchObject({ code: 'protocol_error' })
    expect(port.closedResources).toHaveLength(1)
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

  it('caps resource and binary lists before enumerating provider arrays', async () => {
    const resourceCase = setupNativeBridge({ maxOpenResources: 1 })
    let resourceOwnKeysRan = false
    const excessiveResourceTarget: unknown[] = []
    excessiveResourceTarget.length = 1_000_000
    const excessiveResources = new Proxy(excessiveResourceTarget, {
      ownKeys() {
        resourceOwnKeysRan = true
        throw new Error('must not enumerate oversized resources')
      }
    })
    const resourcePending = resourceCase.bridge.request(request('resource-cap'))
    resourceCase.port.emit('resource-cap', {
      id: 'resource-cap',
      resources: excessiveResources,
      type: 'result'
    } as unknown as NativePortEvent)
    resourceCase.loop.runTurn()
    await expect(resourcePending).rejects.toMatchObject({ code: 'limit_exceeded' })
    expect(resourceOwnKeysRan).toBe(false)

    const binaryCase = setupNativeBridge({ maxBinaryHandles: 1 })
    let binaryOwnKeysRan = false
    const excessiveBinaryTarget: unknown[] = []
    excessiveBinaryTarget.length = 1_000_000
    const excessiveBinary = new Proxy(excessiveBinaryTarget, {
      ownKeys() {
        binaryOwnKeysRan = true
        throw new Error('must not enumerate oversized binary')
      }
    })
    const binaryPending = binaryCase.bridge.request(request('binary-cap'))
    binaryCase.port.emit('binary-cap', {
      binary: excessiveBinary,
      id: 'binary-cap',
      type: 'result'
    } as unknown as NativePortEvent)
    binaryCase.loop.runTurn()
    await expect(binaryPending).rejects.toMatchObject({ code: 'limit_exceeded' })
    expect(binaryOwnKeysRan).toBe(false)
  })

  it('releases reserved resources if disposal wins before loop delivery', async () => {
    const { bridge, port } = setupNativeBridge()
    const pending = bridge.request(request('reserved-resource'))
    port.emit('reserved-resource', {
      id: 'reserved-resource',
      resources: [{
        providerToken: providerToken('reserved-token'),
        type: 'fs.file'
      }],
      type: 'result'
    })
    expect(bridge.getSnapshot()).toMatchObject({
      openHandles: 1,
      openResources: 1,
      pendingRequests: 1
    })
    bridge.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'disposed' })
    expect(port.closedResources).toContainEqual(expect.objectContaining({
      providerToken: 'reserved-token',
      reason: 'undelivered'
    }))
    expect(bridge.getSnapshot()).toMatchObject({
      openHandles: 0,
      openResources: 0,
      pendingRequests: 0
    })
  })

  it('ignores late provider events without inspecting them after resource completion', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const completed = bridge.request(request('late-resource-event'))
    port.emit('late-resource-event', {
      id: 'late-resource-event',
      resources: [{
        providerToken: providerToken('resource-token'),
        type: 'fs.file'
      }],
      type: 'result'
    })
    loop.runTurn()
    const handle: NativeResourceHandle = (await completed).resources![0]
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error('late terminal must remain opaque')
      }
    })
    expect(() =>
      port.latest('late-resource-event').sink(
        hostile as NativePortEvent
      )
    ).not.toThrow()
    handle.close()
  })

  it('closes every verified malformed-event grant prefix without reading accessors', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    let accessorRead = false
    const resources = [{
      providerToken: providerToken('prefix-grant'),
      type: 'fs.file'
    }]
    Object.defineProperty(resources, '1', {
      enumerable: true,
      get() {
        accessorRead = true
        throw new Error('provider accessor must not run')
      }
    })
    resources.length = 2
    const pending = bridge.request(request('verified-prefix'))
    port.emit('verified-prefix', {
      error: { code: 'operation_unsupported' },
      id: 'verified-prefix',
      resources,
      type: 'error'
    } as unknown as NativePortEvent)
    expect(accessorRead).toBe(false)
    expect(port.closedResources).toEqual([expect.objectContaining({
      providerToken: 'prefix-grant',
      reason: 'undelivered'
    })])
    expect(port.cancellations).toHaveLength(1)
    loop.runTurn()
    await expect(pending).rejects.toMatchObject({ code: 'protocol_error' })
  })

  it('does not enumerate a bounded resource proxy with hostile ownKeys', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    let ownKeysCalls = 0
    const resources = new Proxy([{
      providerToken: providerToken('length-one-hostile'),
      type: 'fs.file'
    }], {
      ownKeys() {
        ownKeysCalls += 1
        return Array.from({ length: 100_000 }, (_, index) => String(index))
      }
    })
    const pending = bridge.request(request('length-one-hostile-keys'))
    port.emit('length-one-hostile-keys', {
      error: { code: 'operation_unsupported' },
      id: 'length-one-hostile-keys',
      resources,
      type: 'error'
    } as unknown as NativePortEvent)
    expect(ownKeysCalls).toBe(0)
    expect(port.closedResources).toHaveLength(1)
    loop.runTurn()
    await expect(pending).rejects.toMatchObject({ code: 'protocol_error' })
    expect(bridge.getSnapshot()).toMatchObject({
      openHandles: 0,
      openResources: 0,
      pendingRequests: 0
    })
  })

  it('cleans malformed error/result/chunk/end grants at zero, one and two entries', async () => {
    const cases = [
      { type: 'error' as const, mode: 'request' as const },
      { type: 'result' as const, mode: 'request' as const },
      { type: 'chunk' as const, mode: 'stream' as const },
      { type: 'end' as const, mode: 'stream' as const }
    ]
    for (const { mode, type } of cases) {
      for (const count of [0, 1, 2]) {
        const { bridge, loop, port } = setupNativeBridge()
        const id = `malformed-${type}-${count}`
        const resources = Array.from({ length: count }, (_, index) => ({
          providerToken: providerToken(`${id}-${index}`),
          type: 'fs.file'
        }))
        const pending = mode === 'request'
          ? bridge.request(request(id))
          : bridge.stream(request(id)).next()
        const event: Record<string, unknown> = {
          id,
          resources,
          type
        }
        if (type === 'error') event.error = { code: 'operation_unsupported' }
        else if (type === 'chunk') event.sequence = 0
        event.value = () => undefined
        port.emit(id, event as NativePortEvent)
        expect(port.closedResources).toHaveLength(count)
        expect(new Set(port.closedResources.map(item => item.providerToken)).size).toBe(count)
        expect(port.cancellations).toHaveLength(1)
        loop.runTurn()
        await expect(pending).rejects.toMatchObject({ code: 'protocol_error' })
        expect(bridge.getSnapshot()).toMatchObject({
          openHandles: 0,
          openResources: 0,
          pendingRequests: 0
        })
      }
    }
  })

  it('invalidates same-stream collisions but leaves a queued terminal unchanged', async () => {
    const open = setupNativeBridge()
    const stream = open.bridge.stream(request('same-stream-open'))
    const firstRead = stream.next()
    open.port.emit('same-stream-open', {
      id: 'same-stream-open',
      resources: [{ providerToken: providerToken('same-open'), type: 'fs.file' }],
      sequence: 0,
      type: 'chunk'
    })
    open.loop.runTurn()
    const firstChunk = await firstRead
    if (firstChunk.done) throw new Error('expected stream chunk')
    const exposed = firstChunk.value.resources![0]
    const collisionRead = stream.next()
    open.port.emit('same-stream-open', {
      id: 'same-stream-open',
      resources: [{ providerToken: providerToken('same-open'), type: 'fs.file' }],
      sequence: 1,
      type: 'chunk'
    })
    expect(exposed.close()).toBe(false)
    expect(open.port.closedResources).toHaveLength(1)
    open.loop.runTurn()
    await expect(collisionRead).rejects.toMatchObject({ code: 'protocol_error' })

    const reserved = setupNativeBridge()
    const queued = reserved.bridge.request(request('same-call-reserved'))
    reserved.port.emit('same-call-reserved', {
      id: 'same-call-reserved',
      resources: [{ providerToken: providerToken('same-reserved'), type: 'fs.file' }],
      type: 'result'
    })
    reserved.port.emit('same-call-reserved', {
      error: { code: 'operation_unsupported' },
      id: 'same-call-reserved',
      resources: [{ providerToken: providerToken('same-reserved'), type: 'fs.file' }],
      type: 'error'
    } as unknown as NativePortEvent)
    expect(reserved.port.closedResources).toHaveLength(0)
    expect(reserved.port.cancellations).toHaveLength(0)
    reserved.loop.runTurn()
    const handle = (await queued).resources![0]
    expect(handle.close()).toBe(true)
    expect(reserved.port.closedResources).toHaveLength(1)
    expect(reserved.bridge.getSnapshot()).toMatchObject({
      openHandles: 0,
      openResources: 0,
      pendingRequests: 0
    })
  })

  it('iteratively cleans resource grants emitted during close reentry exactly once', async () => {
    const { bridge, loop, port } = setupNativeBridge()
    const pending = bridge.request(request('recursive-resource-cleanup'))
    let emitted = false
    port.closeResourceHook = () => {
      if (emitted) return
      emitted = true
      port.emit('recursive-resource-cleanup', {
        error: { code: 'operation_unsupported' },
        id: 'recursive-resource-cleanup',
        resources: [{
          providerToken: providerToken('recursive-second'),
          type: 'fs.file'
        }],
        type: 'error'
      } as unknown as NativePortEvent)
    }
    port.emit('recursive-resource-cleanup', {
      error: { code: 'operation_unsupported' },
      id: 'recursive-resource-cleanup',
      resources: [{
        providerToken: providerToken('recursive-first'),
        type: 'fs.file'
      }],
      type: 'error'
    } as unknown as NativePortEvent)
    expect(port.closedResources.map(item => item.providerToken)).toEqual([
      'recursive-first',
      'recursive-second'
    ])
    expect(port.cancellations).toHaveLength(1)
    loop.runTurn()
    await expect(pending).rejects.toMatchObject({ code: 'protocol_error' })
    expect(bridge.getSnapshot()).toEqual({
      inFlightBinaryBytes: 0,
      inFlightBinaryHandles: 0,
      openHandles: 0,
      openResources: 0,
      outstandingCredits: 0,
      pendingRequests: 0
    })
  })
})
