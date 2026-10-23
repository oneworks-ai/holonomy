import { describe, expect, it } from 'vitest'

import { RuntimeEventLoop, createHolonomyRuntime } from '../../../src/index.js'
import { createRuntimeImmediate, createRuntimeTimers } from '../../../src/timers/index.js'

const makeLoop = () =>
  new RuntimeEventLoop({
    checkpointMicrotasks() {},
    now: () => 0,
    requestWakeup() {},
    terminate() {}
  })

describe('public Immediate handles', () => {
  it('preserves callback arguments and this identity while exposing one-shot reference state', () => {
    const loop = makeLoop()
    const immediate = createRuntimeImmediate(loop)
    const value = { identity: true }
    let receivedThis: unknown
    let receivedValue: unknown
    let activeInside = true
    const handle = immediate.setImmediate(function(this: unknown, argument: unknown) {
      // The public callback receives the exact handle as its this value.
      // eslint-disable-next-line ts/no-this-alias
      receivedThis = this
      receivedValue = argument
      activeInside = (this as typeof handle).hasRef()
    }, value)
    expect(handle.constructor.name).toBe('Immediate')
    expect(handle.hasRef()).toBe(true)
    expect(handle.unref()).toBe(handle)
    expect(handle.hasRef()).toBe(false)
    expect(loop.getSnapshot()).toMatchObject({ hasPendingWork: true, isAlive: false })
    expect(handle.ref()).toBe(handle)
    expect(loop.getSnapshot().isAlive).toBe(true)
    expect(loop.runTurn().taskKind).toBe('immediate')
    expect(receivedThis).toBe(handle)
    expect(receivedValue).toBe(value)
    expect(activeInside).toBe(false)
    expect(handle.hasRef()).toBe(false)
    expect(handle.ref()).toBe(handle)
    immediate.clearImmediate(handle)
    expect(loop.getSnapshot().hasPendingWork).toBe(false)
    immediate.dispose()
  })

  it('cancels by handle identity, supports disposal, and rejects invalid callbacks before admission', () => {
    const loop = makeLoop()
    const first = createRuntimeImmediate(loop)
    const second = createRuntimeImmediate(loop)
    const events: string[] = []
    const canceled = first.setImmediate(() => events.push('canceled'))
    second.clearImmediate(canceled)
    expect(canceled.hasRef()).toBe(true)
    first.clearImmediate(canceled)
    expect(canceled.hasRef()).toBe(false)
    const disposable = first.setImmediate(() => events.push('disposed'))
    if (typeof Symbol.dispose === 'symbol') {
      const dispose = disposable[Symbol.dispose]
      expect(typeof dispose).toBe('function')
      dispose?.call(disposable)
    } else first.clearImmediate(disposable)
    expect(disposable.hasRef()).toBe(false)
    const pending = second.setImmediate(() => events.push('second'))
    first.dispose()
    expect(loop.isDisposed).toBe(false)
    expect(pending.hasRef()).toBe(true)
    expect(loop.runTurn().taskKind).toBe('immediate')
    expect(events).toEqual(['second'])
    expect(() => second.setImmediate(1 as never)).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    )
    expect(loop.getSnapshot().hasPendingWork).toBe(false)
    second.dispose()
  })

  it('clears pending handles when the caller-owned loop terminates', () => {
    const loop = makeLoop()
    const immediate = createRuntimeImmediate(loop)
    const handle = immediate.setImmediate(() => {})
    loop.shutdown()
    expect(handle.hasRef()).toBe(false)
    expect(loop.runTurn().status).toBe('shutdown')
    immediate.dispose()
  })

  it('uses captured callback and validation intrinsics after guest mutation', () => {
    const loop = makeLoop()
    const immediate = createRuntimeImmediate(loop)
    const define = Object.defineProperty
    const applyDescriptor = Object.getOwnPropertyDescriptor(Reflect, 'apply')!
    const defineDescriptor = Object.getOwnPropertyDescriptor(Object, 'defineProperty')!
    const value = { identity: true }
    let hooks = 0
    let invalid: unknown
    let receivedThis: unknown
    let receivedValue: unknown
    let handle: ReturnType<typeof immediate.setImmediate> | undefined
    try {
      define(Reflect, 'apply', {
        configurable: true,
        value: () => {
          hooks += 1
          throw new Error('guest apply')
        }
      })
      define(Object, 'defineProperty', {
        configurable: true,
        value: () => {
          hooks += 1
          throw new Error('guest define')
        }
      })
      try {
        immediate.setImmediate(1 as never)
      } catch (error) {
        invalid = error
      }
      handle = immediate.setImmediate(function(this: unknown, argument: unknown) {
        // eslint-disable-next-line ts/no-this-alias
        receivedThis = this
        receivedValue = argument
      }, value)
      loop.runTurn()
    } finally {
      define(Reflect, 'apply', applyDescriptor)
      define(Object, 'defineProperty', defineDescriptor)
      immediate.dispose()
    }
    expect(hooks).toBe(0)
    expect(invalid).toBeInstanceOf(TypeError)
    expect(invalid).toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' })
    expect(receivedThis).toBe(handle)
    expect(receivedValue).toBe(value)
  })
})

describe('runtime composition of Immediate globals and node:timers', () => {
  it('publishes one shared callback facade and cancels only its own work on disposal', async () => {
    const loop = makeLoop()
    let timerId = 0
    const timers = createRuntimeTimers({ cancel() {}, schedule: () => ++timerId })
    const runtime = await createHolonomyRuntime({
      authority: { capabilities: [], principal: 'principal' },
      eventLoop: loop,
      nativePort: { cancel() {}, closeResource() {}, dispatch() {}, dispose() {}, grantCredits() {} },
      nodeCore: {
        os: {
          arch: 'arm64',
          homedir: '/runtime/home',
          hostname: 'runtime',
          identityPolicy: 'synthetic',
          platform: 'linux',
          release: '1',
          tmpdir: '/runtime/tmp',
          type: 'Linux',
          userInfo: { gid: 1, homedir: '/runtime/home', shell: null, uid: 1, username: 'runtime' }
        },
        process: {
          arch: 'arm64',
          argv: [],
          cwd: '/runtime',
          env: {},
          execPath: '/runtime/holo',
          pid: 1,
          platform: 'linux',
          versions: { node: '22' }
        },
        stdio: { write: () => true },
        virtualRoot: '/runtime'
      },
      timers
    })
    const module = runtime.syntheticModules['node:timers']!
    const named = module.namespace as {
      setImmediate: typeof runtime.globals.setImmediate
      clearImmediate: typeof runtime.globals.clearImmediate
    }
    expect(module.descriptor.exportNames).toContain('setImmediate')
    expect(module.descriptor.exportNames).toContain('clearImmediate')
    expect(named.setImmediate).toBe(runtime.globals.setImmediate)
    expect(named.clearImmediate).toBe(runtime.globals.clearImmediate)
    const setImmediate = runtime.globals.setImmediate as typeof named.setImmediate & ((callback: () => void) => object)
    const handle = setImmediate(() => {
      throw new Error('disposed callback ran')
    })
    expect(loop.getSnapshot().hasPendingWork).toBe(true)
    await runtime.dispose()
    expect(loop.isDisposed).toBe(false)
    expect(loop.getSnapshot().hasPendingWork).toBe(false)
    expect(loop.runTurn().status).toBe('idle')
    expect(handle).toBeDefined()
  })
})
