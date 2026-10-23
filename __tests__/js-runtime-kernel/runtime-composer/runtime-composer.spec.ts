import { describe, expect, it } from 'vitest'

import { RuntimeEventLoop, createHolonomyRuntime } from '../../../src/index.js'
import type { HostEventLoopPort, NativePort } from '../../../src/index.js'

const host = (): HostEventLoopPort => ({
  checkpointMicrotasks() {},
  now: () => 0,
  requestWakeup() {},
  terminate() {}
})

const port = (): NativePort => ({
  cancel() {},
  closeResource() {},
  dispatch() {},
  dispose() {},
  grantCredits() {}
})

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

describe('runtime composer', () => {
  it('routes process.nextTick through its caller-owned loop and fences disposal', async () => {
    const events: string[] = []
    let bypassCalls = 0
    const loop = new RuntimeEventLoop({
      checkpointMicrotasks: () => events.push('promise'),
      now: () => 0,
      requestWakeup() {},
      terminate() {}
    })
    const runtime = await createHolonomyRuntime({
      authority: { capabilities: [], principal: 'principal' },
      eventLoop: loop,
      nativePort: port(),
      nodeCore: {
        ...nodeCore(),
        nextTick: () => {
          bypassCalls += 1
        }
      }
    })
    const process = (runtime.syntheticModules['node:process']!.namespace as {
      default: { nextTick(callback: (...args: unknown[]) => unknown, ...args: unknown[]): void }
    }).default
    const value = { identity: true }
    loop.enqueueMacrotask(() => events.push('macro'))
    expect(process.nextTick(function(this: unknown, argument: unknown) {
      expect(this).toBeUndefined()
      expect(argument).toBe(value)
      events.push('tick:first')
      process.nextTick(() => events.push('tick:nested'))
    }, value)).toBeUndefined()
    process.nextTick(() => events.push('tick:second'))
    expect(events).toEqual([])
    expect(loop.runTurn()).toMatchObject({ taskKind: 'next-tick', callbacksProcessed: 3 })
    expect(events).toEqual(['tick:first', 'tick:second', 'tick:nested', 'promise'])
    expect(bypassCalls).toBe(0)
    loop.runTurn()
    expect(events).toEqual(['tick:first', 'tick:second', 'tick:nested', 'promise', 'macro', 'promise'])

    process.nextTick(() => events.push('stale'))
    await runtime.dispose()
    expect(loop.isDisposed).toBe(false)
    expect(loop.getSnapshot().hasPendingWork).toBe(false)
    expect(() => process.nextTick(() => undefined)).toThrowError(
      expect.objectContaining({ code: 'runtime_composer.disposed' })
    )
    expect(loop.runTurn().status).toBe('idle')
    expect(events).not.toContain('stale')
  })

  it('delivers a next-tick callback throw through the normal Event Loop terminal', async () => {
    const terminations: unknown[] = []
    const loop = new RuntimeEventLoop({
      checkpointMicrotasks() {},
      now: () => 0,
      requestWakeup() {},
      terminate: reason => terminations.push(reason)
    })
    const runtime = await createHolonomyRuntime({
      authority: { capabilities: [], principal: 'principal' },
      eventLoop: loop,
      nativePort: port(),
      nodeCore: nodeCore()
    })
    const process = (runtime.syntheticModules['node:process']!.namespace as {
      default: { nextTick(callback: () => void): void }
    }).default
    const failure = new Error('guest callback failed')
    process.nextTick(() => {
      throw failure
    })
    expect(() => loop.runTurn()).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_CALLBACK_FAILED', cause: failure })
    )
    expect(terminations).toEqual([
      expect.objectContaining({ code: 'ERR_HOLONOMY_CALLBACK_FAILED', kind: 'error' })
    ])
    await runtime.dispose()
  })
  it('owns Abort timeout timers per Runtime while sharing a caller-owned Event Loop', async () => {
    let now = 0
    const loop = new RuntimeEventLoop({
      checkpointMicrotasks() {},
      now: () => now,
      requestWakeup() {},
      terminate() {}
    })
    const make = () =>
      createHolonomyRuntime({
        authority: { capabilities: [], principal: 'principal' },
        eventLoop: loop,
        nativePort: port(),
        nodeCore: nodeCore()
      })
    const first = await make()
    const second = await make()
    const FirstSignal = first.globals.AbortSignal as typeof globalThis.AbortSignal
    const SecondSignal = second.globals.AbortSignal as typeof globalThis.AbortSignal
    expect(FirstSignal).not.toBe(SecondSignal)
    const firstTimeout = FirstSignal.timeout(10)
    const secondTimeout = SecondSignal.timeout(10)
    await first.dispose()
    expect(loop.isDisposed).toBe(false)
    expect(loop.getSnapshot().hasPendingWork).toBe(true)
    now = 10
    loop.runTurn()
    expect(firstTimeout.aborted).toBe(false)
    expect(secondTimeout.reason).toMatchObject({ name: 'TimeoutError' })
    expect(() => FirstSignal.timeout(0)).toThrow(TypeError)
    await second.dispose()
  })

  it('preserves explicitly injected native Abort constructors for Network', async () => {
    const runtime = await createHolonomyRuntime({
      authority: { capabilities: ['host.network.http'], principal: 'principal' },
      eventLoop: new RuntimeEventLoop(host()),
      nativePort: port(),
      nodeCore: nodeCore(),
      network: {
        authority: { allowedOrigins: ['https://example.test'] },
        constructors: {
          AbortController: globalThis.AbortController,
          AbortSignal: globalThis.AbortSignal
        },
        principal: 'principal'
      }
    })
    expect(runtime.globals.AbortController).toBe(globalThis.AbortController)
    expect(runtime.globals.AbortSignal).toBe(globalThis.AbortSignal)
    await runtime.dispose()
  })

  it('always installs frozen Node Core, Streams and explicit globals', async () => {
    const loop = new RuntimeEventLoop(host())
    const runtime = await createHolonomyRuntime({
      authority: { capabilities: [], principal: 'principal' },
      eventLoop: loop,
      nativePort: port(),
      nodeCore: nodeCore()
    })
    expect(Object.isFrozen(runtime)).toBe(true)
    expect(Object.keys(runtime.syntheticModules)).toContain('node:stream/web')
    expect(Object.keys(runtime.syntheticModules)).toContain('node:buffer')
    expect(runtime.globals.ReadableStream).toBeDefined()
    expect(() => new (runtime.globals.WebSocket as new(url: string) => object)('wss://example.test')).toThrow(
      new TypeError('Holonomy WebSocket is unsupported by SandboxPolicyV2')
    )
    expect(runtime.getSnapshot().disposed).toBe(false)
    await runtime.dispose()
    expect(runtime.getSnapshot().disposed).toBe(true)
    expect(runtime.getSnapshot().nativeBridge.pendingRequests).toBe(0)
  })

  it('installs an admitted host facade in place of an overridable synthetic module', async () => {
    const arch = () => 'host-projected'
    const deviceCommonjs = () => 'device-commonjs'
    const namespace = Object.freeze({ arch, default: Object.freeze({ arch }) })
    const runtime = await createHolonomyRuntime({
      authority: { capabilities: [], principal: 'principal' },
      eventLoop: new RuntimeEventLoop(host()),
      moduleOverrides: Object.freeze({
        'holo:device': Object.freeze({
          commonjsValue: deviceCommonjs,
          descriptor: Object.freeze({ exportNames: Object.freeze(['getFormFactor']) }),
          namespace: Object.freeze({ getFormFactor: () => 'desktop' })
        }),
        'node:os': Object.freeze({
          descriptor: Object.freeze({ exportNames: Object.freeze(['arch', 'default']) }),
          namespace
        })
      }),
      nativePort: port(),
      nodeCore: nodeCore()
    })

    expect(runtime.syntheticModules['node:os']?.namespace).toBe(namespace)
    expect(runtime.syntheticModules['node:os']?.commonjsValue).toBe(namespace.default)
    expect(runtime.syntheticModules['holo:device']?.namespace).toMatchObject({ getFormFactor: expect.any(Function) })
    expect(runtime.syntheticModules['holo:device']?.commonjsValue).toBe(deviceCommonjs)
    expect(runtime.syntheticModules['node:os']?.descriptor.exportNames).toEqual(['arch', 'default'])
    await runtime.dispose()
  })

  it('publishes CommonJS values separately from ESM namespaces', async () => {
    const runtime = await createHolonomyRuntime({
      authority: { capabilities: [], principal: 'principal' },
      eventLoop: new RuntimeEventLoop(host()),
      nativePort: port(),
      nodeCore: nodeCore()
    })
    for (
      const specifier of ['node:assert/strict', 'node:test', 'node:events', 'node:path', 'node:buffer', 'node:process']
    ) {
      const binding = runtime.syntheticModules[specifier]!
      expect(binding.commonjsValue).toBe((binding.namespace as { default: unknown }).default)
    }
    const withoutDefault = runtime.syntheticModules['node:stream/promises']!
    expect(withoutDefault.commonjsValue).toBe(withoutDefault.namespace)
    expect(runtime.syntheticModules['node:assert/strict']?.descriptor.exportNames).toContain('default')
    await runtime.dispose()
  })

  it('fails closed for an absent opt-in capability', async () => {
    await expect(
      createHolonomyRuntime({
        authority: { capabilities: [], principal: 'principal' },
        eventLoop: new RuntimeEventLoop(host()),
        nativePort: port(),
        nodeCore: nodeCore(),
        fs: {}
      })
    ).rejects.toThrow('runtime_composer.required_capability')
  })
})
