import { createHash } from 'node:crypto'

import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import {
  CapabilityContractError,
  DEFAULT_SANDBOX_POLICY_V2,
  SANDBOX_POLICY_V2_SCHEMA,
  compileSandboxPolicyV2,
  parseSandboxPolicyJson
} from '../../../src/capability-runtime/index.js'
import type { NetworkLimitNameV2 } from '../../../src/capability-runtime/index.js'

const networkLimits: Record<NetworkLimitNameV2, number> = Object.freeze({
  maxChunkBytes: 65_536,
  maxConcurrentConnections: 8,
  maxHeaderBytes: 65_536,
  maxHeaders: 128,
  maxRedirects: 10,
  maxRequestBodyBytes: 1_048_576,
  maxResponseBodyBytes: 8_388_608,
  maxUrlBytes: 65_536,
  socketTimeoutMs: 30_000
})

const filesystemLimits = Object.freeze({
  maxDirectoryEntries: 1000,
  maxOpenHandles: 32,
  maxReadBytes: 1_048_576,
  maxWatchers: 8,
  maxWriteBytes: 1_048_576
})

const enabledPolicy = () => ({
  codeGeneration: {
    dynamicImport: { access: 'none' },
    strings: { access: 'controlled', decisionTimeoutMs: 1000, maxOperations: 8, maxSourceBytes: 4096 },
    wasm: { access: 'none' }
  },
  device: {
    defaultAccess: 'deny',
    maxEventsPerSecond: 10,
    maxSubscriptions: 2,
    operations: {
      'device.connectivity.wifi.state.read': {
        access: 'allow',
        maxPrecision: 'coarse',
        maxPrivacyTier: 2
      },
      'device.summary.read': { access: 'allow', maxPrecision: 'standard', maxPrivacyTier: 1 }
    }
  },
  diagnostics: {
    maxObserverCallbackMs: 500,
    maxQueuedEvents: 32,
    maxSourceReadBytes: 0,
    observerEvents: ['runtime.exception', 'runtime.terminated'],
    retentionMs: 1000,
    sourceReader: 'metadataOnly'
  },
  filesystem: {
    access: 'sandboxed',
    limits: filesystemLimits,
    roots: [{
      rights: ['write', 'read', 'list'],
      rootId: 'workspace',
      symlinks: 'withinRoot',
      virtualUrl: 'holo-fs://workspace/'
    }]
  },
  inspector: { evaluate: true },
  network: {
    access: 'restricted',
    allowedOrigins: ['https://api.example', 'http://127.0.0.1:8123'],
    allowedSchemes: ['https', 'http'],
    allowPrivateNetwork: true,
    limits: networkLimits,
    requestBodyInspection: { access: 'bounded', maxBytes: 4096, maxReadsPerRuntime: 2 }
  },
  process: {
    access: 'sandboxed',
    environment: { allowedNames: ['LANG'], maxValueBytes: 4096 },
    executables: [{ argumentBytes: 4096, executableId: 'git' }],
    limits: {
      maxConcurrentProcesses: 2,
      maxExecutionTimeMs: 30_000,
      maxOpenPipes: 3,
      maxProcessTreeDepth: 2,
      maxStderrBytes: 1_048_576,
      maxStdinBytes: 1_048_576,
      maxStdoutBytes: 1_048_576,
      maxTotalProcesses: 10,
      maxWritableRootfsBytes: 1_048_576
    },
    mounts: [{ guestPath: '/workspace', rights: ['read', 'write'], rootId: 'workspace' }],
    network: { access: 'none' },
    shell: { access: 'none' }
  },
  schemaVersion: 2,
  systemInformation: {
    defaultMode: 'unavailable',
    fields: {
      'os.arch': { allowedModes: ['synthetic', 'real'], maxPrecision: 'exact' },
      'os.hostname': { allowedModes: ['redacted'], maxPrecision: 'redacted' }
    }
  }
})

describe('sandbox policy v2 machine contract', () => {
  it('fills omitted fields with one canonical fail-closed policy and digest', () => {
    const first = compileSandboxPolicyV2({ schemaVersion: 2 })
    const second = compileSandboxPolicyV2()

    expect(first.policy).toEqual(DEFAULT_SANDBOX_POLICY_V2)
    expect(first).toEqual(second)
    expect(first.digest).toMatch(/^[\da-f]{64}$/u)
    expect(first.digest).toBe(
      createHash('sha256').update(first.canonicalJson).digest('hex')
    )
    expect(Object.isFrozen(first.policy)).toBe(true)
  })

  it('normalizes declared sets before computing the digest', () => {
    const left = compileSandboxPolicyV2(enabledPolicy())
    const reordered = enabledPolicy()
    reordered.network.allowedOrigins.reverse()
    reordered.network.allowedSchemes.reverse()
    reordered.filesystem.roots[0]!.rights.reverse()
    reordered.systemInformation.fields['os.arch']!.allowedModes.reverse()

    const right = compileSandboxPolicyV2(reordered)
    expect(right.digest).toBe(left.digest)
    expect(right.canonicalJson).toBe(left.canonicalJson)
    expect(right.policy.network.access === 'restricted' && right.policy.network.allowedOrigins)
      .toEqual(['http://127.0.0.1:8123', 'https://api.example'])
  })

  it('compiles to the checked-in strict JSON Schema', () => {
    const validate = new Ajv2020({ strict: true }).compile(SANDBOX_POLICY_V2_SCHEMA)
    const normalized = compileSandboxPolicyV2(enabledPolicy()).policy

    expect(validate(normalized)).toBe(true)
    expect(validate({ ...normalized, ambientNetwork: true })).toBe(false)
  })

  it.each([
    [{ schemaVersion: 3 }, 'runtime.policy_version_unsupported'],
    [{ schemaVersion: 2, unknown: true }, 'runtime.configuration_invalid'],
    [{ network: { access: 'none', limits: networkLimits }, schemaVersion: 2 }, 'runtime.configuration_invalid']
  ])('rejects unknown versions, fields and deny-branch widening', (policy, code) => {
    expect(() => compileSandboxPolicyV2(policy)).toThrowError(
      expect.objectContaining<Partial<CapabilityContractError>>({
        code: code as CapabilityContractError['code']
      })
    )
  })

  it('rejects cross-domain authority widening', () => {
    const mockPrivate = enabledPolicy()
    mockPrivate.network.access = 'mockOnly'
    expect(() => compileSandboxPolicyV2(mockPrivate)).toThrow(CapabilityContractError)

    const weakDevice = enabledPolicy()
    weakDevice.device.operations['device.connectivity.wifi.state.read']!.maxPrivacyTier = 1
    expect(() => compileSandboxPolicyV2(weakDevice)).toThrow(CapabilityContractError)

    const mountWithoutWrite = enabledPolicy()
    mountWithoutWrite.filesystem.roots[0]!.rights = ['read', 'list']
    expect(() => compileSandboxPolicyV2(mountWithoutWrite)).toThrow(CapabilityContractError)
  })

  it('rejects noncanonical roots, paths, duplicates and unsafe resource products', () => {
    const path = enabledPolicy()
    path.filesystem.roots[0]!.virtualUrl = 'holo-fs://workspace/%2e%2e'
    expect(() => compileSandboxPolicyV2(path)).toThrow(CapabilityContractError)

    const duplicate = enabledPolicy()
    duplicate.network.allowedSchemes = ['https', 'https']
    expect(() => compileSandboxPolicyV2(duplicate)).toThrow(CapabilityContractError)

    const product = enabledPolicy()
    product.network.limits = {
      ...networkLimits,
      maxConcurrentConnections: 128,
      maxRequestBodyBytes: 64 * 1024 * 1024
    }
    expect(() => compileSandboxPolicyV2(product)).toThrow(CapabilityContractError)
  })

  it('migrates v1 Network only and defaults every new authority to deny', () => {
    const migrated = compileSandboxPolicyV2({
      filesystem: { access: 'none' },
      network: {
        access: 'restricted',
        allowedOrigins: ['https://api.example'],
        allowedSchemes: ['https'],
        allowPrivateNetwork: false,
        limits: Object.fromEntries(
          Object.entries(networkLimits).filter(([key]) => key !== 'maxRedirects')
        )
      },
      schemaVersion: 1
    })

    expect(migrated.policy.schemaVersion).toBe(2)
    expect(migrated.policy.network.access).toBe('restricted')
    expect(migrated.policy.filesystem).toEqual({ access: 'none' })
    expect(migrated.policy.process).toEqual({ access: 'none' })
    expect(migrated.policy.systemInformation.fields).toEqual({})
    expect(migrated.policy.codeGeneration.strings).toEqual({ access: 'none' })
  })

  it('parses bounded JSON without accepting oversized or deeply nested input', () => {
    expect(parseSandboxPolicyJson('{"schemaVersion":2}').policy)
      .toEqual(DEFAULT_SANDBOX_POLICY_V2)
    expect(() => parseSandboxPolicyJson(`{"schemaVersion":2,"x":"${'a'.repeat(1024 * 1024)}"}`))
      .toThrow(CapabilityContractError)
    expect(() =>
      compileSandboxPolicyV2({
        schemaVersion: 2,
        value: [[[[[[[[[[[[[[[[[true]]]]]]]]]]]]]]]]]
      })
    ).toThrow(CapabilityContractError)
  })
})
