import { describe, expect, it } from 'vitest'

import { createCapabilityNetworkHooksV1 } from '../../../packages/capabilities/network/src/kernel/guest-fetch.js'
import { buildNetworkInvocationSnapshotV1 } from '../../../packages/capabilities/network/src/kernel/network-invocation-builder.js'
import { bindInvocationAbortSignalV1 } from '../../../packages/runtime/src/kernel/invocation-abort.js'
import { CapabilityRuntimeInvocationKernelV1 } from '../../../src/capability-runtime/index.js'
import type { HoloInvocationContextV1 } from '../../../src/capability-runtime/index.js'
import { creation, policyV2, provider, snapshot } from './broker-fixtures.js'

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

  it('passes Fetch authorization cancellation out of band without mutating its closed snapshot', async () => {
    const calls: Array<
      { request: Record<string, unknown>; signal?: { add(listener: () => void): void; readAborted(): boolean } }
    > = []
    const hooks = createCapabilityNetworkHooksV1({
      async invoke(requestJson, signal) {
        calls.push({ request: JSON.parse(requestJson), signal })
        return JSON.stringify({
          ok: true,
          value: { binding: { bindingId: 'network-response', generation: 1 }, resourceType: 'network.response' }
        })
      },
      invokeSync: () => {
        throw new Error('unexpected sync invocation')
      }
    })
    const controller = new AbortController()
    await hooks.authorizeRequest({
      headers: [],
      hop: 0,
      logicalRequestId: 'network-request',
      method: 'GET',
      url: 'https://api.example/request'
    }, controller.signal)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.request.arguments).not.toHaveProperty('options')
    expect(calls[0]?.signal?.readAborted()).toBe(false)
    let aborted = false
    calls[0]?.signal?.add(() => {
      aborted = true
    })
    controller.abort()
    expect(aborted).toBe(true)
    expect(calls[0]?.signal?.readAborted()).toBe(true)
  })

  it('aborts a real Network preflight before provider invocation without extending its snapshot', async () => {
    const policy: ReturnType<typeof policyV2> = {
      ...policyV2(),
      network: {
        access: 'restricted',
        allowedOrigins: ['https://api.example'],
        allowedSchemes: ['https'],
        allowPrivateNetwork: false,
        limits: {
          maxChunkBytes: 1024,
          maxConcurrentConnections: 1,
          maxHeaderBytes: 4096,
          maxHeaders: 8,
          maxRedirects: 1,
          maxRequestBodyBytes: 4096,
          maxResponseBodyBytes: 4096,
          maxUrlBytes: 4096,
          socketTimeoutMs: 1000
        },
        requestBodyInspection: { access: 'none' }
      }
    }
    let observed: HoloInvocationContextV1 | undefined
    let start!: () => void
    const preflightStarted = new Promise<void>(resolve => {
      start = resolve
    })
    let invokeCalls = 0
    const network = {
      execution: 'async' as const,
      invoke: () => {
        invokeCalls += 1
        throw new Error('aborted preflight must not invoke the provider')
      },
      module: 'host.network',
      preflight: (context: HoloInvocationContextV1) => {
        observed = context
        start()
        return new Promise<undefined>(() => {})
      }
    }
    const kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted: creation({ 'host.network': network }, undefined, policy),
      engine: 'node-vm',
      networkProvider: 'host.network',
      requestPrefix: 'abort-test',
      target: 'node'
    })
    const snapshot = buildNetworkInvocationSnapshotV1({
      headers: [],
      hop: 0,
      label: 'HTTP request',
      logicalRequestId: 'network-preflight',
      method: 'GET',
      url: 'https://api.example/preflight'
    })
    const controller = new AbortController()
    const terminal = kernel.invoke(
      JSON.stringify({
        arguments: snapshot,
        member: 'fetch',
        mode: 'promise',
        module: 'web:fetch'
      }),
      controller.signal
    )
    await preflightStarted
    expect(observed?.arguments).toEqual(snapshot)
    controller.abort()
    await expect(terminal).resolves.toBe(JSON.stringify({
      error: {
        code: 'holo.operation_cancelled',
        message: 'holo.operation_cancelled: Holonomy network.fetch.request failed',
        name: 'HoloError',
        retryable: false
      },
      ok: false
    }))
    expect(invokeCalls).toBe(0)
  })
})
