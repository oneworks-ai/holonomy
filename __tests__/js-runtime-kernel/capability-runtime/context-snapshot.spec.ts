import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import {
  CapabilityContractError,
  INVOCATION_SNAPSHOT_CAPABILITY_V1_SCHEMA,
  INVOCATION_SNAPSHOT_ENVELOPE_V1_SCHEMA,
  RUNTIME_CONTEXT_ENVELOPE_V1_SCHEMA,
  compileRuntimeContextEnvelopeV1,
  normalizeInvocationSnapshotEnvelopeV1,
  runtimeContextDigestV1,
  validateInvocationSnapshotCapabilityV1
} from '../../../src/capability-runtime/index.js'

describe('runtime context and snapshot capability contracts', () => {
  it('freezes independent host, guest and inspector projections', () => {
    const input = {
      guest: { displayName: 'Guest label' },
      host: { tenantId: 'private-tenant', trust: { level: 3 } },
      inspector: { title: 'Inspector label' },
      schemaVersion: 1
    }
    const snapshot = compileRuntimeContextEnvelopeV1(input)
    input.host.trust.level = 9
    expect(snapshot.host).toEqual({ tenantId: 'private-tenant', trust: { level: 3 } })
    expect(snapshot.guest).toEqual({ displayName: 'Guest label' })
    expect(snapshot.inspector).toEqual({ title: 'Inspector label' })
    expect(Object.isFrozen(snapshot.host)).toBe(true)
    expect(runtimeContextDigestV1(snapshot)).toMatch(/^[\da-f]{64}$/u)
  })

  it('does not invoke Host getters while rejecting accessors', () => {
    let calls = 0
    const guest = Object.create(null)
    Object.defineProperty(guest, 'secret', {
      enumerable: true,
      get() {
        calls += 1
        return 'leak'
      }
    })
    expect(() => compileRuntimeContextEnvelopeV1({ guest, schemaVersion: 1 }))
      .toThrow(CapabilityContractError)
    expect(calls).toBe(0)
  })

  it('rejects exotic prototypes, unknown fields, depth and byte overflow', () => {
    expect(() =>
      compileRuntimeContextEnvelopeV1({
        guest: new Date(),
        schemaVersion: 1
      })
    ).toThrow(CapabilityContractError)
    expect(() =>
      compileRuntimeContextEnvelopeV1({
        guest: {},
        principal: 'guest-controlled',
        schemaVersion: 1
      })
    ).toThrow(CapabilityContractError)
    expect(() =>
      compileRuntimeContextEnvelopeV1({
        guest: { nested: { nested: { nested: true } } },
        schemaVersion: 1
      }, {
        maxArrayLength: 8,
        maxDepth: 1,
        maxKeys: 8,
        maxProjectionBytes: 1024,
        maxStringBytes: 128
      })
    ).toThrow(CapabilityContractError)
    expect(() =>
      compileRuntimeContextEnvelopeV1({
        guest: { value: 'x'.repeat(128) },
        schemaVersion: 1
      }, {
        maxArrayLength: 8,
        maxDepth: 4,
        maxKeys: 8,
        maxProjectionBytes: 32,
        maxStringBytes: 256
      })
    ).toThrow(CapabilityContractError)
  })

  it('requires an Engine-backed no-trap invocation snapshot capability', () => {
    const valid = {
      binaryInternalSlotCopy: true,
      engineIsProxyWithoutTrap: true,
      guestReentryPrevented: true,
      plainOwnSlotWalker: true,
      schemaVersion: 1 as const
    }
    expect(validateInvocationSnapshotCapabilityV1(valid)).toEqual(valid)
    expect(() =>
      validateInvocationSnapshotCapabilityV1({
        ...valid,
        engineIsProxyWithoutTrap: false
      })
    ).toThrow(CapabilityContractError)
  })

  it('normalizes the same finite argument/result manifest consumed by every platform', () => {
    const argument = normalizeInvocationSnapshotEnvelopeV1({
      direction: 'argument',
      root: {
        entries: [{
          key: 'body',
          value: { bindingId: 'bytes-1', byteLength: 3, kind: 'binary', sha256: 'a'.repeat(64) }
        }, {
          key: 'signal',
          value: { bindingId: 'signal-1', bindingType: 'abortSignal', generation: 4, kind: 'binding' }
        }],
        kind: 'object'
      },
      schemaVersion: 1
    })
    expect(argument.root.kind).toBe('object')
    expect(Object.isFrozen(argument.root)).toBe(true)
    expect(() =>
      normalizeInvocationSnapshotEnvelopeV1({
        direction: 'result',
        root: { bindingId: 'callback-1', bindingType: 'callback', generation: 4, kind: 'binding' },
        schemaVersion: 1
      })
    ).toThrow(CapabilityContractError)
    const sorted = normalizeInvocationSnapshotEnvelopeV1({
      direction: 'argument',
      root: {
        entries: [
          { key: 'z', value: { kind: 'scalar', value: true } },
          { key: 'a', value: { kind: 'scalar', value: false } }
        ],
        kind: 'object'
      },
      schemaVersion: 1
    })
    expect(sorted.root).toEqual({
      entries: [
        { key: 'a', value: { kind: 'scalar', value: false } },
        { key: 'z', value: { kind: 'scalar', value: true } }
      ],
      kind: 'object'
    })
    expect(
      normalizeInvocationSnapshotEnvelopeV1({
        direction: 'argument',
        root: {
          items: [
            { bindingId: 'same', bindingType: 'resource', generation: 4, kind: 'binding' },
            { bindingId: 'same', bindingType: 'resource', generation: 4, kind: 'binding' }
          ],
          kind: 'array'
        },
        schemaVersion: 1
      }).root
    ).toEqual(expect.objectContaining({ kind: 'array' }))
  })

  it('matches the structural JSON Schemas', () => {
    const ajv = new Ajv2020({ strict: true })
    expect(
      ajv.compile(RUNTIME_CONTEXT_ENVELOPE_V1_SCHEMA)({
        guest: { application: 'example' },
        schemaVersion: 1
      })
    ).toBe(true)
    expect(
      ajv.compile(INVOCATION_SNAPSHOT_CAPABILITY_V1_SCHEMA)({
        binaryInternalSlotCopy: true,
        engineIsProxyWithoutTrap: true,
        guestReentryPrevented: true,
        plainOwnSlotWalker: true,
        schemaVersion: 1
      })
    ).toBe(true)
    expect(
      ajv.compile(INVOCATION_SNAPSHOT_ENVELOPE_V1_SCHEMA)({
        direction: 'result',
        root: { kind: 'stableError', code: 'holo.operation_failed' },
        schemaVersion: 1
      })
    ).toBe(true)
  })
})
