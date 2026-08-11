/* eslint-disable no-extend-native */

import { describe, expect, it } from 'vitest'

import { RuntimeComposerError, RuntimeEventLoop, createHolonomyRuntime } from '../../../src/index.js'
import type { HolonomyRuntimeOptions, HostEventLoopPort, NativePort } from '../../../src/index.js'

const host = (): HostEventLoopPort => ({ checkpointMicrotasks() {}, now: () => 0, requestWakeup() {}, terminate() {} })
const port = (): NativePort => ({ cancel() {}, closeResource() {}, dispatch() {}, dispose() {}, grantCredits() {} })
const nodeCore = () => ({
  os: {
    arch: 'arm64',
    homedir: '/app/home',
    hostname: 'runtime',
    identityPolicy: 'synthetic' as const,
    platform: 'android',
    release: '1',
    tmpdir: '/app/tmp',
    type: 'Mobile',
    userInfo: { gid: 1, homedir: '/app/home', shell: null, uid: 1, username: 'runtime' }
  },
  process: {
    arch: 'arm64',
    argv: [],
    cwd: '/app',
    env: {},
    execPath: '/app/node',
    pid: 1,
    platform: 'android',
    versions: { node: '22' }
  },
  stdio: { write: () => true },
  virtualRoot: '/app'
})
const base = (): HolonomyRuntimeOptions => ({
  authority: { capabilities: ['host.network.http'], principal: 'principal' },
  eventLoop: new RuntimeEventLoop(host()),
  nativePort: port(),
  nodeCore: nodeCore()
})
const invalid = 'runtime_composer.invalid_options'

describe('runtime composer V4 remaining regressions', () => {
  it('rejects sparse NetworkAuthority origins before the network leaf', async () => {
    const options = base()
    const origins = Array.from<string>({ length: 1 })
    ;(options as { network?: unknown }).network = { authority: { allowedOrigins: origins }, principal: 'principal' }
    await expect(createHolonomyRuntime(options)).rejects.toMatchObject({ code: invalid })
  })

  it('rejects accessor NetworkAuthority origins without invoking it', async () => {
    const options = base()
    let reads = 0
    const authority = Object.create(Object.prototype) as { allowedOrigins: readonly string[] }
    Object.defineProperty(authority, 'allowedOrigins', {
      enumerable: true,
      get: () => {
        reads += 1
        return ['https://example.test']
      }
    })
    ;(options as { network?: unknown }).network = { authority, principal: 'principal' }
    await expect(createHolonomyRuntime(options)).rejects.toMatchObject({ code: invalid })
    expect(reads).toBe(0)
  })

  it('keeps internal composer errors unforgeable after WeakSet and call poisoning', async () => {
    const add = WeakSet.prototype.add
    const has = WeakSet.prototype.has
    const call = Function.prototype.call
    let result: Promise<unknown> | undefined
    try {
      WeakSet.prototype.add = function() {
        throw new Error('poisoned add')
      }
      WeakSet.prototype.has = function() {
        throw new Error('poisoned has')
      }
      Function.prototype.call = function() {
        throw new Error('poisoned call')
      }
      const forged = new RuntimeComposerError(invalid)
      expect(forged.code).toBe(invalid)
      const options = base() as HolonomyRuntimeOptions & { extra?: boolean }
      options.extra = true
      result = createHolonomyRuntime(options)
    } finally {
      WeakSet.prototype.add = add
      WeakSet.prototype.has = has
      Function.prototype.call = call
    }
    await expect(result).rejects.toMatchObject({ code: invalid })
  })
})
