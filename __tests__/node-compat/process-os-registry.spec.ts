import { describe, expect, it } from 'vitest'

import { DEFAULT_MAX_STDIO_CHUNK_BYTES, resolveNodeCoreCompatOptions } from '../../src/node-compat/options.js'
import {
  createNodeCoreSyntheticModuleBindings,
  createNodeCoreSyntheticModules
} from '../../src/node-compat/registry.js'
import type { NodeCoreCompatOptions, RuntimeOsSnapshot } from '../../src/node-compat/types.js'

import { createNodeCoreOptions } from './fixtures.js'

describe('node:process, node:os and registry', () => {
  it('creates the complete frozen synthetic-module registry', () => {
    const modules = createNodeCoreSyntheticModules(createNodeCoreOptions())
    expect(Object.keys(modules).sort()).toEqual([
      'node:buffer',
      'node:events',
      'node:os',
      'node:path',
      'node:process',
      'node:url'
    ])
    expect(Object.isFrozen(modules)).toBe(true)
    for (const module of Object.values(modules)) {
      expect(Object.isFrozen(module)).toBe(true)
    }
  })

  it('derives loader descriptors strictly from namespace keys', () => {
    const bindings = createNodeCoreSyntheticModuleBindings(createNodeCoreOptions())
    expect(Object.isFrozen(bindings)).toBe(true)
    for (const binding of Object.values(bindings)) {
      expect(binding.descriptor.exportNames).toStrictEqual(
        Object.keys(binding.namespace)
      )
      expect(Object.keys(binding.descriptor)).toStrictEqual(['exportNames'])
      expect(Object.isFrozen(binding.descriptor.exportNames)).toBe(true)
      expect(Object.isFrozen(binding)).toBe(true)
    }
  })

  it('freezes cloned process values and binds path resolution to cwd', () => {
    const options = createNodeCoreOptions()
    const modules = createNodeCoreSyntheticModules(options)
    const runtimeProcess = modules['node:process'].default
    ;(options.process.env as Record<string, string>).NODE_ENV = 'changed'
    ;(options.process.argv as string[])[0] = 'changed'
    expect(runtimeProcess.env).toEqual({ NODE_ENV: 'production' })
    expect(runtimeProcess.argv[0]).toBe('/app/bin/node')
    expect(runtimeProcess.cwd()).toBe('/app/project')
    expect(Object.isFrozen(runtimeProcess.env)).toBe(true)
    expect(Object.isFrozen(runtimeProcess.argv)).toBe(true)
    expect(modules['node:path'].resolve('plugin.mjs')).toBe(
      '/app/project/plugin.mjs'
    )
  })

  it('supports process events and passes text or bytes directly to stdio', () => {
    const writes: Array<{ chunk: string | Uint8Array; stream: 'stderr' | 'stdout' }> = []
    const runtimeProcess = createNodeCoreSyntheticModules(
      createNodeCoreOptions(writes)
    )['node:process'].default
    const events: unknown[] = []
    runtimeProcess.once('ready', value => events.push(value))
    runtimeProcess.emit('ready', 1)
    runtimeProcess.emit('ready', 2)
    const bytes = new Uint8Array([1, 2, 3])
    runtimeProcess.stdout.write('hello')
    runtimeProcess.stderr.write(bytes)
    bytes[0] = 99
    expect(events).toEqual([1])
    expect(writes).toEqual([
      { chunk: 'hello', stream: 'stdout' },
      { chunk: new Uint8Array([1, 2, 3]), stream: 'stderr' }
    ])
    expect(writes[1]?.chunk).not.toBe(bytes)
  })

  it('freezes a validated default or injected stdio chunk limit', () => {
    const defaults = resolveNodeCoreCompatOptions(createNodeCoreOptions())
    expect(defaults.maxStdioChunkBytes).toBe(DEFAULT_MAX_STDIO_CHUNK_BYTES)
    expect(Object.isFrozen(defaults)).toBe(true)

    const configured = resolveNodeCoreCompatOptions({
      ...createNodeCoreOptions(),
      maxStdioChunkBytes: 17
    })
    expect(configured.maxStdioChunkBytes).toBe(17)
    expect(Object.isFrozen(configured)).toBe(true)

    for (
      const maxStdioChunkBytes of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY
      ]
    ) {
      expect(() =>
        createNodeCoreSyntheticModules({
          ...createNodeCoreOptions(),
          maxStdioChunkBytes
        })
      ).toThrowError(expect.objectContaining({
        code: 'ERR_HOLONOMY_INVALID_ARGUMENT'
      }))
    }
    const nullLimitOptions = {
      ...createNodeCoreOptions(),
      maxStdioChunkBytes: null
    } as unknown as NodeCoreCompatOptions
    expect(() => createNodeCoreSyntheticModules(nullLimitOptions)).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_INVALID_ARGUMENT' })
    )
  })

  it('rejects oversized stdio before copying or invoking the provider', () => {
    const writes: Array<string | Uint8Array> = []
    const runtimeProcess = createNodeCoreSyntheticModules({
      ...createNodeCoreOptions(),
      maxStdioChunkBytes: 3,
      stdio: {
        write: (_stream, chunk) => {
          writes.push(chunk)
        }
      }
    })['node:process'].default
    const callbackErrors: unknown[] = []

    expect(() =>
      runtimeProcess.stdout.write(
        new Uint8Array([1, 2, 3, 4]),
        error => callbackErrors.push(error)
      )
    ).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_RESOURCE_EXHAUSTED'
    }))
    expect(() => runtimeProcess.stderr.write('你好')).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_RESOURCE_EXHAUSTED' })
    )
    expect(writes).toEqual([])
    expect(callbackErrors).toEqual([])

    expect(runtimeProcess.stdout.write(new Uint8Array([1, 2, 3]))).toBe(true)
    expect(writes).toEqual([new Uint8Array([1, 2, 3])])
  })

  it('uses intrinsic byte lengths before admitting hostile Uint8Array subclasses', () => {
    let fakeByteLengthReads = 0
    class FakeByteLengthBytes extends Uint8Array {
      override get byteLength(): number {
        fakeByteLengthReads += 1
        return 0
      }
    }
    const providerCalls: Array<string | Uint8Array> = []
    const callbackCalls: unknown[] = []
    const runtimeProcess = createNodeCoreSyntheticModules({
      ...createNodeCoreOptions(),
      maxStdioChunkBytes: 3,
      stdio: {
        write: (_stream, chunk) => {
          providerCalls.push(chunk)
        }
      }
    })['node:process'].default

    expect(() =>
      runtimeProcess.stdout.write(
        new FakeByteLengthBytes([1, 2, 3, 4]),
        error => callbackCalls.push(error)
      )
    ).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_RESOURCE_EXHAUSTED'
    }))
    expect(fakeByteLengthReads).toBe(0)
    expect(providerCalls).toEqual([])
    expect(callbackCalls).toEqual([])
  })

  it('uses intrinsic UTF-8 counting before admitting strings', () => {
    const originalCharCodeAt = String.prototype.charCodeAt
    let overriddenCalls = 0
    const providerCalls: Array<string | Uint8Array> = []
    const callbackCalls: unknown[] = []
    const runtimeProcess = createNodeCoreSyntheticModules({
      ...createNodeCoreOptions(),
      maxStdioChunkBytes: 3,
      stdio: {
        write: (_stream, chunk) => {
          providerCalls.push(chunk)
        }
      }
    })['node:process'].default
    let failure: unknown
    try {
      // eslint-disable-next-line no-extend-native -- adversarial runtime mutation
      String.prototype.charCodeAt = () => {
        overriddenCalls += 1
        return 0
      }
      runtimeProcess.stdout.write('你好', error => callbackCalls.push(error))
    } catch (error) {
      failure = error
    } finally {
      // eslint-disable-next-line no-extend-native -- restore adversarial mutation
      String.prototype.charCodeAt = originalCharCodeAt
    }

    expect(failure).toEqual(expect.objectContaining({
      code: 'ERR_HOLONOMY_RESOURCE_EXHAUSTED'
    }))
    expect(overriddenCalls).toBe(0)
    expect(providerCalls).toEqual([])
    expect(callbackCalls).toEqual([])
  })

  it('maps synchronous and asynchronous stdio failures without leaking raw errors', async () => {
    const rawSyncError = new Error('token=sync-secret')
    const syncProcess = createNodeCoreSyntheticModules({
      ...createNodeCoreOptions(),
      stdio: {
        write: () => {
          throw rawSyncError
        }
      }
    })['node:process'].default
    let syncFailure: unknown
    try {
      syncProcess.stdout.write('hello')
    } catch (error) {
      syncFailure = error
    }
    expect(syncFailure).toEqual(expect.objectContaining({
      cause: { kind: 'host-provider-failure', operation: 'stdio.write' },
      code: 'ERR_HOLONOMY_STDIO_WRITE_FAILED'
    }))
    expect(String(syncFailure)).not.toContain('sync-secret')
    expect((syncFailure as Error & { cause: unknown }).cause).not.toBe(rawSyncError)

    const rawAsyncError = new Error('token=async-secret')
    const asyncProcess = createNodeCoreSyntheticModules({
      ...createNodeCoreOptions(),
      stdio: { write: async () => Promise.reject(rawAsyncError) }
    })['node:process'].default
    let callbackFailure: unknown
    const result = asyncProcess.stderr.write(
      new Uint8Array([1]),
      error => {
        callbackFailure = error
      }
    )
    await expect(result).rejects.toEqual(expect.objectContaining({
      code: 'ERR_HOLONOMY_STDIO_WRITE_FAILED'
    }))
    expect(callbackFailure).toEqual(expect.objectContaining({
      code: 'ERR_HOLONOMY_STDIO_WRITE_FAILED'
    }))
    expect(String(callbackFailure)).not.toContain('async-secret')
  })

  it('preserves provider backpressure across synchronous and asynchronous writes', async () => {
    const syncProcess = createNodeCoreSyntheticModules({
      ...createNodeCoreOptions(),
      stdio: { write: () => false }
    })['node:process'].default
    expect(syncProcess.stdout.write('full')).toBe(false)

    const asyncProcess = createNodeCoreSyntheticModules({
      ...createNodeCoreOptions(),
      stdio: { write: () => Promise.resolve(false) }
    })['node:process'].default
    await expect(asyncProcess.stdout.write('full')).resolves.toBe(false)
  })

  it('rejects every exposed dangerous process control with one stable code', () => {
    const runtimeProcess = createNodeCoreSyntheticModules(
      createNodeCoreOptions()
    )['node:process'].default
    const operations = [
      () => runtimeProcess.abort(),
      () => runtimeProcess.chdir('/app/other'),
      () => runtimeProcess.exit(1),
      () => runtimeProcess.kill(1),
      () => runtimeProcess.nextTick(() => undefined),
      () => runtimeProcess.setgid(1),
      () => runtimeProcess.setuid(1),
      () => runtimeProcess.umask(0)
    ]
    for (const operation of operations) {
      expect(operation).toThrowError(
        expect.objectContaining({ code: 'ERR_HOLONOMY_NOT_SUPPORTED' })
      )
    }
  })

  it('returns immutable synthetic OS values and rejects unsafe snapshots', () => {
    const options = createNodeCoreOptions()
    const os = createNodeCoreSyntheticModules(options)['node:os']
    expect(os.arch()).toBe('arm64')
    expect(os.platform()).toBe('android')
    expect(os.hostname()).toBe('holonomy')
    expect(os.homedir()).toBe('/app/home/runtime')
    expect(os.tmpdir()).toBe('/app/tmp')
    expect(os.userInfo()).toEqual(options.os.userInfo)
    expect(Object.isFrozen(os.userInfo())).toBe(true)

    const unsafeOs: RuntimeOsSnapshot = {
      ...options.os,
      homedir: '/data/user/0/real-app'
    }
    expect(() => createNodeCoreSyntheticModules({ ...options, os: unsafeOs })).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_OUT_OF_BOUNDS' })
    )
    expect(() =>
      createNodeCoreSyntheticModules({
        ...options,
        virtualRoot: '/data/user/0/real-app'
      })
    ).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_INVALID_ARGUMENT' })
    )
  })
})
