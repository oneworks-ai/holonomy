import { describe, expect, it, vi } from 'vitest'

import { CapabilityResourceRegistryV1, canonicalizeFilesystemResource } from '../../../src/capability-runtime/index.js'
import type { CapabilitySelectionV1 } from '../../../src/capability-runtime/index.js'

const identity = Object.freeze({
  engine: 'node-vm',
  generation: 1,
  policyDigest: '1'.repeat(64),
  processId: 'resource-registry-test',
  target: 'node' as const
})
const selection = Object.freeze({
  authorityBindings: Object.freeze([Object.freeze({
    authorityDigest: '2'.repeat(64),
    authorityVersion: 1 as const,
    capabilityName: 'host.fs' as const,
    constraints: Object.freeze({}),
    providerModule: 'host.fs'
  })]),
  bindings: Object.freeze([]),
  branchId: 'test',
  requirement: Object.freeze({ anyOf: Object.freeze([]) })
}) satisfies CapabilitySelectionV1
const value = (bindingId: string) => ({
  binding: { bindingId, generation: 1 },
  resourceType: 'filesystem.file-handle'
})

describe('capability resource registry', () => {
  it('does not inflate references when a continuation returns its inherited facade', () => {
    const close = vi.fn()
    const registry = new CapabilityResourceRegistryV1(identity)
    registry.publish(
      value('fd-1'),
      [{
        bindingId: 'fd-1',
        close,
        resource: canonicalizeFilesystemResource('holo-fs://workspace/file.txt', 'file.txt'),
        resourceType: 'filesystem.file-handle'
      }],
      'host.fs',
      selection
    )

    registry.publish(value('fd-1'), undefined, 'host.fs', selection, 'fd-1')
    registry.release('fd-1')

    expect(close).toHaveBeenCalledOnce()
    expect(() => registry.get('fd-1')).toThrow(expect.objectContaining({ code: 'runtime.generation_stale' }))
  })

  it('retains an explicitly duplicated facade until both references close', () => {
    const registry = new CapabilityResourceRegistryV1(identity)
    registry.publish(
      value('fd-2'),
      [{
        bindingId: 'fd-2',
        resource: canonicalizeFilesystemResource('holo-fs://workspace/file.txt', 'file.txt'),
        resourceType: 'filesystem.file-handle'
      }],
      'host.fs',
      selection
    )
    registry.publish(value('fd-2'), undefined, 'host.fs', selection)

    registry.release('fd-2')
    expect(registry.get('fd-2').references).toBe(1)
    registry.release('fd-2')
    expect(() => registry.get('fd-2')).toThrow(expect.objectContaining({ code: 'runtime.generation_stale' }))
  })
})
