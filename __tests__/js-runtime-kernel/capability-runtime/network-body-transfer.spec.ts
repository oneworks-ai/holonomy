import { describe, expect, it } from 'vitest'
import { createCapabilityNetworkHooksV1 } from '../../../packages/capabilities/network/src/kernel/guest-fetch.js'
import type { CapabilityInvocationHostInputV1 } from '../../../packages/runtime/src/kernel/guest-facade-support.js'

describe('private request body transfer selection', () => {
  it.each([undefined, 0, 2, 3])('transfers bytes only within an explicit Host bound %s', async maximum => {
    let input: CapabilityInvocationHostInputV1 | undefined
    let snapshot = ''
    const hooks = createCapabilityNetworkHooksV1({
      invokeSync: () => {
        throw new Error('unexpected sync')
      },
      async invoke(json, _signal, hostInput) {
        snapshot = json
        input = hostInput
        return JSON.stringify({
          ok: true,
          value: { binding: { bindingId: 'response-1', generation: 1 }, resourceType: 'network.response' }
        })
      }
    }, maximum === undefined ? undefined : { requestBodyReaderMaxBytes: maximum })
    await hooks.authorizeRequest({
      body: new Uint8Array([115, 101, 99]),
      headers: [],
      hop: 0,
      logicalRequestId: 'request-1',
      method: 'POST',
      url: 'https://api.example/'
    })
    expect(input).toEqual(maximum === 3 ? { networkRequestBodyBase64: 'c2Vj' } : undefined)
    expect(snapshot).not.toContain('c2Vj')
    expect(snapshot).not.toContain('networkRequestBodyBase64')
  })

  it('rejects invalid trusted configuration before creating hooks', () => {
    for (const maximum of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1024 * 1024 + 1]) {
      expect(() =>
        createCapabilityNetworkHooksV1({
          invokeSync: () => '',
          invoke: async () => ''
        }, { requestBodyReaderMaxBytes: maximum })
      ).toThrow(TypeError)
    }
  })
})
