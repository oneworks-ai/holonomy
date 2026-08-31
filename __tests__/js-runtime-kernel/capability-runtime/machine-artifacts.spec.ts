import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import {
  CANONICAL_RESOURCE_V1_SCHEMA,
  CAPABILITY_DEFINITION_REGISTRY_V1_SCHEMA,
  CAPABILITY_ERROR_MAP_V1_SCHEMA,
  CAPABILITY_REQUIREMENT_V1_SCHEMA,
  CAPABILITY_SELECTION_V1_SCHEMA,
  CORE_CONTRACT_V1_SCHEMA,
  DEVICE_EVENT_V1_SCHEMA,
  DEVICE_PROVIDER_DESCRIPTOR_V1_SCHEMA,
  DEVICE_SUMMARY_V1_SCHEMA,
  ENGINE_GATE_CONTRACT_V1_SCHEMA,
  ENGINE_HOOK_CAPABILITY_PROBE_V1_SCHEMA,
  HOST_SYSTEM_PROJECTION_V1_SCHEMA,
  INVOCATION_SNAPSHOT_CAPABILITY_V1_SCHEMA,
  INVOCATION_SNAPSHOT_ENVELOPE_V1_SCHEMA,
  OBSERVER_CONTRACT_V1_SCHEMA,
  OPERATION_REGISTRY_V1_SCHEMA,
  OPERATION_SCHEMA_OWNER_REGISTRY_V1,
  PROCESS_BACKEND_DESCRIPTOR_V1_SCHEMA,
  PROCESS_BACKEND_PROBE_EVIDENCE_V1_SCHEMA,
  RESOLVED_RESOURCE_CHALLENGE_V1_SCHEMA,
  RUNTIME_CONTEXT_ENVELOPE_V1_SCHEMA,
  RUNTIME_CREATION_SPEC_V1_SCHEMA,
  SANDBOX_POLICY_V2_SCHEMA,
  admitRuntimeCreationV1,
  canonicalVirtualPath,
  normalizeInvocationSnapshotEnvelopeV1,
  normalizeNetworkInvocationSnapshotV1,
  normalizeNetworkRedirectInvocationV1,
  normalizeProcessBackendProbeEvidenceV1,
  normalizeResolvedResourceChallengeV1,
  validateOperationRegistryV1
} from '../../../src/capability-runtime/index.js'

const machineRoot = resolve(process.cwd(), 'packages/runtime/src/kernel/machine')
const json = <T>(name: string): T => JSON.parse(readFileSync(resolve(machineRoot, name), 'utf8')) as T
const validates = (schema: object, value: unknown) => {
  const validate = new Ajv2020({ strict: true }).compile(schema)
  return validate(value)
}
const operationOwnerSchemas = new Map(
  OPERATION_SCHEMA_OWNER_REGISTRY_V1.map(item => [item.schemaId, item.schema])
)
const validatesOperationSchema = (schemaId: string, value: unknown): boolean => {
  const schema = operationOwnerSchemas.get(schemaId)
  if (schema == null) throw new Error(`Missing operation schema ${schemaId}`)
  return validates(schema, value)
}

describe('checked-in capability machine artifacts', () => {
  it('compiles every JSON Schema independently', () => {
    const names = readdirSync(machineRoot).filter(name => name.endsWith('.schema.json')).sort()
    expect(names).toHaveLength(19)
    for (const name of names) {
      expect(() => new Ajv2020({ strict: true }).compile(json(name))).not.toThrow()
    }
  })

  it('validates closed registries and error maps', () => {
    const operationRegistry = json<Parameters<typeof validateOperationRegistryV1>[0]>(
      'operation-registry-v1.json'
    )
    expect(validates(
      OPERATION_REGISTRY_V1_SCHEMA,
      operationRegistry
    )).toBe(true)
    expect(() => validateOperationRegistryV1(operationRegistry)).not.toThrow()
    expect(validates(
      CAPABILITY_DEFINITION_REGISTRY_V1_SCHEMA,
      json('capability-definition-registry-v1.json')
    )).toBe(true)
    expect(validates(
      CAPABILITY_ERROR_MAP_V1_SCHEMA,
      json('capability-error-map-v1.json')
    )).toBe(true)
    const capability = json<{
      vectors: readonly { requirement: unknown; selected: unknown }[]
    }>('capability-selection-v1.vectors.json')
    expect(capability.vectors.every(vector =>
      validates(CAPABILITY_REQUIREMENT_V1_SCHEMA, vector.requirement) &&
      validates(CAPABILITY_SELECTION_V1_SCHEMA, vector.selected)
    )).toBe(true)
    expect(validates(
      { ...CORE_CONTRACT_V1_SCHEMA, $ref: '#/$defs/facadeDeliveryRegistry' },
      json('facade-delivery-registry-v1.json')
    )).toBe(true)
    expect(validates(
      { ...CORE_CONTRACT_V1_SCHEMA, $ref: '#/$defs/operationSchemaOwners' },
      json('operation-schema-owners-v1.json')
    )).toBe(true)
    for (const owner of OPERATION_SCHEMA_OWNER_REGISTRY_V1) {
      expect(() => new Ajv2020({ strict: true }).compile(owner.schema)).not.toThrow()
    }
  })

  it('validates exact Process, Filesystem and Network operation vectors', () => {
    const vectors = json<{
      filesystem: {
        invalid: readonly { args: unknown; schemaId: string }[]
        valid: readonly { args: unknown; resultSchemaId: string; schemaId: string }[]
      }
      network: {
        invalid: readonly {
          expectedCode?: string
          schemaId: string
          semantic?: boolean
          value: unknown
        }[]
        valid: readonly { normalized: unknown; schemaId: string }[]
      }
      process: {
        invalid: readonly { schemaId: string; value: unknown }[]
        valid: readonly { schemaId: string; value: unknown }[]
      }
    }>('operation-contract-v1.vectors.json')
    for (const vector of vectors.process.valid) {
      expect(validatesOperationSchema(vector.schemaId, vector.value)).toBe(true)
    }
    for (const vector of vectors.process.invalid) {
      expect(validatesOperationSchema(vector.schemaId, vector.value)).toBe(false)
    }
    for (const vector of vectors.filesystem.valid) {
      expect(validatesOperationSchema(vector.schemaId, vector.args)).toBe(true)
      expect(operationOwnerSchemas.has(vector.resultSchemaId)).toBe(true)
    }
    for (const vector of vectors.filesystem.invalid) {
      expect(validatesOperationSchema(vector.schemaId, vector.args)).toBe(false)
    }
    for (const vector of vectors.network.valid) {
      expect(validatesOperationSchema(vector.schemaId, vector.normalized)).toBe(true)
    }
    for (const vector of vectors.network.invalid) {
      if (vector.semantic === true) {
        expect(validatesOperationSchema(vector.schemaId, vector.value)).toBe(true)
        try {
          if (vector.schemaId === 'NetworkInvocationSnapshotV1') {
            normalizeNetworkInvocationSnapshotV1(vector.value)
          } else normalizeNetworkRedirectInvocationV1(vector.value)
          throw new Error('Expected semantic Network vector to fail')
        } catch (error) {
          expect(error).toMatchObject({ code: vector.expectedCode })
        }
      } else expect(validatesOperationSchema(vector.schemaId, vector.value)).toBe(false)
    }
  })

  it('validates Policy, Context, System and Engine vectors', () => {
    const policies = json<{ vectors: readonly { normalized: unknown }[] }>(
      'sandbox-policy-v2.vectors.json'
    )
    expect(policies.vectors.every(vector =>
      validates(
        SANDBOX_POLICY_V2_SCHEMA,
        vector.normalized
      )
    )).toBe(true)
    const systems = json<{ vectors: readonly { normalized: unknown }[] }>(
      'host-system-projection-v1.vectors.json'
    )
    expect(systems.vectors.every(vector =>
      validates(
        HOST_SYSTEM_PROJECTION_V1_SCHEMA,
        vector.normalized
      )
    )).toBe(true)
    const contexts = json<{ vectors: readonly { context: unknown }[] }>(
      'runtime-context-v1.vectors.json'
    )
    expect(contexts.vectors.every(vector =>
      validates(
        RUNTIME_CONTEXT_ENVELOPE_V1_SCHEMA,
        vector.context
      )
    )).toBe(true)
    const creation = json<{
      invalid: readonly { code: string; spec: unknown }[]
      valid: readonly { spec: unknown }[]
    }>('runtime-creation-v1.vectors.json')
    expect(creation.valid.every(vector =>
      validates(
        RUNTIME_CREATION_SPEC_V1_SCHEMA,
        vector.spec
      )
    )).toBe(true)
    expect(creation.invalid.every(vector =>
      validates(
        RUNTIME_CREATION_SPEC_V1_SCHEMA,
        vector.spec
      )
    )).toBe(true)
    const resolveBinding = (reference: { bindingId: string }) => ({ id: reference.bindingId })
    for (const vector of creation.invalid) {
      try {
        admitRuntimeCreationV1(vector.spec, {
          expectedOwnerId: 'host-owner',
          generation: 1,
          processId: 'process-vector',
          resolveBinding
        })
        throw new Error('Expected invalid RuntimeCreation vector to fail')
      } catch (error) {
        expect(error).toMatchObject({ code: vector.code })
      }
    }
    expect(validates(
      ENGINE_HOOK_CAPABILITY_PROBE_V1_SCHEMA,
      json('node-engine-hook-capability-v1.json')
    )).toBe(true)
    expect(validates(
      ENGINE_HOOK_CAPABILITY_PROBE_V1_SCHEMA,
      json('android-engine-hook-capability-v1.json')
    )).toBe(true)
    const gate = json<{ decisions: unknown[]; requests: unknown[] }>('engine-gate-v1.vectors.json')
    expect(gate.requests.every(request =>
      validates(
        { ...ENGINE_GATE_CONTRACT_V1_SCHEMA, $ref: '#/$defs/request' },
        request
      )
    )).toBe(true)
    expect(gate.decisions.every(decision =>
      validates(
        { ...ENGINE_GATE_CONTRACT_V1_SCHEMA, $ref: '#/$defs/decision' },
        decision
      )
    )).toBe(true)
    const observer = json<{ events: unknown[] }>('observer-contract-v1.vectors.json')
    expect(observer.events.every(event =>
      validates(
        { ...OBSERVER_CONTRACT_V1_SCHEMA, $ref: '#/$defs/event' },
        event
      )
    )).toBe(true)
  })

  it('validates platform-neutral Process Backend descriptors', () => {
    const backends = json<{ vectors: readonly { normalized: unknown }[] }>(
      'process-backend-v1.vectors.json'
    )
    expect(backends.vectors.every(vector => validates(PROCESS_BACKEND_DESCRIPTOR_V1_SCHEMA, vector.normalized))).toBe(
      true
    )
    expect(backends.vectors.map(vector => (vector.normalized as { backendId: string }).backendId)).toEqual([
      'native.darwin-seatbelt-v1'
    ])
    const probes = json<{ vectors: readonly { normalized: unknown }[] }>(
      'process-backend-probe-v1.vectors.json'
    )
    expect(probes.vectors.every(vector => validates(PROCESS_BACKEND_PROBE_EVIDENCE_V1_SCHEMA, vector.normalized))).toBe(
      true
    )
    const fixture = probes.vectors[0]!.normalized as {
      observations: Record<string, unknown>[]
    }
    expect(() => normalizeProcessBackendProbeEvidenceV1(fixture)).not.toThrow()
    const forged = structuredClone(fixture)
    forged.observations[0] = { ...forged.observations[0], provenance: 'upstreamContract' }
    expect(validates(PROCESS_BACKEND_PROBE_EVIDENCE_V1_SCHEMA, forged)).toBe(false)
    expect(() => normalizeProcessBackendProbeEvidenceV1(forged)).toThrow()
  })

  it('validates canonical resources and exact Device vectors', () => {
    const resources = json<{ vectors: Readonly<Record<string, unknown>> }>(
      'canonical-resource-v1.vectors.json'
    )
    for (const key of ['filesystem', 'program', 'shell', 'systemField']) {
      expect(validates(CANONICAL_RESOURCE_V1_SCHEMA, resources.vectors[key])).toBe(true)
    }
    const device = json<{
      vectors: {
        androidProvider: unknown
        desktopProvider: unknown
        nodeProvider: unknown
        tierOneSummary: unknown
      }
    }>('device-contract-v1.vectors.json')
    for (
      const provider of [
        device.vectors.androidProvider,
        device.vectors.desktopProvider,
        device.vectors.nodeProvider
      ]
    ) expect(validates(DEVICE_PROVIDER_DESCRIPTOR_V1_SCHEMA, provider)).toBe(true)
    expect(validates(DEVICE_SUMMARY_V1_SCHEMA, device.vectors.tierOneSummary)).toBe(true)
  })

  it('runs Resolution semantic vectors beyond structural JSON Schema', () => {
    const resolution = json<{
      invalid: readonly { value: unknown }[]
      valid: readonly unknown[]
    }>('resource-resolution-v1.vectors.json')
    for (const value of resolution.valid) {
      expect(validates(RESOLVED_RESOURCE_CHALLENGE_V1_SCHEMA, value)).toBe(true)
      expect(normalizeResolvedResourceChallengeV1(value)).toEqual(value)
    }
    for (const { value } of resolution.invalid) {
      try {
        normalizeResolvedResourceChallengeV1(value)
        throw new Error('Expected invalid Resolution vector to fail')
      } catch (error) {
        expect(error).toMatchObject({ code: 'runtime.configuration_invalid' })
      }
    }
  })

  it('keeps discriminants strict rather than accepting shape drift', () => {
    expect(validates(DEVICE_EVENT_V1_SCHEMA, {
      kind: 'overflow',
      observedAt: 1,
      requiredRevisions: {},
      resyncRequired: true,
      schemaVersion: 1,
      sequence: 1
    })).toBe(false)
    expect(validates(INVOCATION_SNAPSHOT_CAPABILITY_V1_SCHEMA, {
      binaryInternalSlotCopy: true,
      engineIsProxyWithoutTrap: false,
      guestReentryPrevented: true,
      plainOwnSlotWalker: true,
      schemaVersion: 1
    })).toBe(false)
    const snapshots = json<{
      invalid: readonly { name: string; snapshot: unknown }[]
      vectors: readonly { snapshot: unknown }[]
    }>(
      'invocation-snapshot-v1.vectors.json'
    )
    expect(snapshots.vectors.every(vector =>
      validates(
        INVOCATION_SNAPSHOT_ENVELOPE_V1_SCHEMA,
        vector.snapshot
      )
    )).toBe(true)
    for (const vector of snapshots.invalid) {
      expect(() => normalizeInvocationSnapshotEnvelopeV1(vector.snapshot), vector.name).toThrow()
    }
    expect(validates(INVOCATION_SNAPSHOT_ENVELOPE_V1_SCHEMA, {
      direction: 'argument',
      root: { bindingId: 'one', bindingType: 'callback', generation: 1, kind: 'binary' },
      schemaVersion: 1
    })).toBe(false)
  })

  it('normalizes shared virtual path vectors and rejects encoded escapes', () => {
    const paths = json<{
      invalid: readonly string[]
      valid: readonly { input: string; normalized: string }[]
    }>('virtual-path-v1.vectors.json')
    for (const vector of paths.valid) {
      expect(canonicalVirtualPath(vector.input)).toBe(vector.normalized)
    }
    for (const value of paths.invalid) expect(() => canonicalVirtualPath(value)).toThrow()
  })
})
