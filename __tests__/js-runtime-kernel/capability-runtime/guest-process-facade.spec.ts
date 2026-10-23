import { describe, expect, it } from 'vitest'

import { createCapabilityProcessOverrideV1 } from '../../../src/capability-runtime/guest-process-facade.js'
import { RuntimeEventLoop } from '../../../src/event-loop/runtime-event-loop.js'

const terminal = (value: unknown) => JSON.stringify({ ok: true, value })

describe('capability node:process override', () => {
  it('schedules local next ticks without serializing callbacks through the capability bridge', () => {
    const events: string[] = []
    const loop = new RuntimeEventLoop({
      checkpointMicrotasks: () => events.push('promise'),
      now: () => 0,
      requestWakeup() {},
      terminate() {}
    })
    const requests: string[] = []
    const binding = createCapabilityProcessOverrideV1({
      context: null,
      process: { arch: 'arm64', argv: [], platform: 'darwin', versions: { holonomy: '1' } },
      processControl: {
        exit() {},
        nextTick: (callback, ...args) => {
          loop.enqueueNextTick(() => Reflect.apply(callback, undefined, args))
        }
      }
    }, {
      invoke: async () => terminal(null),
      invokeSync: request => {
        requests.push(request)
        return terminal(null)
      }
    })!
    const process = (binding.namespace as {
      default: { nextTick(callback: (...args: unknown[]) => unknown, ...args: unknown[]): void }
    }).default
    const before = requests.length
    const value = { identity: true }
    expect(process.nextTick(function(this: unknown, argument: unknown) {
      expect(this).toBeUndefined()
      expect(argument).toBe(value)
      events.push('tick:first')
      process.nextTick(() => events.push('tick:nested'))
    }, value)).toBeUndefined()
    process.nextTick(() => events.push('tick:second'))
    expect(() => process.nextTick({} as never)).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' })
    )
    expect(requests).toHaveLength(before)
    expect(loop.runTurn()).toMatchObject({ taskKind: 'next-tick', callbacksProcessed: 3 })
    expect(events).toEqual(['tick:first', 'tick:second', 'tick:nested', 'promise'])
  })
  it('publishes a shared empty environment for denial and does not hide transport failures', () => {
    const configuration = {
      context: null,
      process: { arch: 'arm64', argv: [], platform: 'darwin', versions: { holonomy: '1', v8: '15' } }
    }
    const denied = JSON.stringify({
      ok: false,
      error: {
        code: 'ERR_ACCESS_DENIED',
        name: 'Error',
        message: 'Denied by System Policy',
        retryable: false
      }
    })
    const binding = createCapabilityProcessOverrideV1(configuration, {
      invoke: async () => denied,
      invokeSync: () => denied
    })!
    const namespace = binding.namespace as Record<string, unknown>
    const process = namespace.default as { env: object }
    expect(namespace.env).toBe(process.env)
    expect(Object.keys(process.env)).toEqual([])
    expect(Object.getPrototypeOf(process.env)).toBeNull()
    expect(Object.isFrozen(process.env)).toBe(true)
    const bridgeError = Object.assign(new Error('Host bridge failed'), { code: 'ERR_ACCESS_DENIED' })
    expect(() =>
      createCapabilityProcessOverrideV1(configuration, {
        invoke: async () => denied,
        invokeSync: () => {
          throw bridgeError
        }
      })
    ).toThrow(bridgeError)
    expect(() =>
      createCapabilityProcessOverrideV1(configuration, {
        invoke: async () => denied,
        invokeSync: () =>
          JSON.stringify({
            ok: false,
            error: {
              code: 'EIO',
              name: 'Error',
              message: 'Provider failure',
              retryable: false
            }
          })
      })
    ).toThrow(expect.objectContaining({ code: 'EIO' }))
  })

  it('caches field denial without preventing an independently authorized environment', () => {
    const calls: string[] = []
    const binding = createCapabilityProcessOverrideV1({
      context: null,
      process: { arch: 'arm64', argv: [], platform: 'darwin', versions: { holonomy: '1', v8: '15' } }
    }, {
      invoke: async () => terminal(null),
      invokeSync: request => {
        const member = (JSON.parse(request) as { member: string }).member
        calls.push(member)
        return member === 'env'
          ? terminal({ APP_SETTING: 'configured' })
          : JSON.stringify({
            ok: false,
            error: {
              code: 'ERR_ACCESS_DENIED',
              name: 'Error',
              message: 'Denied by System Policy',
              retryable: false
            }
          })
      }
    })!
    const namespace = binding.namespace as Record<string, unknown>
    const process = namespace.default as { env: object; execPath: string; pid: number; versions: object }
    expect(calls).toEqual(['env', 'execPath', 'pid'])
    expect(process.env).toEqual({ APP_SETTING: 'configured' })
    expect(Object.getPrototypeOf(process.env)).toBeNull()
    expect(Object.isFrozen(process.env)).toBe(true)
    expect(() => process.pid).toThrow(expect.objectContaining({ code: 'ERR_ACCESS_DENIED' }))
    expect(() => process.execPath).toThrow(expect.objectContaining({ code: 'ERR_ACCESS_DENIED' }))
    expect(namespace.pid).toBeUndefined()
    expect(namespace.execPath).toBeUndefined()
    expect(process.versions).toEqual({ holonomy: '1', v8: '15' })
    expect(calls).toHaveLength(3)
    expect(Object.values(Object.getOwnPropertyDescriptors(namespace)).every(value => 'value' in value)).toBe(true)
  })

  it('keeps mutable Process state on the default export and exposes data-only named exports', () => {
    const binding = createCapabilityProcessOverrideV1({
      context: null,
      process: { arch: 'arm64', argv: [], platform: 'android', versions: { node: '22' } }
    }, {
      invoke: async () => terminal(null),
      invokeSync: request => {
        const member = (JSON.parse(request) as { member: string }).member
        return terminal(
          {
            cwd: 'holo-fs://workspace/',
            env: {},
            execPath: 'holo-fs://runtime/holonomy',
            pid: 42
          }[member as 'cwd' | 'env' | 'execPath' | 'pid']
        )
      }
    })!
    const namespace = binding.namespace as Record<string, unknown>
    const process = namespace.default as { exitCode: number }

    expect(Object.values(Object.getOwnPropertyDescriptors(namespace)).every(descriptor => 'value' in descriptor)).toBe(
      true
    )
    expect(namespace.exitCode).toBe(0)
    process.exitCode = 7
    expect(process.exitCode).toBe(7)
    expect(namespace.exitCode).toBe(0)
    expect(namespace.pid).toBe(42)
  })
})
