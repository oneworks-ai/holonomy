import { describe, expect, it } from 'vitest'

import { buildNetworkInvocationSnapshotV1 } from '../../../../packages/capabilities/network/src/kernel/network-invocation-builder.ts'

import { createNativeNetworkProvider } from '../bootstrap/network-provider.mjs'

const policy = {
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
  }
}

describe('desktop native network invocation verification', () => {
  it('rejects a tampered uploaded body before the native request transport is selected', () => {
    const network = createNativeNetworkProvider({ networkSync: () => JSON.stringify({ ok: true, value: {} }) }, policy)
    const snapshot = buildNetworkInvocationSnapshotV1({
      body: new Uint8Array([1, 2, 3]),
      headers: [['x-request', 'original']],
      hop: 0,
      label: 'HTTP request',
      logicalRequestId: 'request-1',
      method: 'POST',
      url: 'https://api.example/upload'
    })
    const context = {
      arguments: snapshot,
      operation: 'network.fetch.request',
      requestId: 'request-1',
      resource: { requested: { kind: 'network', origin: 'https://api.example' } },
      runtime: { generation: 1 }
    }
    const authority = {
      bindings: [{
        constraints: { origins: ['https://api.example'], schemes: ['https'] },
        providerModule: 'host.network'
      }],
      complete: () => ({})
    }
    network.provider.invoke(context, authority)

    let failure: unknown
    try {
      network.verify({
        body: new Uint8Array([1, 2, 4]),
        bodyLength: 3,
        headers: [['x-request', 'original']],
        method: 'POST',
        url: 'https://api.example/upload'
      }, 'network-request-1-1')
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'capability.denied' })
  })

  it('closes a streamed response head that arrives after request cancellation', async () => {
    const commands: unknown[] = []
    const native = {
      networkCancel: () => undefined,
      networkStart: () => ({
        id: 1,
        promise: Promise.resolve(JSON.stringify({
          hasBody: true,
          headers: [],
          status: 200,
          statusText: 'OK',
          streamId: 'body-late',
          url: 'https://api.example/late'
        }))
      }),
      networkSync: (input: string) => {
        commands.push(JSON.parse(input))
        return JSON.stringify({ ok: true, value: {} })
      }
    }
    const network = createNativeNetworkProvider(native, policy)
    const controller = new AbortController()
    const pending = network.request({
      body: new Uint8Array(),
      capabilityBindingId: 'binding',
      headers: [],
      method: 'GET',
      signal: controller.signal,
      url: 'https://api.example/late'
    })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    expect(commands).toContainEqual({ kind: 'closeStream', streamId: 'body-late' })
  })

  it('closes once after synchronous pull admission refusal without masking the quota error', async () => {
    let closes = 0
    let connectionSlotHeld = true
    let starts = 0
    const network = createNativeNetworkProvider({
      networkCancel: () => undefined,
      networkStart: () => {
        starts += 1
        if (starts === 1) {
          return {
            id: 1,
            promise: Promise.resolve(JSON.stringify({
              hasBody: true,
              headers: [],
              status: 200,
              statusText: 'OK',
              streamId: 'body-quota',
              url: 'https://api.example/quota'
            }))
          }
        }
        throw Object.assign(new Error('handle quota'), { code: 'resource.handle_limit' })
      },
      networkSync: (input: string) => {
        const command = JSON.parse(input)
        expect(command).toEqual({ kind: 'closeStream', streamId: 'body-quota' })
        closes += 1
        connectionSlotHeld = false
        throw Object.assign(new Error('cleanup timeout'), { code: 'provider.timeout' })
      }
    }, policy)
    const response = await network.request({
      body: new Uint8Array(),
      capabilityBindingId: 'binding',
      headers: [],
      method: 'GET',
      url: 'https://api.example/quota'
    })
    const body = response.body

    await expect(body.next()).rejects.toMatchObject({ code: 'unavailable' })
    expect({ closes, connectionSlotHeld, starts }).toEqual({ closes: 1, connectionSlotHeld: false, starts: 2 })
    await expect(body.next()).resolves.toEqual({ done: true, value: undefined })
    await expect(body.return()).resolves.toEqual({ done: true, value: undefined })
    await expect(body.return()).resolves.toEqual({ done: true, value: undefined })
    expect({ closes, connectionSlotHeld, starts }).toEqual({ closes: 1, connectionSlotHeld: false, starts: 2 })
  })
})
