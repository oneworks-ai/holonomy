import { describe, expect, it } from 'vitest'

import type { WebNetworkCapabilityHooksV1 } from '../../../packages/capabilities/network/src/web/types.js'
import { createInlineBody } from '../../../packages/capabilities/network/src/web/web-body.js'
import { createTrustedNetworkResponse } from '../../../packages/capabilities/network/src/web/web-response.js'
import {
  RuntimeEventLoop,
  ScriptedNetworkProvider,
  createFetchRuntime,
  createNativeBridge
} from '../../../src/index.js'

describe('response clone admission cleanup', () => {
  it('releases the network slot when response metadata authorization is denied', async () => {
    const authority = {
      allowedOrigins: ['https://api.example'],
      limits: { maxChunkBytes: 1024, maxConcurrentConnections: 1, maxResponseBodyBytes: 1024 }
    }
    const loop = new RuntimeEventLoop({
      checkpointMicrotasks() {},
      now: () => 0,
      requestWakeup() {},
      terminate() {}
    })
    const provider = new ScriptedNetworkProvider({
      authority,
      http: Array.from({ length: 2 }, () => ({
        resolvedAddress: '93.184.216.34',
        response: { body: ['ok'] },
        url: 'https://api.example/data'
      }))
    })
    const bridge = createNativeBridge(provider, {
      authority: { capabilities: ['host.network.http'], principal: 'test' },
      eventLoop: loop
    })
    let denied = true
    let next = 0
    const failure = new Error('metadata denied')
    const runtime = createFetchRuntime({
      authority,
      bridge,
      capability: {
        authorizeRedirect: async () => {},
        authorizeRequest: async () => ({ bindingId: String(++next), generation: 1, resourceType: 'network.response' }),
        authorizeResponse: async (_response, member) => {
          if (denied && member === 'Response.metadata') throw failure
        },
        cloneResponse: admission => admission,
        releaseResponse() {}
      }
    })
    const flush = async () => {
      for (let index = 0; index < 100; index++) {
        while (loop.runTurn().status === 'ran') {
          // Drain queued native completions before the next microtask checkpoint.
        }
        await Promise.resolve()
      }
    }
    try {
      const first = expect(runtime.fetch('https://api.example/data')).rejects.toBe(failure)
      await flush()
      await first
      denied = false
      const pending = runtime.fetch('https://api.example/data')
      await flush()
      const response = await pending
      const body = response.text()
      await flush()
      await expect(body).resolves.toBe('ok')
    } finally {
      runtime.dispose()
    }
  })

  it.each(['consumed', 'locked', 'headers'] as const)(
    'releases the new admission once when %s cloning fails',
    async mode => {
      const released: string[] = []
      const admission = { bindingId: 'response-1', generation: 1, resourceType: 'network.response' as const }
      const hooks: WebNetworkCapabilityHooksV1 = {
        authorizeRedirect: async () => {},
        authorizeRequest: async () => admission,
        authorizeResponse: () => {},
        cloneResponse: () => ({ ...admission, bindingId: 'response-clone' }),
        releaseResponse: value => {
          released.push(value.bindingId)
        }
      }
      const metadata = {
        headers: [] as const,
        hop: 0,
        logicalRequestId: 'request-1',
        redirected: false,
        source: 'real' as const,
        status: 200,
        statusText: '',
        url: 'https://example.test/'
      }
      const response = createTrustedNetworkResponse({
        body: createInlineBody(new Uint8Array([1, 2])),
        maxBodyBytes: 2,
        redirected: false,
        status: 200,
        url: metadata.url,
        capability: { admission, hooks, metadata }
      })
      const reader = mode === 'locked' ? response.body!.getReader() : undefined
      if (mode === 'consumed') await response.bytes()
      if (mode === 'headers') {
        Object.defineProperty(response.headers, Symbol.iterator, {
          value() {
            throw new Error('header clone failed')
          }
        })
      }
      try {
        expect(() => response.clone()).toThrow()
        expect(released).toEqual(['response-clone'])
      } finally {
        await reader?.cancel()
      }
    }
  )
})
