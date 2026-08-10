/* eslint-disable accessor-pairs, no-extend-native */

import { describe, expect, it } from 'vitest'

import { RuntimeEventLoop, createMobileRuntime } from '../src/index.js'
import type { HostEventLoopPort, MobileRuntime, MobileRuntimeOptions, NativePort } from '../src/index.js'

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
const options = (): MobileRuntimeOptions => ({
  authority: { capabilities: [], principal: 'principal' },
  eventLoop: new RuntimeEventLoop(host()),
  nativePort: port(),
  nodeCore: nodeCore()
})

describe('runtime composer V4 captured intrinsics', () => {
  it('preserves valid behavior with an equivalent Array iterator and post-import intrinsic mutation', async () => {
    const authority = Object.getOwnPropertyDescriptor(Object.prototype, 'authority')
    const index = Object.getOwnPropertyDescriptor(Array.prototype, '0')
    const iterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)
    const safeInteger = Number.isSafeInteger
    const string = globalThis.String
    const call = Function.prototype.call
    const input = options()
    let result: Promise<unknown> | undefined
    try {
      Object.defineProperty(Object.prototype, 'authority', {
        configurable: true,
        set: () => {
          throw new Error('setter marker')
        }
      })
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        value(this: unknown[]) {
          return Reflect.apply(iterator!.value as () => IterableIterator<unknown>, this, [])
        }
      })
      Number.isSafeInteger = value => safeInteger(value)
      globalThis.String = ((value?: unknown) => string(value)) as never
      Function.prototype.call = function(this: Function, receiver: unknown, ...args: unknown[]) {
        return Reflect.apply(call, this, [receiver, ...args])
      }
      result = createMobileRuntime(input)
    } finally {
      if (authority) Object.defineProperty(Object.prototype, 'authority', authority)
      else Reflect.deleteProperty(Object.prototype, 'authority')
      if (index) Object.defineProperty(Array.prototype, '0', index)
      else Reflect.deleteProperty(Array.prototype, '0')
      if (iterator) Object.defineProperty(Array.prototype, Symbol.iterator, iterator)
      Number.isSafeInteger = safeInteger
      globalThis.String = string
      Function.prototype.call = call
    }
    const runtime = await result as MobileRuntime
    expect(runtime.getSnapshot().disposed).toBe(false)
    await runtime.dispose()
  })

  it('keeps invalid options redacted while the same intrinsics are poisoned', async () => {
    const safeInteger = Number.isSafeInteger
    const string = globalThis.String
    const index = Object.getOwnPropertyDescriptor(Array.prototype, '0')
    const input = options() as MobileRuntimeOptions & { extra?: true }
    input.extra = true
    let result: Promise<unknown> | undefined
    try {
      Object.defineProperty(Array.prototype, '0', {
        configurable: true,
        set: () => {
          throw new Error('index marker')
        }
      })
      Number.isSafeInteger = () => false
      globalThis.String = (() => {
        throw new Error('raw marker')
      }) as never
      result = createMobileRuntime(input)
    } finally {
      if (index) Object.defineProperty(Array.prototype, '0', index)
      else Reflect.deleteProperty(Array.prototype, '0')
      Number.isSafeInteger = safeInteger
      globalThis.String = string
    }
    await expect(result).rejects.toMatchObject({
      code: 'runtime_composer.invalid_options',
      message: 'runtime_composer.invalid_options'
    })
  })
})
