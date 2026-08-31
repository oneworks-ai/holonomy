import { describe, expect, it } from 'vitest'

import {
  CAPABILITY_DEFINITION_REGISTRY_V1,
  CapabilityContractError,
  canonicalDigest,
  capabilitySatisfiesV1,
  meetCapabilityConstraintsV1,
  normalizeCapabilityRequirementV1,
  selectCapabilityBranchV1
} from '../../../src/capability-runtime/index.js'

const fsLimits = {
  maxDirectoryEntries: 100,
  maxOpenHandles: 10,
  maxQueuedEvents: 16,
  maxReadBytes: 1000,
  maxWatchers: 2,
  maxWriteBytes: 1000
}
const fs = (prefix: string[], rights: string[], maxReadBytes = 1000) => ({
  limits: { ...fsLimits, maxReadBytes },
  roots: [{ pathPrefixSegments: prefix, rights, rootId: 'workspace', symlinks: 'withinRoot' }]
})
const networkLimits = {
  maxChunkBytes: 1024,
  maxConcurrentConnections: 4,
  maxHeaderBytes: 4096,
  maxHeaders: 32,
  maxRedirects: 4,
  maxRequestBodyBytes: 4096,
  maxResponseBodyBytes: 8192,
  maxUrlBytes: 2048,
  socketTimeoutMs: 1000
}
const network = (mode: 'mockOnly' | 'restricted', origins: string[]) => ({
  allowPrivateNetwork: false,
  inspectRequestBodyBytes: 0,
  limits: networkLimits,
  mode,
  origins,
  schemes: ['https']
})
const ref = (name: 'host.fs' | 'host.network.http' | 'host.network.mock', constraints: object) => ({
  constraints,
  name,
  version: 1
})
const context = {
  generation: 3,
  policyDigest: canonicalDigest(['policy']),
  principal: 'holonomy:process-1:3',
  processId: 'process-1'
}

describe('capability definition and selection v1', () => {
  it('has one closed definition for every built-in capability', () => {
    expect(CAPABILITY_DEFINITION_REGISTRY_V1).toHaveLength(21)
    expect(new Set(CAPABILITY_DEFINITION_REGISTRY_V1.map(item => item.name)).size)
      .toBe(CAPABILITY_DEFINITION_REGISTRY_V1.length)
  })

  it('uses segment ancestry, rights sets and numeric ceilings for filesystem', () => {
    expect(capabilitySatisfiesV1(
      'host.fs',
      fs([], ['read', 'write'], 2000),
      fs(['src'], ['read'], 1000)
    )).toBe(true)
    expect(capabilitySatisfiesV1(
      'host.fs',
      fs(['src2'], ['read']),
      fs(['src'], ['read'])
    )).toBe(false)
    expect(capabilitySatisfiesV1(
      'host.fs',
      fs([], ['read']),
      fs([], ['write'])
    )).toBe(false)

    expect(meetCapabilityConstraintsV1(
      'host.fs',
      fs([], ['read', 'write']),
      fs(['src'], ['read'])
    )).toEqual({
      limits: fsLimits,
      roots: [{
        pathPrefixSegments: ['src'],
        rights: ['read'],
        rootId: 'workspace',
        symlinks: 'withinRoot'
      }]
    })
  })

  it('keeps mock and real Network capabilities disjoint', () => {
    expect(capabilitySatisfiesV1(
      'host.network.http',
      network('restricted', ['https://api.example']),
      network('restricted', ['https://api.example'])
    )).toBe(true)
    expect(() =>
      capabilitySatisfiesV1(
        'host.network.http',
        network('mockOnly', ['https://api.example']),
        network('restricted', ['https://api.example'])
      )
    ).toThrow(CapabilityContractError)
    expect(meetCapabilityConstraintsV1(
      'host.network.http',
      network('restricted', ['https://api.example', 'https://other.example']),
      network('restricted', ['https://api.example'])
    )).toEqual(expect.objectContaining({ origins: ['https://api.example'] }))
  })

  it('uses endpoint and port intersections for Linux process network authority', () => {
    const processNetwork = (ports: number[], maxSockets = 4) => ({
      endpoints: [{ hostname: 'api.example', ports, transport: 'tls' }],
      maxSockets,
      privateNetwork: 'deny'
    })
    expect(capabilitySatisfiesV1(
      'host.process.network',
      processNetwork([443, 8443], 8),
      processNetwork([443], 2)
    )).toBe(true)
    expect(capabilitySatisfiesV1(
      'host.process.network',
      processNetwork([8443], 8),
      processNetwork([443], 2)
    )).toBe(false)
    expect(meetCapabilityConstraintsV1(
      'host.process.network',
      processNetwork([443, 8443], 8),
      processNetwork([443, 9443], 2)
    )).toEqual({
      endpoints: [{ hostname: 'api.example', ports: [443], transport: 'tls' }],
      maxSockets: 2,
      privateNetwork: 'deny'
    })
  })

  it('uses separate Device and System precision lattices', () => {
    const device = (maxPrecision: string) => ({
      maxPrecision,
      maxPrivacyTier: 2,
      maxQueuedEvents: 8,
      operations: ['device.connectivity.read']
    })
    const system = (maxPrecision: string) => ({
      fields: ['os.arch'],
      maxPrecision,
      modes: ['synthetic']
    })
    expect(capabilitySatisfiesV1('host.device.state', device('standard'), device('coarse')))
      .toBe(true)
    expect(capabilitySatisfiesV1('host.device.state', device('coarse'), device('standard')))
      .toBe(false)
    expect(capabilitySatisfiesV1('host.system.basic', system('exact'), system('coarse')))
      .toBe(true)
    expect(() =>
      capabilitySatisfiesV1(
        'host.system.basic',
        system('standard'),
        system('coarse')
      )
    ).toThrow(CapabilityContractError)
  })

  it('selects the first fully satisfied anyOf branch and emits minimal authority', () => {
    const requirement = {
      anyOf: [
        { allOf: [ref('host.network.mock', network('mockOnly', ['https://api.example']))], branchId: 'mock' },
        { allOf: [ref('host.network.http', network('restricted', ['https://api.example']))], branchId: 'real' }
      ]
    }
    const selected = selectCapabilityBranchV1(requirement, [
      {
        constraints: network('restricted', ['https://api.example', 'https://other.example']),
        name: 'host.network.http',
        version: 1
      },
      { constraints: network('mockOnly', ['https://api.example']), name: 'host.network.mock', version: 1 }
    ], context)
    expect(selected?.branchId).toBe('mock')
    expect(selected?.authorityBindings).toEqual([
      expect.objectContaining({ capabilityName: 'host.network.mock', providerModule: 'host.network.mock' })
    ])
    expect(JSON.stringify(selected)).not.toContain('other.example')
  })

  it('meets duplicate capability refs and rejects empty/unknown branches', () => {
    const requirement = {
      anyOf: [{
        allOf: [
          ref('host.fs', fs([], ['read', 'write'])),
          ref('host.fs', fs(['src'], ['read']))
        ],
        branchId: 'fs-read'
      }]
    }
    const selected = selectCapabilityBranchV1(requirement, [{
      constraints: fs([], ['read', 'write']),
      name: 'host.fs',
      version: 1
    }], context)
    expect(selected?.bindings[0]?.constraints).toEqual({
      limits: fsLimits,
      roots: [{
        pathPrefixSegments: ['src'],
        rights: ['read'],
        rootId: 'workspace',
        symlinks: 'withinRoot'
      }]
    })
    expect(() => normalizeCapabilityRequirementV1({ anyOf: [] })).toThrow(CapabilityContractError)
    expect(() =>
      normalizeCapabilityRequirementV1({
        anyOf: [{ allOf: [{ constraints: {}, name: 'host.unknown', version: 1 }], branchId: 'x' }]
      })
    ).toThrow(CapabilityContractError)
  })
})
