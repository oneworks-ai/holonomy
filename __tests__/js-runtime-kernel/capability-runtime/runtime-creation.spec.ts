import { describe, expect, it } from 'vitest'

import {
  CapabilityContractError,
  DEFAULT_SANDBOX_POLICY_V2,
  admitRuntimeCreationV1
} from '../../../src/capability-runtime/index.js'

const input = () =>
  structuredClone({
    configuration: {
      context: {
        guest: { displayName: 'Runtime example' },
        host: { tenantId: 'private-tenant' },
        inspector: { title: 'Runtime example' },
        schemaVersion: 1
      },
      inspector: { enabled: false },
      launch: {
        entryUrl: 'app+local://workspace/main.mjs',
        moduleCount: 1,
        moduleGraphDigest: '1'.repeat(64),
        moduleRootUrl: 'app+local://workspace/',
        totalSourceBytes: 32
      },
      sandboxPolicy: DEFAULT_SANDBOX_POLICY_V2,
      schemaVersion: 1,
      systemProjection: { fields: {}, schemaVersion: 1 }
    },
    hostBindings: {
      engineGate: { bindingId: 'engine-gate', ownerId: 'host-owner', version: '1' },
      initialMiddlewareSet: {
        bindingId: 'middleware-set',
        ownerId: 'host-owner',
        version: '1'
      },
      initialObservers: [{
        bindingId: 'observer-set',
        ownerId: 'host-owner',
        version: '1'
      }],
      moduleResolver: { bindingId: 'module-resolver', ownerId: 'host-owner', version: '1' },
      providerBindings: [{
        module: 'host.fs',
        ownerId: 'host-owner',
        providerId: 'fs-provider',
        providerVersion: '1'
      }]
    }
  })
const resolveBinding = (reference: { bindingId: string }) => ({ id: reference.bindingId })

describe('runtime creation spec v1 atomic admission', () => {
  it('freezes configuration and resolves every Host binding before returning a generation', () => {
    const source = input()
    const admitted = admitRuntimeCreationV1(source, {
      expectedOwnerId: 'host-owner',
      generation: 1,
      processId: 'process-1',
      resolveBinding
    })
    source.configuration.context.guest.displayName = 'mutated'
    expect(admitted.configuration.context.guest).toEqual({ displayName: 'Runtime example' })
    expect(admitted.principal).toBe('holo:process-1:1')
    expect(Object.keys(admitted.resolvedHostBindings)).toHaveLength(5)
    expect(Object.isFrozen(admitted.resolvedHostBindings)).toBe(true)
    expect(() => {
      Object.assign(admitted.resolvedHostBindings, { injected: true })
    }).toThrow(TypeError)
    expect(Object.isFrozen(admitted.configuration)).toBe(true)
  })

  it('fails atomically on missing or owner-mismatched bindings before entry can exist', () => {
    let entrySideEffects = 0
    expect(() => {
      const admitted = admitRuntimeCreationV1(input(), {
        expectedOwnerId: 'host-owner',
        generation: 1,
        processId: 'process-1',
        resolveBinding: (reference, kind) =>
          kind === 'provider'
            ? undefined
            : resolveBinding(reference)
      })
      entrySideEffects += admitted.generation
    }).toThrow(expect.objectContaining({ code: 'runtime.binding_unavailable' }))
    expect(entrySideEffects).toBe(0)

    const mismatch = input()
    mismatch.hostBindings.engineGate.ownerId = 'other-owner'
    expect(() =>
      admitRuntimeCreationV1(mismatch, {
        expectedOwnerId: 'host-owner',
        generation: 1,
        processId: 'process-1',
        resolveBinding
      })
    ).toThrow(CapabilityContractError)
  })

  it('keeps configuration stable while fencing restart identities by generation', () => {
    const spec = input()
    const first = admitRuntimeCreationV1(spec, {
      expectedOwnerId: 'host-owner',
      generation: 1,
      processId: 'process-1',
      resolveBinding
    })
    const second = admitRuntimeCreationV1(spec, {
      expectedOwnerId: 'host-owner',
      generation: 2,
      processId: 'process-1',
      resolveBinding
    })
    expect(second.configurationDigest).toBe(first.configurationDigest)
    expect(second.hostBindingsDigest).toBe(first.hostBindingsDigest)
    expect(second.principal).not.toBe(first.principal)
    expect(second.admissionDigest).not.toBe(first.admissionDigest)
  })

  it('rejects non-hierarchical or escaping module graph launch values', () => {
    const opaque = input()
    opaque.configuration.launch.moduleRootUrl = 'data:text/plain,root/'
    expect(() =>
      admitRuntimeCreationV1(opaque, {
        expectedOwnerId: 'host-owner',
        generation: 1,
        processId: 'process-1',
        resolveBinding
      })
    ).toThrow(CapabilityContractError)
    const escape = input()
    escape.configuration.launch.entryUrl = 'app+local://other/main.mjs'
    expect(() =>
      admitRuntimeCreationV1(escape, {
        expectedOwnerId: 'host-owner',
        generation: 1,
        processId: 'process-1',
        resolveBinding
      })
    ).toThrow(CapabilityContractError)

    const encoded = input()
    encoded.configuration.launch.entryUrl = 'app+local://workspace/%2fescape.mjs'
    expect(() =>
      admitRuntimeCreationV1(encoded, {
        expectedOwnerId: 'host-owner',
        generation: 1,
        processId: 'process-1',
        resolveBinding
      })
    ).toThrow(CapabilityContractError)
  })
})
