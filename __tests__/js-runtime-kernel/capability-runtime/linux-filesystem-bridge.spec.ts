import { LinuxFilesystemCapabilityBridgeV1 } from '@holonomyjs/capability-fs'
import {
  CapabilityInvocationError,
  CapabilityRuntimeInvocationKernelV1,
  validateFiniteJsonSchemaV1
} from '@holonomyjs/runtime/kernel'
import { describe, expect, it } from 'vitest'
import {
  linuxFilesystemSource,
  linuxOpenFlag
} from '../../../packages/capabilities/fs/src/kernel/linux-filesystem-bridge-support.js'
import { FS_PORTABLE_OPEN_FLAG_SCHEMA_V1 } from '../../../packages/runtime/src/kernel/registry-argument-schemas.js'
import { creation, policyV2, provider } from './broker-fixtures.js'

const input = Object.freeze({
  environmentId: 'test:1:v86',
  executableId: 'busybox.sh',
  linuxPid: 41,
  operation: 'lookup' as const,
  path: '/workspace/missing.txt',
  policy: Object.freeze({
    access: 'sandboxed' as const,
    environment: Object.freeze({ allowedNames: Object.freeze([]), maxValueBytes: 1024 }),
    executables: Object.freeze([
      Object.freeze({ argumentBytes: 1024, executableId: 'busybox.sh' })
    ]),
    limits: Object.freeze({
      maxConcurrentProcesses: 1,
      maxExecutionTimeMs: 1000,
      maxOpenPipes: 3,
      maxProcessTreeDepth: 1,
      maxStderrBytes: 1024,
      maxStdinBytes: 1024,
      maxStdoutBytes: 1024,
      maxTotalProcesses: 1,
      maxWritableRootfsBytes: 1024
    }),
    mounts: Object.freeze([
      Object.freeze({
        guestPath: '/workspace',
        rootId: 'workspace',
        rights: Object.freeze(['read' as const, 'write' as const])
      })
    ]),
    network: Object.freeze({ access: 'none' as const }),
    shell: Object.freeze({ access: 'none' as const })
  }),
  processId: 9,
  processResourceId: 'process-9',
  scope: 'processTree' as const
})

describe('linux filesystem capability Bridge v1', () => {
  it('routes pure chmod with typed expected kind and rejects mixed changes before invocation', async () => {
    const calls: Record<string, unknown>[] = []
    const bridge = new LinuxFilesystemCapabilityBridgeV1().bind(async request => {
      calls.push(request as Record<string, unknown>)
      return { kind: 'file', mode: 0o100644 }
    })
    await bridge.dispatch({ ...input, operation: 'setattr', mode: 0o644, expectedKind: 'file' })
    expect(calls[0]).toMatchObject({
      arguments: { path: 'holo-fs://workspace/missing.txt', mode: 0o644, readback: true, expectedKind: 'file' },
      member: 'chmod',
      module: 'node:fs/promises'
    })
    await bridge.dispatch({
      ...input,
      operation: 'setattr',
      handle: 'dir-1',
      handleKind: 'directory',
      mode: 0o700,
      expectedKind: 'directory'
    })
    expect(calls[1]).toMatchObject({
      arguments: { mode: 0o700, readback: true, expectedKind: 'directory' },
      bindingId: 'dir-1',
      member: 'directory.chmod',
      module: 'host.fs',
      resourceType: 'filesystem.directory-handle'
    })
    for (
      const change of [
        { mode: 0o4755 },
        { mode: 0o644, size: 1 },
        { mode: 0o644, atime: { kind: 'now' as const } },
        { mode: 0o644, handle: 'dir-1' },
        { mode: 0o644, handle: 'dir-1', handleKind: 'file' as const, expectedKind: 'directory' as const }
      ]
    ) {
      await expect(bridge.dispatch({ ...input, operation: 'setattr', ...change })).rejects.toMatchObject({
        errno: expect.any(Number)
      })
    }
    expect(calls).toHaveLength(2)
  })

  it('uses one opaque directory binding for OPENDIR, FSYNCDIR and RELEASEDIR', async () => {
    const calls: Record<string, unknown>[] = []
    const bridge = new LinuxFilesystemCapabilityBridgeV1().bind(async request => {
      calls.push(request as Record<string, unknown>)
      if (request.member === 'directory.open') {
        return {
          binding: { bindingId: 'dir-7', generation: 1 },
          entries: [{ name: 'child', kind: 'file' }],
          resourceType: 'filesystem.directory-handle'
        }
      }
      return {}
    })
    const base = { ...input, path: '/workspace' }
    await expect(bridge.dispatch({ ...base, operation: 'opendir' })).resolves.toEqual({
      handle: 'dir-7',
      entries: [{ name: 'child', kind: 'file' }]
    })
    await expect(bridge.dispatch({ ...base, operation: 'fsyncdir', handle: 'dir-7', datasync: false }))
      .resolves.toBeNull()
    await expect(bridge.dispatch({ ...base, operation: 'releasedir', handle: 'dir-7' }))
      .resolves.toBeNull()
    expect(calls.map(call => [call.module, call.member])).toEqual([
      ['host.fs', 'directory.open'],
      ['host.fs', 'directory.sync'],
      ['host.fs', 'directory.close']
    ])
    expect(calls[1]).toMatchObject({
      arguments: { dataOnly: false },
      bindingId: 'dir-7',
      resourceType: 'filesystem.directory-handle'
    })
    expect(calls[2]).toMatchObject({
      arguments: {},
      bindingId: 'dir-7',
      resourceType: 'filesystem.directory-handle'
    })
  })
  it('routes Linux-only timestamp readback through a registered result variant', async () => {
    const metadata = {
      atimeMs: 1_700_000_000_123,
      atimeNs: '1700000000123456789',
      birthtimeMs: 0,
      ctimeMs: 1_700_000_000_123,
      ctimeNs: '1700000000123456789',
      kind: 'file',
      mtimeMs: 1_700_000_000_987,
      mtimeNs: '1700000000987654321',
      size: 3
    }
    const seen: string[] = []
    const kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted: creation({
        'host.fs': provider('host.fs', 'sync', metadata, context => {
          seen.push(context.operation)
        })
      }),
      engine: 'node-vm',
      target: 'node',
      networkProvider: 'host.network',
      requestPrefix: 'setattr-readback'
    })
    const argumentsValue = {
      path: 'holo-fs://workspace/demo.txt',
      atime: { kind: 'now' },
      mtime: { kind: 'omit' },
      readback: true
    }
    try {
      await expect(kernel.invokeFromSource({
        arguments: argumentsValue,
        member: 'utimes',
        mode: 'promise',
        module: 'node:fs/promises',
        path: argumentsValue.path,
        source: linuxFilesystemSource(input)
      })).resolves.toMatchObject(metadata)
      const guest = JSON.parse(
        await kernel.invoke(JSON.stringify({
          arguments: argumentsValue,
          member: 'utimes',
          mode: 'promise',
          module: 'node:fs/promises',
          path: argumentsValue.path
        }))
      )
      expect(guest).toMatchObject({ error: { code: 'EACCES' }, ok: false })
      expect(seen).toEqual(['filesystem.metadata.utimes'])
    } finally {
      kernel.close()
    }
  })
  it('preserves the closed capability code and errno for a missing Host path', async () => {
    const bridge = new LinuxFilesystemCapabilityBridgeV1().bind(async () => {
      throw new CapabilityInvocationError('resource.not_found', 'filesystem.metadata.stat')
    })

    await expect(bridge.dispatch(input)).rejects.toMatchObject({
      code: 'resource.not_found',
      errno: 2
    })
  })

  it('preserves Linux open intent and separates admission rights from handle access', () => {
    const normalized = (access: 'read' | 'write' | 'readWrite', values = {}) => ({
      kind: 'portable-open-v1',
      access,
      create: false,
      exclusive: false,
      truncate: false,
      append: false,
      ...values
    })
    expect(linuxOpenFlag(0)).toEqual({ flag: normalized('read'), rights: ['read'] })
    expect(linuxOpenFlag(1)).toEqual({ flag: normalized('write'), rights: ['write'] })
    expect(linuxOpenFlag(2)).toEqual({ flag: normalized('readWrite'), rights: ['read', 'write'] })
    expect(linuxOpenFlag(0x40)).toEqual({
      flag: normalized('read', { create: true }),
      rights: ['read', 'write']
    })
    expect(linuxOpenFlag(0x41)).toEqual({ flag: normalized('write', { create: true }), rights: ['write'] })
    expect(linuxOpenFlag(0x201)).toEqual({ flag: normalized('write', { truncate: true }), rights: ['write'] })
    expect(linuxOpenFlag(0x401)).toEqual({ flag: normalized('write', { append: true }), rights: ['write'] })
    expect(linuxOpenFlag(0x241)).toEqual({
      flag: normalized('write', { create: true, truncate: true }),
      rights: ['write']
    })
    expect(linuxOpenFlag(0x2C2)).toEqual({
      flag: normalized('readWrite', { create: true, exclusive: true, truncate: true }),
      rights: ['read', 'write']
    })
    expect(linuxOpenFlag(0x641)).toEqual({
      flag: normalized('write', { create: true, truncate: true, append: true }),
      rights: ['write']
    })
    expect(linuxOpenFlag(0x601)).toEqual({
      flag: normalized('write', { truncate: true, append: true }),
      rights: ['write']
    })
    for (const flags of [3, 0x80, 0x200, 0x400, 0x1000, 0x20000]) {
      expect(() => linuxOpenFlag(flags)).toThrowError(expect.objectContaining({ errno: 22 }))
    }
  })

  it('rejects illegal portable combinations in the machine schema before Provider I/O', async () => {
    const valid = linuxOpenFlag(0x641).flag
    expect(validateFiniteJsonSchemaV1(FS_PORTABLE_OPEN_FLAG_SCHEMA_V1, valid)).toBe(true)
    const illegal = [
      { ...valid, exclusive: true, create: false },
      { ...valid, access: 'read' },
      { ...valid, access: 'read', truncate: false }
    ]
    for (const flag of illegal) {
      expect(validateFiniteJsonSchemaV1(FS_PORTABLE_OPEN_FLAG_SCHEMA_V1, flag)).toBe(false)
    }
    let invoked = 0
    const kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted: creation({
        'host.fs': provider('host.fs', 'sync', {}, () => {
          invoked++
        })
      }),
      engine: 'node-vm',
      target: 'node',
      networkProvider: 'host.network',
      requestPrefix: 'portable-schema'
    })
    try {
      for (const flag of illegal) {
        await expect(kernel.invokeFromSource({
          arguments: { path: 'holo-fs://workspace/demo.txt', flag },
          member: 'open',
          mode: 'promise',
          module: 'node:fs/promises',
          path: 'holo-fs://workspace/demo.txt',
          source: linuxFilesystemSource(input)
        })).rejects.toMatchObject({ code: 'argument.invalid' })
      }
      expect(invoked).toBe(0)
    } finally {
      kernel.close()
    }
  })

  it('admits portable flags only from an attributed Linux source', async () => {
    let invoked = 0
    const kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted: creation({
        'host.fs': provider('host.fs', 'sync', {}, () => {
          invoked++
        })
      }),
      engine: 'node-vm',
      target: 'node',
      networkProvider: 'host.network',
      requestPrefix: 'portable-open'
    })
    try {
      const guest = JSON.parse(
        await kernel.invoke(JSON.stringify({
          arguments: { path: 'holo-fs://workspace/demo.txt', flag: linuxOpenFlag(0x41).flag },
          member: 'open',
          mode: 'promise',
          module: 'node:fs/promises',
          path: 'holo-fs://workspace/demo.txt'
        }))
      )
      expect(guest).toMatchObject({ error: { code: 'EACCES' }, ok: false })
      expect(invoked).toBe(0)
    } finally {
      kernel.close()
    }
  })

  it('requires write authority to create a read-only Linux handle', async () => {
    let invoked = 0
    const policy = policyV2()
    if (policy.filesystem.access !== 'sandboxed') throw new Error('Expected sandboxed fixture')
    Object.assign(policy.filesystem.roots[0]!, { rights: ['read'] })
    const kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted: creation(
        {
          'host.fs': provider('host.fs', 'sync', {}, () => {
            invoked++
          })
        },
        undefined,
        policy
      ),
      engine: 'node-vm',
      target: 'node',
      networkProvider: 'host.network',
      requestPrefix: 'portable-create'
    })
    try {
      const bridge = new LinuxFilesystemCapabilityBridgeV1().bind(input => kernel.invokeFromSource(input))
      await expect(bridge.dispatch({ ...input, operation: 'open', flags: 0x40 })).rejects.toMatchObject({
        code: 'policy.denied',
        errno: 13
      })
      expect(invoked).toBe(0)
    } finally {
      kernel.close()
    }
  })
})
