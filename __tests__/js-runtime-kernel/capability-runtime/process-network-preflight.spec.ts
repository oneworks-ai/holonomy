import { describe, expect, it } from 'vitest'

// @ts-expect-error -- Exercise the existing shared JavaScript Host-port owner directly; it has no declaration.
import { processNetworkPreflightV1 } from '../../../packages/capabilities/process/src/host/network-preflight.mjs'
import { CapabilityInvocationError, trustedInvocationValueFromJsonV1 } from '../../../src/capability-runtime/index.js'

const endpoint = { hostname: 'example.test', port: 80, transport: 'tcp' }
const resource = { ...endpoint, kind: 'processNetworkEndpoint', semanticResourceDigest: 'a'.repeat(64) }
const requestedBinding = { generation: 1, invocationBindingDigest: 'b'.repeat(64) }
const resolvedBinding = { generation: 1, invocationBindingDigest: 'c'.repeat(64), subrequestId: 'resolution-1' }
const requested = {
  operation: 'process.network.connect',
  resource: { binding: requestedBinding, requested: resource },
  runtime: { generation: 1 }
}
const resolved = { ...requested, resource: { ...requested.resource, binding: resolvedBinding, resolved: resource } }
const bindings = [{
  capabilityName: 'host.process.network',
  constraints: { endpoints: [{ ...endpoint, ports: [80] }], maxSockets: 1 },
  providerModule: 'host.process'
}]
const receipt = { addresses: ['127.0.0.1'], evidenceDigest: 'd'.repeat(64) }

const preflight = async (resolution: Record<string, unknown>) => {
  return processNetworkPreflightV1({
    authority: { bindings },
    context: requested,
    contracts: { CapabilityInvocationError, trustedInvocationValueFromJsonV1 },
    generation: 1,
    policy: { access: 'sandboxed', network: { access: 'restricted' } },
    port: { resolveNetwork: async () => ({ evidence: {}, receipt, verify: () => ({}), ...resolution }) }
  })
}

describe('process network resolved binding preflight', () => {
  it('binds the final resolved context before publishing a receipt and forwards disposal', async () => {
    const events: string[] = []
    let received: unknown
    const plan = await preflight({
      bindResolvedContext(context: unknown) {
        events.push('bind')
        received = context
      },
      dispose() {
        events.push('dispose')
      }
    })
    const result = plan.execute(resolved, [{
      bindings,
      complete(value: unknown) {
        events.push('complete')
        return value
      },
      invocationBinding: resolvedBinding
    }])
    expect(received).toBe(resolved)
    expect(result).toMatchObject({ value: { invocationBindingDigest: resolvedBinding.invocationBindingDigest } })
    expect(events).toEqual(['bind', 'complete'])
    plan.dispose()
    expect(events).toEqual(['bind', 'complete', 'dispose'])
  })

  it('preserves ports with no private binding hook', async () => {
    const plan = await preflight({})
    const result = plan.execute(resolved, [{
      complete: (value: unknown) => value,
      invocationBinding: resolvedBinding
    }])
    expect(result).toMatchObject({ value: { authorized: true, resolution: receipt } })
    expect(plan.dispose).toBeUndefined()
  })

  it('does not publish a receipt when the private hook fails or returns async work', async () => {
    for (
      const hook of [() => {
        throw new Error('binding failed')
      }, () => Promise.reject(new Error('late rejection'))]
    ) {
      let completed = false
      const plan = await preflight({ bindResolvedContext: hook })
      expect(() =>
        plan.execute(resolved, [{
          complete() {
            completed = true
          },
          invocationBinding: resolvedBinding
        }])
      ).toThrow()
      expect(completed).toBe(false)
    }
    await Promise.resolve()
  })
})
