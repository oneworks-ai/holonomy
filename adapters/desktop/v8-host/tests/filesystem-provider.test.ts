import { describe, expect, it } from 'vitest'

import { canonicalizeFilesystemResource } from '../../../../packages/runtime/src/kernel/index.ts'

import { createNativeProviders } from '../bootstrap/providers.mjs'

const constraints = (prefix: readonly string[] = []) => ({
  limits: {
    maxDirectoryEntries: 32,
    maxOpenHandles: 8,
    maxQueuedEvents: 8,
    maxReadBytes: 4096,
    maxWatchers: 2,
    maxWriteBytes: 4096
  },
  roots: [{
    pathPrefixSegments: prefix,
    rights: ['read'],
    rootId: 'workspace',
    symlinks: 'withinRoot'
  }]
})

const authority = (prefix: readonly string[] = []) => ({
  bindings: [{ constraints: constraints(prefix), providerModule: 'host.fs' }],
  complete: (value: unknown) => value
})

describe('desktop native filesystem resolution provider', () => {
  it('closes a pinned directory when result delivery throws', () => {
    const calls: Record<string, unknown>[] = []
    const provider = createNativeProviders({
      filesystem(encoded: string) {
        const input = JSON.parse(encoded) as Record<string, unknown>
        calls.push(input)
        return JSON.stringify(
          input.kind === 'invoke'
            ? { ok: true, value: { bindingId: 'dir-10', entries: [] } }
            : { ok: true, value: {} }
        )
      }
    }, { fields: {} }).get('host.fs')!
    const requested = canonicalizeFilesystemResource('holo-fs://workspace/folder', 'folder')
    const granted = {
      bindings: [{
        constraints: { ...constraints(), roots: [{ ...constraints().roots[0], rights: ['list'] }] },
        providerModule: 'host.fs'
      }],
      complete() {
        throw new Error('delivery failed')
      }
    }
    expect(() =>
      provider.invoke({
        arguments: { path: 'holo-fs://workspace/folder' },
        module: 'host.fs',
        operation: 'filesystem.directory.open',
        resource: { requested },
        runtime: { generation: 1 },
        source: { kind: 'linuxProcess' }
      } as never, granted as never)
    ).toThrow('delivery failed')
    expect(calls.map(call => call.kind)).toEqual(['invoke', 'close'])
    expect(calls[1]?.bindingId).toBe('dir-10')
  })

  it('drops only resolved virtual-fd arguments before native handle I/O', () => {
    const calls: Record<string, unknown>[] = []
    const provider = createNativeProviders({
      filesystem(encoded: string) {
        calls.push(JSON.parse(encoded))
        return JSON.stringify({ ok: true, value: {} })
      }
    }, { fields: {} }).get('host.fs')!
    const requested = canonicalizeFilesystemResource('holo-fs://workspace/file', 'file')
    const writable = {
      bindings: [{
        constraints: {
          ...constraints(),
          roots: [{ ...constraints().roots[0], rights: ['read', 'write', 'chmod'] }]
        },
        providerModule: 'host.fs'
      }],
      complete: (value: unknown) => value
    }
    const base = {
      module: 'node:fs',
      resource: { requested, inheritedBindingId: 'fd-10' },
      runtime: { generation: 1 }
    }
    const inputs = [
      ['filesystem.metadata.utimes', {
        fd: 7,
        atime: { kind: 'set', seconds: 1, nanoseconds: 0 },
        mtime: { kind: 'set', seconds: 2, nanoseconds: 0 }
      }, ['atime', 'mtime']],
      ['filesystem.metadata.chmod', { fd: 7, mode: 0o600 }, ['mode']],
      ['filesystem.file.truncate', { fd: 7, len: 2 }, ['len']],
      ['filesystem.file.sync', { fd: 7 }, []],
      ['filesystem.file.datasync', { fd: 7 }, []]
    ] as const
    for (const [operation, args] of inputs) {
      provider.invoke({ ...base, operation, arguments: args } as never, writable as never)
    }
    expect(calls).toHaveLength(5)
    for (const [index, [, , expectedKeys]] of inputs.entries()) {
      expect(calls[index]?.bindingId).toBe('fd-10')
      expect(Object.keys(calls[index]?.arguments as Record<string, unknown>).sort()).toEqual([...expectedKeys].sort())
    }
    expect(() =>
      provider.invoke({
        ...base,
        resource: { requested },
        operation: 'filesystem.file.sync',
        arguments: { fd: 7 }
      } as never, writable as never)
    ).toThrowError(expect.objectContaining({ code: 'resource.stale' }))
    expect(calls).toHaveLength(5)
  })

  it('requires fresh chmod authority for retained file and directory targets', () => {
    const calls: Record<string, unknown>[] = []
    const provider = createNativeProviders({
      filesystem(encoded: string) {
        calls.push(JSON.parse(encoded))
        return JSON.stringify({ ok: true, value: {} })
      }
    }, { fields: {} }).get('host.fs')!
    const requested = canonicalizeFilesystemResource('holo-fs://workspace/value', 'value')
    const context = {
      arguments: { mode: 0o600 },
      module: 'node:fs/promises',
      operation: 'filesystem.metadata.chmod',
      resource: { requested, inheritedBindingId: 'fd-10' },
      runtime: { generation: 1 }
    }
    const withRights = (rights: string[]) => ({
      bindings: [{
        constraints: { ...constraints(), roots: [{ ...constraints().roots[0], rights }] },
        providerModule: 'host.fs'
      }],
      complete: (value: unknown) => value
    })
    expect(() => provider.invoke(context as never, withRights(['read', 'write']) as never))
      .toThrowError(expect.objectContaining({ code: 'capability.denied' }))
    expect(calls).toEqual([])
    provider.invoke(context as never, withRights(['chmod']) as never)
    expect(calls[0]).toMatchObject({
      arguments: { mode: 0o600 },
      bindingId: 'fd-10',
      operation: 'filesystem.metadata.chmod'
    })
    expect(() =>
      provider.invoke(
        { ...context, arguments: { mode: 0o700, readback: true } } as never,
        withRights(['chmod']) as never
      )
    ).toThrowError(expect.objectContaining({ code: 'capability.denied' }))
    expect(calls).toHaveLength(1)
    provider.invoke(
      {
        ...context,
        arguments: { mode: 0o700, readback: true },
        module: 'host.fs',
        resource: { requested, inheritedBindingId: 'dir-11' },
        source: { kind: 'linuxProcess' }
      } as never,
      withRights(['chmod']) as never
    )
    expect(calls[1]).toMatchObject({
      arguments: { mode: 0o700, readback: true },
      bindingId: 'dir-11',
      operation: 'filesystem.metadata.chmod'
    })
  })

  it('keeps the Linux-only expected chmod kind after virtual-fd resolution', () => {
    const calls: Record<string, unknown>[] = []
    const provider = createNativeProviders({
      filesystem(encoded: string) {
        calls.push(JSON.parse(encoded))
        return JSON.stringify({ ok: true, value: {} })
      }
    }, { fields: {} }).get('host.fs')!
    const requested = canonicalizeFilesystemResource('holo-fs://workspace/file', 'file')
    const granted = {
      bindings: [{
        constraints: { ...constraints(), roots: [{ ...constraints().roots[0], rights: ['chmod'] }] },
        providerModule: 'host.fs'
      }],
      complete: (value: unknown) => value
    }
    const context = {
      arguments: { fd: 7, mode: 0o600, readback: true, expectedKind: 'file' },
      module: 'node:fs',
      operation: 'filesystem.metadata.chmod',
      resource: { requested, inheritedBindingId: 'fd-10' },
      runtime: { generation: 1 },
      source: { kind: 'linuxProcess' }
    }
    provider.invoke(context as never, granted as never)
    expect(calls[0]).toMatchObject({
      arguments: { mode: 0o600, readback: true, expectedKind: 'file' },
      bindingId: 'fd-10'
    })
    expect(Object.hasOwn(calls[0]?.arguments as object, 'fd')).toBe(false)
    expect(() => provider.invoke({ ...context, source: undefined } as never, granted as never))
      .toThrowError(expect.objectContaining({ code: 'capability.denied' }))
    expect(() =>
      provider.invoke(
        { ...context, arguments: { fd: 7, mode: 0o600, expectedKind: 'file' } } as never,
        granted as never
      )
    ).toThrowError(expect.objectContaining({ code: 'capability.denied' }))
    expect(() =>
      provider.invoke(
        { ...context, arguments: { ...context.arguments, expectedKind: 'symlink' } } as never,
        granted as never
      )
    ).toThrowError(expect.objectContaining({ code: 'argument.invalid' }))
    expect(() =>
      provider.invoke(
        {
          ...context,
          arguments: { path: 'holo-fs://workspace/file', expectedKind: 'file' },
          operation: 'filesystem.metadata.stat'
        } as never,
        granted as never
      )
    ).toThrowError(expect.objectContaining({ code: 'argument.invalid' }))
    expect(calls).toHaveLength(1)
  })

  it('tries separately authorized access bindings and keeps their rights separate', () => {
    const calls: Record<string, unknown>[] = []
    const native = {
      filesystem(encoded: string) {
        const input = JSON.parse(encoded) as Record<string, unknown>
        calls.push(input)
        const roots = (input.constraints as { roots: { rights: string[] }[] }).roots
        return JSON.stringify(
          roots[0]?.rights.includes('read')
            ? { ok: true, value: {} }
            : { ok: false, code: 'capability.denied' }
        )
      }
    }
    const provider = createNativeProviders(native, { fields: {} }).get('host.fs')!
    const requested = canonicalizeFilesystemResource('holo-fs://workspace/file', 'file')
    const listOnly = { ...constraints(), roots: [{ ...constraints().roots[0], rights: ['list'] }] }
    const readOnly = constraints()
    const split = {
      bindings: [listOnly, readOnly].map(value => ({ constraints: value, providerModule: 'host.fs' })),
      complete: (value: unknown) => value
    }
    const context = {
      arguments: { path: 'holo-fs://workspace/file', mode: 4 },
      module: 'node:fs/promises',
      operation: 'filesystem.metadata.access',
      resource: { requested },
      runtime: { generation: 1 }
    }
    provider.invoke(context as never, split as never)
    expect(calls.map(call => (call.constraints as typeof listOnly).roots[0]?.rights))
      .toEqual([['list'], ['read']])

    calls.length = 0
    const writeOnly = { ...constraints(), roots: [{ ...constraints().roots[0], rights: ['write'] }] }
    const noCombinedGrant = {
      ...split,
      bindings: [readOnly, writeOnly].map(value => ({ constraints: value, providerModule: 'host.fs' }))
    }
    expect(() =>
      provider.invoke({ ...context, arguments: { ...context.arguments, mode: 6 } } as never, noCombinedGrant as never)
    )
      .toThrowError(expect.objectContaining({ code: 'capability.denied' }))
    expect(calls).toEqual([])
  })

  it('requires create authority for a read-only portable Linux handle and forwards the exact intent', () => {
    const calls: Record<string, unknown>[] = []
    const provider = createNativeProviders({
      filesystem(encoded: string) {
        calls.push(JSON.parse(encoded))
        return JSON.stringify({ ok: true, value: { fd: 10, bindingId: 'fd-10' } })
      }
    }, { fields: {} }).get('host.fs')!
    const flag = {
      kind: 'portable-open-v1',
      access: 'read',
      create: true,
      exclusive: false,
      truncate: false,
      append: false
    }
    const requested = canonicalizeFilesystemResource('holo-fs://workspace/value', 'value')
    const context = {
      arguments: { path: 'holo-fs://workspace/value', flag },
      module: 'node:fs/promises',
      operation: 'filesystem.file.open',
      resource: { requested },
      runtime: { generation: 1 },
      source: { kind: 'linuxProcess' }
    }
    const readOnly = authority()
    expect(() => provider.invoke(context as never, readOnly as never))
      .toThrowError(expect.objectContaining({ code: 'capability.denied' }))
    expect(calls).toEqual([])
    const writable = {
      bindings: [{
        constraints: {
          ...constraints(),
          roots: [{ ...constraints().roots[0], rights: ['read', 'write'] }]
        },
        providerModule: 'host.fs'
      }],
      complete: (value: unknown) => value
    }
    provider.invoke(context as never, writable as never)
    expect(calls[0]).toMatchObject({
      arguments: { flag },
      operation: 'filesystem.file.open'
    })
    const truncateAppend = { ...flag, access: 'write', truncate: true, append: true }
    provider.invoke(
      { ...context, arguments: { ...context.arguments, flag: truncateAppend } } as never,
      writable as never
    )
    expect(calls[1]).toMatchObject({ arguments: { flag: truncateAppend } })
    expect(() => provider.invoke({ ...context, source: undefined } as never, writable as never))
      .toThrowError(expect.objectContaining({ code: 'capability.denied' }))
    expect(calls).toHaveLength(2)
  })

  it('forwards positioned continuations only from a trusted Linux process invocation', () => {
    const calls: Record<string, unknown>[] = []
    const provider = createNativeProviders({
      filesystem(encoded: string) {
        calls.push(JSON.parse(encoded))
        return JSON.stringify({ ok: true, value: 'SAFE' })
      }
    }, { fields: {} }).get('host.fs')!
    const requested = canonicalizeFilesystemResource('holo-fs://workspace/value', 'value')
    const context = {
      arguments: {},
      module: 'node:fs/promises',
      operation: 'filesystem.file.read',
      providerData: { kind: 'positionedRead', offset: 4, size: 2 },
      resource: { requested, inheritedBindingId: 'file-1' },
      runtime: { generation: 1 }
    }
    provider.invoke(context as never, authority() as never)
    expect(calls[0]?.positioned).toBeUndefined()
    provider.invoke({ ...context, source: { kind: 'linuxProcess' } } as never, authority() as never)
    expect(calls[1]?.positioned).toEqual(context.providerData)
  })

  it('carries the Broker-admitted resolved identity and single-use ticket into native execute', () => {
    const calls: Record<string, unknown>[] = []
    const native = {
      filesystem(encoded: string) {
        const input = JSON.parse(encoded) as Record<string, unknown>
        calls.push(input)
        if (input.kind === 'prepareResolution') {
          return JSON.stringify({
            ok: true,
            value: {
              evidence: {
                ancestorIdentityDigests: ['a'.repeat(64)],
                kind: 'filesystemTarget',
                rootId: 'workspace',
                targetIdentityDigest: 'b'.repeat(64),
                targetType: 'file'
              },
              required: true,
              resolvedSegments: ['target', 'value'],
              ticket: 'resolution-1'
            }
          })
        }
        if (input.kind === 'verifyResolution') {
          return JSON.stringify({
            ok: true,
            value: {
              evidence: {
                ancestorIdentityDigests: ['a'.repeat(64)],
                kind: 'filesystemTarget',
                rootId: 'workspace',
                targetIdentityDigest: 'b'.repeat(64),
                targetType: 'file'
              },
              resolvedSegments: ['target', 'value']
            }
          })
        }
        if (input.kind === 'invoke') return JSON.stringify({ ok: true, value: 'SAFE' })
        return JSON.stringify({ ok: true, value: {} })
      }
    }
    const provider = createNativeProviders(native, { fields: {} }).get('host.fs')!
    const requested = canonicalizeFilesystemResource(
      'holo-fs://workspace/alias/value',
      'requested filesystem target'
    )
    const resolved = canonicalizeFilesystemResource(
      'holo-fs://workspace/target/value',
      'resolved filesystem target'
    )
    const context = {
      arguments: { options: { encoding: 'utf8' } },
      module: 'node:fs',
      operation: 'filesystem.file.read',
      resource: { requested },
      runtime: { generation: 1 }
    }
    const plan = provider.preflight!(context as never, authority() as never) as Exclude<
      ReturnType<NonNullable<typeof provider.preflight>>,
      Promise<unknown> | undefined
    >
    expect(plan.requests[0]?.resolved.semanticResourceDigest).toBe(resolved.semanticResourceDigest)
    expect(plan.requests[0]?.verify().resolved.semanticResourceDigest).toBe(
      resolved.semanticResourceDigest
    )
    const terminal = plan.execute(
      { ...context, resource: { requested, resolved } } as never,
      [authority() as never],
      [{ resolvedSemanticDigest: resolved.semanticResourceDigest }] as never
    )
    expect(terminal).toMatchObject({ value: 'SAFE' })
    expect(calls.find(call => call.kind === 'invoke')).toMatchObject({
      pathSegments: ['target', 'value'],
      requestedSegments: ['alias', 'value'],
      resolutionTicket: 'resolution-1'
    })
    plan.dispose?.()
  })

  it('does not let requested alias authority stand in for resolved target authority', () => {
    const native = {
      filesystem(encoded: string) {
        const input = JSON.parse(encoded) as Record<string, unknown>
        if (input.kind === 'prepareResolution') {
          return JSON.stringify({
            ok: true,
            value: {
              evidence: {
                ancestorIdentityDigests: ['a'.repeat(64)],
                kind: 'filesystemTarget',
                rootId: 'workspace',
                targetIdentityDigest: 'b'.repeat(64),
                targetType: 'file'
              },
              required: true,
              resolvedSegments: ['target', 'value'],
              ticket: 'resolution-1'
            }
          })
        }
        return JSON.stringify({ ok: true, value: {} })
      }
    }
    const provider = createNativeProviders(native, { fields: {} }).get('host.fs')!
    const requested = canonicalizeFilesystemResource('holo-fs://workspace/alias/value', 'requested')
    const resolved = canonicalizeFilesystemResource('holo-fs://workspace/target/value', 'resolved')
    const context = {
      arguments: { options: { encoding: 'utf8' } },
      module: 'node:fs',
      operation: 'filesystem.file.read',
      resource: { requested },
      runtime: { generation: 1 }
    }
    const plan = provider.preflight!(context as never, authority(['alias']) as never) as Exclude<
      ReturnType<NonNullable<typeof provider.preflight>>,
      Promise<unknown> | undefined
    >
    expect(() =>
      plan.execute(
        { ...context, resource: { requested, resolved } } as never,
        [authority(['alias']) as never],
        [{ resolvedSemanticDigest: resolved.semanticResourceDigest }] as never
      )
    ).toThrowError(expect.objectContaining({ code: 'capability.denied' }))
    plan.dispose?.()
  })
})
