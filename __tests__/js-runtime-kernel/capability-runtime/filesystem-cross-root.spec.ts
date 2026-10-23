import { describe, expect, it } from 'vitest'
import { CapabilityRuntimeInvocationKernelV1 } from '../../../src/capability-runtime/index.js'
import { creation, policyV2, provider } from './broker-fixtures.js'

describe('filesystem cross-root rename contract', () => {
  it('returns EXDEV before Provider execution for different root identities', () => {
    const policy = policyV2()
    if (policy.filesystem.access !== 'sandboxed') throw new Error('Fixture must install FS')
    const configured = {
      ...policy,
      filesystem: {
        ...policy.filesystem,
        roots: policy.filesystem.roots.map(root => ({ ...root, rights: ['read', 'move'] as const }))
      }
    }
    let calls = 0
    const fs = provider('host.fs', 'sync', {}, () => {
      calls += 1
    })
    const kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted: creation({ 'host.fs': fs }, undefined, configured),
      engine: 'test',
      target: 'desktop',
      networkProvider: 'host.network',
      requestPrefix: 'rename'
    })
    try {
      const terminal = JSON.parse(
        kernel.invokeSync(
          JSON.stringify({
            module: 'node:fs',
            member: 'renameSync',
            mode: 'sync',
            path: 'holo-fs://workspace/a',
            arguments: { from: 'holo-fs://workspace/a', to: 'holo-fs://elsewhere/b' }
          })
        )
      )
      expect(terminal).toMatchObject({ ok: false, error: { code: 'EXDEV' } })
      expect(calls).toBe(0)
    } finally {
      kernel.close()
    }
  })
})
