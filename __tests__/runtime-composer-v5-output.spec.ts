/* eslint-disable accessor-pairs, no-extend-native */

import { describe, expect, it } from 'vitest'

import { RuntimeEventLoop, createHolonomyRuntime } from '../src/index.js'
import type { HolonomyRuntime, HolonomyRuntimeOptions, HostEventLoopPort, NativePort } from '../src/index.js'
import { snapshotGitAuthorityInput } from '../src/runtime/authority-snapshot.js'
import { gitAuthorityInput } from './git-fixture.js'

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
  authority: { capabilities: [], principal: 'principal' },
  eventLoop: new RuntimeEventLoop(host()),
  nativePort: port(),
  nodeCore: nodeCore()
})

describe('runtime composer V5 output construction', () => {
  it('defines module, global and loader keys without inherited setters', async () => {
    const keys = ['node:buffer', 'ReadableStream', 'node:path', 'node:stream/promises', 'node:stream/web']
    const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)] as const)
    const calls: string[] = []
    let result: Promise<unknown> | undefined
    try {
      for (let index = 0; index < keys.length; index += 1) {
        Object.defineProperty(Object.prototype, keys[index]!, {
          configurable: true,
          set(this: Record<string, unknown>) {
            calls.push(keys[index]!)
            Object.defineProperty(this, keys[index]!, {
              configurable: true,
              enumerable: true,
              value: { descriptor: { exportNames: ['pwned'] }, namespace: { pwned: true } },
              writable: true
            })
          }
        })
      }
      const input = base() as HolonomyRuntimeOptions & { moduleLoader: unknown }
      input.moduleLoader = { readModule: () => null, rootUrl: 'app:///bundle/' }
      result = createHolonomyRuntime(input)
    } finally {
      for (let index = 0; index < descriptors.length; index += 1) {
        const [key, descriptor] = descriptors[index]!
        if (descriptor) Object.defineProperty(Object.prototype, key, descriptor)
        else Reflect.deleteProperty(Object.prototype, key)
      }
    }
    const runtime = await result as HolonomyRuntime
    expect(calls).toEqual([])
    expect(runtime.syntheticModules['node:buffer']?.namespace).toBeDefined()
    expect(runtime.syntheticModules['node:buffer']?.descriptor.exportNames.length).toBeGreaterThan(0)
    expect(runtime.syntheticModules['node:stream/promises']?.namespace).toMatchObject({
      finished: expect.any(Function),
      pipeline: expect.any(Function)
    })
    expect(runtime.syntheticModules['node:stream/promises']?.descriptor.exportNames).toEqual(['finished', 'pipeline'])
    expect(runtime.syntheticModules['node:stream/web']?.namespace).toMatchObject({
      ReadableStream: expect.any(Function)
    })
    expect(runtime.syntheticModules['node:stream/web']?.descriptor.exportNames).toContain('WritableStream')
    expect(runtime.globals.ReadableStream).toBeDefined()
    await runtime.dispose()
  })

  it('does not consult a replaced global String while copying Git authority inputs', () => {
    const original = globalThis.String
    const git = gitAuthorityInput()
    let calls = 0
    try {
      globalThis.String = (() => {
        calls += 1
        throw new Error('string marker')
      }) as never
      const snapshot = snapshotGitAuthorityInput(git)
      expect(snapshot.credentials).toEqual(git.credentials)
      expect(snapshot.filesystem).toEqual(git.filesystem)
    } finally {
      globalThis.String = original
    }
    expect(calls).toBe(0)
  })

  it('does not consult a replaced Object.create while copying NetworkAuthority', async () => {
    const original = Object.create
    let calls = 0
    let result: Promise<unknown> | undefined
    try {
      Object.create = ((prototype: object | null) => {
        calls += 1
        return new Proxy(original(prototype), {})
      }) as typeof Object.create
      const input = {
        ...base(),
        authority: { capabilities: ['host.network.http'], principal: 'principal' },
        network: { authority: { allowedOrigins: ['https://example.test'] }, principal: 'principal' }
      } as HolonomyRuntimeOptions
      result = createHolonomyRuntime(input)
    } finally {
      Object.create = original
    }
    const runtime = await result as HolonomyRuntime
    expect(calls).toBe(0)
    expect(runtime.network).toBeDefined()
    await runtime.dispose()
  })
})
