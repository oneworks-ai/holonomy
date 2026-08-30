import { describe, expect, it } from 'vitest'

import { bindInvocationAbortSignalV1 } from '../../../packages/runtime/src/kernel/invocation-abort.js'
import { CapabilityRuntimeInvocationKernelV1 } from '../../../src/capability-runtime/index.js'
import type { HoloInvocationContextV1 } from '../../../src/capability-runtime/index.js'
import { creation, provider, snapshot } from './broker-fixtures.js'

const request = (signal?: Readonly<{ bindingId: string; generation: number }>) =>
  JSON.stringify({
    arguments: {
      options: { encoding: 'utf8', ...(signal == null ? {} : { signal }) },
      path: 'holo-fs://workspace/demo.txt'
    },
    member: 'readFile',
    mode: 'promise',
    module: 'node:fs/promises',
    path: 'holo-fs://workspace/demo.txt'
  })

describe('trusted invocation AbortSignal binding', () => {
  it('preserves scalar arguments when no out-of-band signal is present', () => {
    expect(bindInvocationAbortSignalV1('stdin-data', undefined, 1)).toBe('stdin-data')
    expect(() => bindInvocationAbortSignalV1('stdin-data', 'abort-1-1', 1)).toThrow()
  })

  it('injects a generation-bound marker and rejects Guest-forged markers', async () => {
    const observed: HoloInvocationContextV1[] = []
    const fs = provider('host.fs', 'async', null, (context, authority) => {
      observed.push(context)
      return Promise.resolve(authority.complete(snapshot('value', 'result')))
    })
    const kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted: creation({ 'host.fs': fs }),
      engine: 'node-vm',
      networkProvider: 'host.network',
      requestPrefix: 'abort-test',
      target: 'node'
    })
    const controller = new AbortController()

    await expect(kernel.invoke(request(), controller.signal)).resolves.toBe(
      JSON.stringify({ ok: true, value: 'value' })
    )
    expect(observed[0]?.arguments).toMatchObject({
      options: { encoding: 'utf8', signal: { bindingId: 'abort-1-1', generation: 1 } }
    })
    expect(observed[0]?.signal).not.toBe(controller.signal)

    const forged = JSON.parse(await kernel.invoke(request({ bindingId: 'guest-forged', generation: 1 })))
    expect(forged).toMatchObject({ error: { code: 'EINVAL' }, ok: false })
    expect(observed).toHaveLength(1)
  })

  it('rejects a pre-aborted invocation before Provider execution', async () => {
    let providerCalls = 0
    const fs = provider('host.fs', 'async', null, (_context, authority) => {
      providerCalls += 1
      return Promise.resolve(authority.complete(snapshot('unreachable', 'result')))
    })
    const kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted: creation({ 'host.fs': fs }),
      engine: 'node-vm',
      networkProvider: 'host.network',
      requestPrefix: 'abort-test',
      target: 'node'
    })
    const controller = new AbortController()
    controller.abort()

    const terminal = JSON.parse(await kernel.invoke(request(), controller.signal))
    expect(terminal).toMatchObject({ error: { code: 'ABORT_ERR', name: 'AbortError' }, ok: false })
    expect(providerCalls).toBe(0)
  })
})
