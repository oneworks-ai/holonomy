import { describe, expect, it } from 'vitest'

import { DEFAULT_ABORT_CONSTRUCTORS } from '../../../packages/capabilities/network/src/web/web-abort.js'
import type { NativePort, NativePortEventSink } from '../../../src/index.js'
import {
  RuntimeEventLoop,
  ScriptedNetworkProvider,
  WebBodyController,
  createFetchRuntime,
  createNativeBridge
} from '../../../src/index.js'

const authority = { allowedOrigins: ['https://api.example'] } as const
const url = 'https://api.example/body'
const setup = (holdBody = false, terminal?: { mode: 'provider-error' | 'eof' | 'invalid-end'; reason: unknown }) => {
  const lateBodyEvents: Array<() => void> = []
  const lateBodySinks: Array<{ id: string; sink: NativePortEventSink }> = []
  const events: unknown[] = []
  const loop = new RuntimeEventLoop({
    checkpointMicrotasks() {},
    now: () => 0,
    requestWakeup() {},
    terminate() {}
  })
  const provider = new ScriptedNetworkProvider({
    authority,
    http: [{ resolvedAddress: '93.184.216.34', response: { body: ['first', 'second'] }, url }]
  })
  const port: NativePort = {
    cancel: token => provider.cancel(token),
    closeResource: (owner, token) => provider.closeResource(owner, token),
    dispatch(request, context, sink, resourceSink) {
      if (holdBody && request.operation === 'v1.http.read-body') {
        lateBodySinks.push({ id: request.id, sink })
        provider.dispatch(request, context, event => lateBodyEvents.push(() => sink(event)), resourceSink)
      } else {
        provider.dispatch(request, context, event => {
          if (request.operation === 'v1.http.read-body') {
            if (terminal?.mode === 'provider-error' && event.type === 'chunk') {
              sink({ ...event, value: { ok: true, value: { kind: 'INVALID' } } })
              return
            }
            if (terminal?.mode === 'invalid-end' && event.type === 'end') {
              sink({ ...event, value: { ok: false, error: 'network.protocol_error' } })
              return
            }
          }
          sink(event)
        }, resourceSink)
      }
    },
    dispose: () => provider.dispose(),
    grantCredits: (token, credits) => provider.grantCredits(token, credits)
  }
  const bridge = createNativeBridge(port, {
    authority: { capabilities: ['host.network.http'], principal: 'abort-body' },
    eventLoop: loop
  })
  const runtime = createFetchRuntime({
    authority,
    bridge,
    constructors: DEFAULT_ABORT_CONSTRUCTORS,
    diagnostics: {
      emit(event) {
        events.push(event)
        if (terminal != null && event.type === (terminal.mode === 'eof' ? 'loadingFinished' : 'loadingFailed')) {
          controller.abort(terminal.reason)
        }
      }
    }
  })
  const flush = async () => {
    for (let index = 0; index < 50; index += 1) {
      while (loop.runTurn().status === 'ran') { /* bounded scripted completions */ }
      await Promise.resolve()
    }
  }
  const controller = new runtime.AbortController()
  const response = async () => {
    const pending = runtime.fetch(url, { signal: controller.signal })
    await flush()
    return pending
  }
  const cleanup = async () => {
    runtime.dispose()
    await flush()
    expect(provider.activeConnectionCount).toBe(0)
    expect(bridge.getSnapshot()).toMatchObject({ openResources: 0, pendingRequests: 0, outstandingCredits: 0 })
    bridge.dispose()
  }
  return { bridge, cleanup, controller, events, flush, lateBodyEvents, lateBodySinks, provider, response, runtime }
}

// Store the rejection in a record: null/false/0 are valid abort reasons.
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    value => ({ rejected: false, value }),
    reason => ({ rejected: true, reason })
  )
const expectReason = async (promise: Promise<unknown>, reason: unknown) => {
  const result = await outcome(promise)
  expect(result.rejected).toBe(true)
  expect('reason' in result && result.reason).toBe(reason)
}

describe('response body signal abort reason', () => {
  it.each([null, false, 0, 'stop', { local: true }])(
    'preserves %j before consumption and across clones',
    async reason => {
      const test = setup()
      try {
        const response = await test.response()
        const clone = response.clone()
        test.controller.abort(reason)
        expect(response.bodyUsed).toBe(false)
        const lateClone = response.clone()
        await expectReason(response.text(), reason)
        await expectReason(clone.text(), reason)
        await expectReason(lateClone.text(), reason)
        await test.flush()
        expect(test.provider.closedResourceCount).toBe(1)
      } finally {
        await test.cleanup()
      }
    }
  )

  it('uses the Runtime default AbortError identity for pending and subsequent reads', async () => {
    const test = setup()
    try {
      const response = await test.response()
      const reader = response.body!.getReader()
      const read = outcome(reader.read())
      test.controller.abort()
      const reason: unknown = test.controller.signal.reason
      expect(reason).toMatchObject({ name: 'AbortError' })
      await test.flush()
      expect(await read).toEqual({ rejected: true, reason })
      await expectReason(reader.read(), reason)
    } finally {
      await test.cleanup()
    }
  })

  it('retains a Guest reason without reading its properties or exposing it in diagnostics', async () => {
    const test = setup()
    let getters = 0
    const reason = Object.defineProperty({}, 'code', {
      get() {
        getters += 1
        throw new Error('Guest getter')
      }
    })
    try {
      const response = await test.response()
      const clone = response.clone()
      const pending = outcome(response.body!.getReader().read())
      test.controller.abort(reason)
      response.dispose()
      test.runtime.dispose()
      await test.flush()
      expect(await pending).toEqual({ rejected: true, reason })
      await expectReason(clone.text(), reason)
      expect(getters).toBe(0)
      expect(test.events).toContainEqual(expect.objectContaining({ code: 'network.cancelled', type: 'loadingFailed' }))
      expect(JSON.stringify(test.events)).not.toContain('Guest getter')
    } finally {
      await test.cleanup()
    }
  })

  it.each(['reader', 'response', 'runtime'] as const)(
    'retains network.cancelled when %s cancellation wins first',
    async mode => {
      const test = setup()
      try {
        const response = await test.response()
        const reader = response.body!.getReader()
        const pending = outcome(reader.read())
        if (mode === 'reader') await reader.cancel('explicit')
        if (mode === 'response') response.dispose()
        if (mode === 'runtime') test.runtime.dispose()
        test.controller.abort({ tooLate: true })
        await test.flush()
        expect(await pending).toMatchObject({ rejected: true, reason: { code: 'network.cancelled' } })
      } finally {
        await test.cleanup()
      }
    }
  )

  it('keeps the first reason after late provider chunks and provider failure', async () => {
    const test = setup(true)
    const reason = { local: 'late-provider' }
    try {
      const response = await test.response()
      const clone = response.clone()
      const reader = response.body!.getReader()
      const pending = outcome(reader.read())
      const clonePending = outcome(clone.body!.getReader().read())
      await test.flush()
      expect(test.lateBodyEvents.length).toBeGreaterThan(0)
      test.controller.abort(reason)
      for (const deliver of test.lateBodyEvents) deliver()
      for (const { id, sink } of test.lateBodySinks) sink({ error: { code: 'internal' }, id, type: 'error' })
      await test.flush()
      expect(await pending).toEqual({ rejected: true, reason })
      await expectReason(reader.read(), reason)
      expect(await clonePending).toEqual({ rejected: true, reason })
      expect(test.provider.closedResourceCount).toBe(1)
    } finally {
      await test.cleanup()
    }
  })

  it('checks an abort selected between source resolution and the body continuation', async () => {
    const reason = { local: 'microtask' }
    let failure: { reason: unknown } | undefined
    const controller = new WebBodyController({
      cancel() {},
      getAbortFailure: () => failure,
      async pull() {
        queueMicrotask(() => {
          failure = { reason }
          controller.cancel('late_dispose')
        })
        return new Uint8Array([1])
      }
    })
    const reader = controller.stream.getReader()
    await expectReason(reader.read(), reason)
    await expectReason(reader.read(), reason)
  })

  it('drops buffered clone chunks when abort follows a partial read', async () => {
    const test = setup()
    const reason = { local: 'partial' }
    try {
      const response = await test.response()
      const clone = response.clone()
      const reader = response.body!.getReader()
      const first = reader.read()
      await test.flush()
      expect((await first).done).toBe(false)
      test.controller.abort(reason)
      await expectReason(reader.read(), reason)
      await expectReason(clone.text(), reason)
    } finally {
      await test.cleanup()
    }
  })

  it('keeps a cancelled clone separate from a later signal error in its sibling', async () => {
    const test = setup()
    const reason = { local: 'sibling' }
    try {
      const response = await test.response()
      const clone = response.clone()
      const cancelled = clone.body!.getReader()
      const pending = outcome(cancelled.read())
      await cancelled.cancel('explicit')
      test.controller.abort(reason)
      await test.flush()
      expect(await pending).toMatchObject({ rejected: true, reason: { code: 'network.cancelled' } })
      await expect(cancelled.read()).resolves.toEqual({ done: true, value: undefined })
      await expectReason(response.text(), reason)
    } finally {
      await test.cleanup()
    }
  })

  it.each(['already-aborted', 'before-headers'] as const)(
    'retains the existing %s fetch cancellation boundary',
    async mode => {
      const test = setup()
      try {
        if (mode === 'already-aborted') test.controller.abort({ before: true })
        const pending = outcome(test.runtime.fetch(url, { signal: test.controller.signal }))
        if (mode === 'before-headers') test.controller.abort({ before: true })
        await test.flush()
        expect(await pending).toMatchObject({ rejected: true, reason: { code: 'network.cancelled' } })
      } finally {
        await test.cleanup()
      }
    }
  )

  it.each(['provider-error', 'eof', 'invalid-end'] as const)(
    'keeps selected %s when diagnostics synchronously aborts the signal',
    async mode => {
      const reason = { lateSignal: mode }
      const test = setup(false, { mode, reason })
      try {
        const response = await test.response()
        const clone = response.clone()
        const body = outcome(response.text())
        const clonedBody = outcome(clone.text())
        await test.flush()
        expect(test.controller.signal.reason).toBe(reason)
        if (mode === 'eof') {
          expect(await body).toEqual({ rejected: false, value: 'firstsecond' })
          expect(await clonedBody).toEqual({ rejected: false, value: 'firstsecond' })
        } else {
          expect(await body).toMatchObject({ rejected: true, reason: { code: 'network.protocol_error' } })
          expect(await clonedBody).toMatchObject({ rejected: true, reason: { code: 'network.protocol_error' } })
          expect(test.events).toContainEqual(expect.objectContaining({
            cancelled: false,
            code: 'network.protocol_error',
            type: 'loadingFailed'
          }))
        }
        expect(test.provider.closedResourceCount).toBe(1)
      } finally {
        await test.cleanup()
      }
    }
  )

  it('does not change an exhausted response when abort follows the terminal read', async () => {
    const test = setup()
    try {
      const response = await test.response()
      const reader = response.body!.getReader()
      const consume = (async () => {
        while (!(await reader.read()).done) { /* consume the response */ }
      })()
      await test.flush()
      await consume
      test.controller.abort({ tooLate: true })
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    } finally {
      await test.cleanup()
    }
  })
})
