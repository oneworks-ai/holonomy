import { describe, expect, it } from 'vitest'

import {
  bindInvocationResource,
  canonicalDigest,
  canonicalizeDeviceFieldResource,
  canonicalizeFilesystemResource,
  canonicalizeNetworkResource,
  canonicalizeProcessNetworkEndpointResource,
  canonicalizeProgramExecutableResource,
  canonicalizeShellExecutableResource
} from '../../../src/capability-runtime/index.js'

const digest = (label: string) => canonicalDigest(['test', label])

describe('canonical capability resources', () => {
  it('separates semantic identity from invocation identity', () => {
    const first = canonicalizeNetworkResource(
      'https://api.example/profile?scope=basic',
      'GET',
      digest('query'),
      'Profile'
    )
    const relabeled = canonicalizeNetworkResource(
      'https://api.example/profile?scope=basic',
      'GET',
      digest('query'),
      'Different UI label'
    )
    expect(relabeled.semanticResourceDigest).toBe(first.semanticResourceDigest)

    const common = {
      authorityDigest: digest('authority'),
      capabilityBindingDigest: digest('capability'),
      generation: 3,
      operation: 'network.fetch.request',
      processId: 'process-1',
      semanticResourceDigest: first.semanticResourceDigest
    }
    const requestOne = bindInvocationResource({ ...common, requestId: 'request-1' })
    const requestTwo = bindInvocationResource({ ...common, requestId: 'request-2' })
    expect(requestOne.semanticResourceDigest).toBe(requestTwo.semanticResourceDigest)
    expect(requestOne.invocationBindingDigest).not.toBe(requestTwo.invocationBindingDigest)
  })

  it('canonicalizes filesystem by root and segments rather than string prefix', () => {
    const first = canonicalizeFilesystemResource('holo-fs://workspace/src/main.js', 'main.js')
    const same = canonicalizeFilesystemResource('holo-fs://workspace/src/main.js', 'renamed label')
    const sibling = canonicalizeFilesystemResource('holo-fs://workspace2/src/main.js', 'main.js')

    expect(first.pathSegments).toEqual(['src', 'main.js'])
    expect(first.semanticResourceDigest).toBe(same.semanticResourceDigest)
    expect(first.semanticResourceDigest).not.toBe(sibling.semanticResourceDigest)
    expect(() => canonicalizeFilesystemResource('holo-fs://workspace/src/%2e%2e/secret', 'x'))
      .toThrow()
  })

  it('locks device field privacy tier to the closed operation registry', () => {
    expect(canonicalizeDeviceFieldResource(
      'device.connectivity.wifi.identity.read',
      'wifi.identity',
      3,
      'Wi-Fi identity'
    )).toEqual(expect.objectContaining({
      kind: 'deviceField',
      privacyTier: 3
    }))
    expect(() =>
      canonicalizeDeviceFieldResource(
        'device.connectivity.wifi.identity.read',
        'wifi.identity',
        1,
        'Wi-Fi identity'
      )
    ).toThrow()
  })

  it('never collides program argv and shell command authority keys', () => {
    const common = {
      cwdSemanticResourceDigest: digest('cwd'),
      environmentNamesDigest: digest('environment'),
      environmentScope: 'processTree' as const,
      label: 'git status',
      stdioDigest: digest('stdio')
    }
    const program = canonicalizeProgramExecutableResource({
      ...common,
      argvDigest: digest('status'),
      executableId: 'git'
    })
    const shell = canonicalizeShellExecutableResource({
      ...common,
      commandDigest: digest('status'),
      shellExecutableId: 'git'
    })
    expect(program.invocation).toBe('program')
    expect(shell.invocation).toBe('shell')
    expect(program.semanticResourceDigest).not.toBe(shell.semanticResourceDigest)

    const runtimeEnvironment = canonicalizeProgramExecutableResource({
      ...common,
      argvDigest: digest('status'),
      environmentScope: 'runtime',
      executableId: 'git'
    })
    expect(runtimeEnvironment.semanticResourceDigest).not.toBe(program.semanticResourceDigest)
  })

  it('canonicalizes Linux process network endpoints independently from UI labels', () => {
    const endpoint = canonicalizeProcessNetworkEndpointResource({
      hostname: 'api.example',
      label: 'Package registry',
      port: 443,
      transport: 'tls'
    })
    const relabeled = canonicalizeProcessNetworkEndpointResource({
      hostname: 'api.example',
      label: 'Different prompt',
      port: 443,
      transport: 'tls'
    })
    expect(endpoint).toEqual(expect.objectContaining({
      hostname: 'api.example',
      kind: 'processNetworkEndpoint',
      port: 443,
      transport: 'tls'
    }))
    expect(relabeled.semanticResourceDigest).toBe(endpoint.semanticResourceDigest)
    expect(
      canonicalizeProcessNetworkEndpointResource({
        hostname: 'api.example',
        label: 'HTTP',
        port: 80,
        transport: 'tcp'
      }).semanticResourceDigest
    ).not.toBe(endpoint.semanticResourceDigest)
  })

  it('fences invocation bindings by generation and authority', () => {
    const semanticResourceDigest = digest('resource')
    const common = {
      authorityDigest: digest('authority'),
      capabilityBindingDigest: digest('capability'),
      generation: 1,
      operation: 'filesystem.file.read',
      processId: 'process-1',
      requestId: 'request-1',
      semanticResourceDigest
    }
    const first = bindInvocationResource(common)
    expect(bindInvocationResource({ ...common, generation: 2 }).invocationBindingDigest)
      .not.toBe(first.invocationBindingDigest)
    expect(bindInvocationResource({ ...common, authorityDigest: digest('other') }).invocationBindingDigest)
      .not.toBe(first.invocationBindingDigest)
  })
})
