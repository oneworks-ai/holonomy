import { describe, expect, it } from 'vitest'

import { LinuxProcessNetworkCapabilityBridgeV1 } from '../../../src/capability-runtime/index.js'
import type { CapabilityInvocationError } from '../../../src/capability-runtime/index.js'

const policy = {
  access: 'sandboxed' as const,
  environment: { allowedNames: [], maxValueBytes: 1024 },
  executables: [{ argumentBytes: 1024, executableId: 'curl' }],
  limits: {
    maxConcurrentProcesses: 1,
    maxExecutionTimeMs: 1000,
    maxOpenPipes: 3,
    maxProcessTreeDepth: 1,
    maxStderrBytes: 1024,
    maxStdinBytes: 1024,
    maxStdoutBytes: 1024,
    maxTotalProcesses: 1,
    maxWritableRootfsBytes: 0
  },
  mounts: [],
  network: {
    access: 'restricted' as const,
    endpoints: [{ hostname: 'api.example', ports: [443], transport: 'tls' as const }],
    maxSockets: 1,
    privateNetwork: 'deny' as const
  },
  shell: { access: 'none' as const }
}

const input = {
  environmentId: 'environment-1',
  executableId: 'curl',
  hostname: 'api.example',
  linuxPid: 17,
  policy,
  port: 443,
  processId: 31,
  processResourceId: 'process-resource-1',
  scope: 'processTree' as const,
  transport: 'tls' as const
}

describe('linux process network capability bridge', () => {
  it('forwards exact process attribution and endpoint authority into the Kernel', async () => {
    let request: Readonly<Record<string, unknown>> | undefined
    const bridge = new LinuxProcessNetworkCapabilityBridgeV1().bind(value => {
      request = value
      return Promise.resolve({
        authorized: true,
        generation: 2,
        invocationBindingDigest: '1'.repeat(64),
        resolution: {
          addresses: ['93.184.216.34'],
          evidenceDigest: '3'.repeat(64),
          expiresAtMonotonicMs: Number.MAX_SAFE_INTEGER,
          resolverGeneration: 2
        },
        semanticResourceDigest: '2'.repeat(64)
      })
    })
    await expect(bridge.authorize(input)).resolves.toEqual(expect.objectContaining({ authorized: true }))
    expect(request).toEqual({
      arguments: { hostname: 'api.example', port: 443, transport: 'tls' },
      member: 'authorizeProcessNetwork',
      mode: 'promise',
      module: 'holo:runtime',
      source: {
        environmentId: 'environment-1',
        environmentScope: 'processTree',
        executableId: 'curl',
        kind: 'linuxProcess',
        linuxPid: 17,
        processResourceId: 'process-resource-1',
        syntheticProcessId: 31
      }
    })
  })

  it('fails before the Kernel when Host policy does not expose the endpoint', async () => {
    const bridge = new LinuxProcessNetworkCapabilityBridgeV1().bind(() => {
      throw new Error('must not run')
    })
    const expected = { code: 'policy.denied' } satisfies Partial<CapabilityInvocationError>
    await expect(bridge.authorize({ ...input, port: 8443 })).rejects.toMatchObject(expected)
  })
})
