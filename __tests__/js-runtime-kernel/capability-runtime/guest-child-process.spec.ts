import { describe, expect, it } from 'vitest'

import { createCapabilityChildProcessOverrideV1 } from '../../../src/capability-runtime/guest-child-process-facade.js'
import {
  childProcessEnvironmentV1,
  snapshotChildProcessOptionsV1
} from '../../../src/capability-runtime/guest-child-process-support.js'

const environment = Object.freeze({
  allowedScopes: Object.freeze(['processTree', 'runtime'] as const),
  defaultScope: 'runtime' as const
})

describe('child process environment symbol', () => {
  it('uses the facade as listener this without exposing mutable listener records', () => {
    const subscriptions = new Map<string, (event: string) => void>()
    const terminal = JSON.stringify({
      ok: true,
      value: {
        binding: { bindingId: 'listener-this-child', generation: 1 },
        pid: 39,
        resourceType: 'process.child',
        stderr: null,
        stdin: null,
        stdout: null
      }
    })
    const binding = createCapabilityChildProcessOverrideV1({
      invoke: async () => terminal,
      invokeImmediate: () => terminal,
      invokeSync: () => JSON.stringify({ ok: true, value: {} }),
      subscribeResource: (bindingId, listener) => {
        subscriptions.set(bindingId, listener)
        return () => subscriptions.delete(bindingId)
      }
    }, {})!
    const child = (binding.namespace as Record<string, Function>).spawn('tool') as Record<string, Function>
    let callbackThisIsFacade = false
    let mutationRejected = false
    child.on('spawn', function(this: Record<string, unknown>) {
      callbackThisIsFacade = this === child
      try {
        this.listener = () => undefined
      } catch {
        mutationRejected = true
      }
    })

    subscriptions.get('listener-this-child')!(JSON.stringify({ event: 'spawn', tuple: [] }))

    expect(callbackThisIsFacade).toBe(true)
    expect(Object.hasOwn(child, 'listener')).toBe(false)
    expect(mutationRejected).toBe(true)
  })

  it('does not re-deliver a once callback retained by an outer delivery snapshot', () => {
    const subscriptions = new Map<string, (event: string) => void>()
    const terminal = JSON.stringify({
      ok: true,
      value: {
        binding: { bindingId: 'once-reentry-child', generation: 1 },
        pid: 40,
        resourceType: 'process.child',
        stderr: null,
        stdin: null,
        stdout: null
      }
    })
    const binding = createCapabilityChildProcessOverrideV1({
      invoke: async () => terminal,
      invokeImmediate: () => terminal,
      invokeSync: () => JSON.stringify({ ok: true, value: {} }),
      subscribeResource: (bindingId, listener) => {
        subscriptions.set(bindingId, listener)
        return () => subscriptions.delete(bindingId)
      }
    }, {})!
    const child = (binding.namespace as Record<string, Function>).spawn('tool') as Record<string, Function>
    let nested = false
    let onceCalls = 0
    child.on('spawn', () => {
      if (nested) return
      nested = true
      subscriptions.get('once-reentry-child')!(JSON.stringify({ event: 'spawn', tuple: [] }))
    })
    child.once('spawn', () => onceCalls += 1)

    subscriptions.get('once-reentry-child')!(JSON.stringify({ event: 'spawn', tuple: [] }))

    expect(onceCalls).toBe(1)
    expect(child.listenerCount('spawn')).toBe(1)
  })

  it('keeps ChildProcess and pipe listener management local, ordered, and releasable', async () => {
    const subscriptions = new Map<string, (event: string) => void>()
    const terminal = JSON.stringify({
      ok: true,
      value: {
        binding: { bindingId: 'listeners-child', generation: 1 },
        pid: 41,
        resourceType: 'process.child',
        stderr: {
          binding: { bindingId: 'listeners-stderr', generation: 1 },
          resourceType: 'process.readable'
        },
        stdin: null,
        stdout: {
          binding: { bindingId: 'listeners-stdout', generation: 1 },
          resourceType: 'process.readable'
        }
      }
    })
    const binding = createCapabilityChildProcessOverrideV1({
      invoke: async () => terminal,
      invokeImmediate: () => terminal,
      invokeSync: () => JSON.stringify({ ok: true, value: {} }),
      subscribeResource: (bindingId, listener) => {
        subscriptions.set(bindingId, listener)
        return () => subscriptions.delete(bindingId)
      }
    }, {})!
    const child = (binding.namespace as Record<string, Function>).spawn('tool') as Record<string, Function>
    const stdout = child.stdout as unknown as Record<string, Function>
    const stderr = child.stderr as unknown as Record<string, Function>
    const received: string[] = []
    const repeated = () => received.push('repeated')
    const removedOnce = () => received.push('removed-once')
    const second = () => received.push('second')
    const first = () => {
      received.push('first')
      child.removeListener('spawn', second)
      child.on('spawn', () => received.push('late'))
    }

    expect(child.addListener('spawn', repeated)).toBe(child)
    child.on('spawn', repeated)
    child.once('spawn', removedOnce)
    expect(child.listeners('spawn')).toEqual([repeated, repeated, removedOnce])
    expect(child.listenerCount('spawn')).toBe(3)
    expect(child.listenerCount('spawn', repeated)).toBe(2)
    expect(child.off('spawn', repeated)).toBe(child)
    expect(child.listeners('spawn')).toEqual([repeated, removedOnce])
    child.removeListener('spawn', removedOnce)
    child.on('spawn', first)
    child.on('spawn', second)
    expect(child.eventNames()).toEqual(['spawn'])

    subscriptions.get('listeners-child')!(JSON.stringify({ event: 'spawn', tuple: [] }))
    expect(received).toEqual(['repeated', 'first', 'second'])
    subscriptions.get('listeners-child')!(JSON.stringify({ event: 'spawn', tuple: [] }))
    expect(received).toEqual(['repeated', 'first', 'second', 'repeated', 'first', 'late'])

    let streamThisIsFacade = false
    const data = function(this: Record<string, unknown>, chunk: Uint8Array) {
      streamThisIsFacade = this === stdout
      received.push(`data:${chunk[0]}`)
    }
    const streamError = (error: Error & { code?: string }) => received.push(`stderr:${error.code}`)
    stdout.once('data', data)
    expect(stdout.removeListener('data', data)).toBe(stdout)
    stdout.on('data', data)
    stderr.once('error', streamError)
    subscriptions.get('listeners-stdout')!(JSON.stringify({ event: 'data', tuple: [Uint8Array.of(7)] }))
    subscriptions.get('listeners-stderr')!(JSON.stringify({
      event: 'error',
      tuple: [{ code: 'EPIPE', message: 'pipe failed', name: 'Error' }]
    }))
    expect(received.slice(-2)).toEqual(['data:7', 'stderr:EPIPE'])
    expect(streamThisIsFacade).toBe(true)
    expect(stdout.removeAllListeners('data')).toBe(stdout)
    expect(stdout.listenerCount('data')).toBe(0)

    let closeArguments = 0
    child.once('close', function() {
      closeArguments = arguments.length
    })
    subscriptions.get('listeners-child')!(JSON.stringify({ event: 'close', tuple: [0, null] }))
    await Promise.resolve()
    expect(closeArguments).toBe(2)
    expect(child.eventNames()).toEqual([])
    expect(child.listenerCount('spawn')).toBe(0)
    expect(subscriptions.size).toBe(0)
  })

  it('uses the Host default and removes the Symbol from the JSON snapshot', () => {
    const snapshot = snapshotChildProcessOptionsV1({ stdio: ['pipe', 'pipe', 'pipe'] }, false, false, environment)

    expect(snapshot).toEqual({
      environmentScope: 'runtime',
      options: { stdio: ['pipe', 'pipe', 'pipe'] }
    })
    expect(Object.getOwnPropertySymbols(snapshot.options)).toHaveLength(0)
  })

  it('accepts only the exported Symbol and a Host-allowed narrower scope', () => {
    expect(childProcessEnvironmentV1).toBe(Symbol.for('holo.childProcessEnvironment'))
    const snapshot = snapshotChildProcessOptionsV1(
      {
        [childProcessEnvironmentV1]: { scope: 'processTree' }
      },
      false,
      false,
      environment
    )

    expect(snapshot.environmentScope).toBe('processTree')
    expect(() =>
      snapshotChildProcessOptionsV1({ [Symbol('lookalike')]: { scope: 'processTree' } }, false, false, environment)
    ).toThrowError(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }))
  })

  it('does not invoke a Symbol accessor and rejects disallowed scopes', () => {
    let reads = 0
    const options = Object.defineProperty({}, childProcessEnvironmentV1, {
      get() {
        reads += 1
        return { scope: 'processTree' }
      }
    })
    expect(() => snapshotChildProcessOptionsV1(options, false, false, environment)).toThrow()
    expect(reads).toBe(0)
    expect(() =>
      snapshotChildProcessOptionsV1(
        { [childProcessEnvironmentV1]: { scope: 'runtime' } },
        false,
        false,
        { allowedScopes: ['processTree'], defaultScope: 'processTree' }
      )
    ).toThrowError(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }))
  })

  it('translates Node option names and keeps Host-only Backend fields unavailable', () => {
    expect(snapshotChildProcessOptionsV1({ maxBuffer: 32, timeout: 50 }, false, true)).toEqual({
      environmentScope: 'processTree',
      options: { maxBufferBytes: 32, timeoutMs: 50 }
    })
    expect(() => snapshotChildProcessOptionsV1({ maxBufferBytes: 32 }, false, true)).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' })
    )
    expect(() => snapshotChildProcessOptionsV1({ shellExecutableId: 'host-shell' }, false, true)).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' })
    )
  })

  it('preserves common optional callback overloads without changing the admitted arguments', () => {
    const requests: Record<string, unknown>[] = []
    const terminal = () =>
      JSON.stringify({
        ok: true,
        value: {
          binding: { bindingId: `process-${requests.length}`, generation: 1 },
          pid: requests.length,
          resourceType: 'process.child',
          stderr: null,
          stdin: null,
          stdout: null
        }
      })
    const binding = createCapabilityChildProcessOverrideV1({
      invoke: async () => terminal(),
      invokeImmediate: request => {
        requests.push(JSON.parse(request) as Record<string, unknown>)
        return terminal()
      },
      invokeSync: () => terminal()
    }, { processShellExecutableId: 'shell' })!
    const facade = binding.namespace as Record<string, (...args: unknown[]) => unknown>
    const callback = () => undefined

    expect(() => facade.execFile!('tool', callback)).not.toThrow()
    expect(() => facade.execFile!('tool', ['a'], callback)).not.toThrow()
    expect(() => facade.execFile!('tool', { encoding: 'utf8' }, callback)).not.toThrow()
    expect(() => facade.execFile!('tool')).not.toThrow()
    expect(() => facade.exec!('true')).not.toThrow()

    expect(requests.map(request => (request.arguments as { args?: string[]; options: object }))).toEqual([
      { args: [], environmentScope: 'processTree', executableId: 'tool', options: {} },
      { args: ['a'], environmentScope: 'processTree', executableId: 'tool', options: {} },
      { args: [], environmentScope: 'processTree', executableId: 'tool', options: { encoding: 'utf8' } },
      { args: [], environmentScope: 'processTree', executableId: 'tool', options: {} },
      { command: 'true', environmentScope: 'processTree', options: { shellExecutableId: 'shell' } }
    ])
  })

  it('releases the child and every stdio binding when close becomes terminal', async () => {
    const listeners = new Map<string, (event: string) => void>()
    const released: string[] = []
    const terminal = JSON.stringify({
      ok: true,
      value: {
        binding: { bindingId: 'process-1', generation: 1 },
        pid: 1,
        resourceType: 'process.child',
        stderr: {
          binding: { bindingId: 'process-1-stderr', generation: 1 },
          resourceType: 'process.readable'
        },
        stdin: {
          binding: { bindingId: 'process-1-stdin', generation: 1 },
          resourceType: 'process.stdin'
        },
        stdout: {
          binding: { bindingId: 'process-1-stdout', generation: 1 },
          resourceType: 'process.readable'
        }
      }
    })
    const binding = createCapabilityChildProcessOverrideV1({
      invoke: async () => terminal,
      invokeImmediate: () => terminal,
      invokeSync: () => {
        throw new Error('readable control invoked after child close')
      },
      releaseResource: bindingId => released.push(bindingId),
      subscribeResource: (bindingId, listener) => {
        listeners.set(bindingId, listener)
        return () => listeners.delete(bindingId)
      }
    }, {})!
    const child = (binding.namespace as Record<string, Function>).spawn('tool')

    let childCloseReadControls = 0
    child.on('close', () => {
      child.stdout.resume()
      child.stderr.pause()
      childCloseReadControls += 1
    })
    listeners.get('process-1-stdout')!(JSON.stringify({ event: 'end', tuple: [] }))
    expect(child.stdout.resume()).toBe(child.stdout)
    listeners.get('process-1')!(JSON.stringify({ event: 'close', tuple: [0, null] }))
    await Promise.resolve()

    expect(childCloseReadControls).toBe(1)
    expect(child.pid).toBe(1)
    expect(child.stdout.resume()).toBe(child.stdout)
    expect(child.stdout.pause()).toBe(child.stdout)
    expect(child.stdout.destroy()).toBe(child.stdout)
    expect(released).toEqual([
      'process-1-stdin',
      'process-1-stdout',
      'process-1-stderr',
      'process-1'
    ])
    expect(listeners.size).toBe(0)
  })

  it('continues child close after a readable was already released', () => {
    const listeners = new Map<string, (event: string) => void>()
    const released = new Set<string>()
    const terminal = JSON.stringify({
      ok: true,
      value: {
        binding: { bindingId: 'process-2', generation: 1 },
        pid: 2,
        resourceType: 'process.child',
        stderr: null,
        stdin: null,
        stdout: {
          binding: { bindingId: 'process-2-stdout', generation: 1 },
          resourceType: 'process.readable'
        }
      }
    })
    const binding = createCapabilityChildProcessOverrideV1({
      invoke: async () => terminal,
      invokeImmediate: () => terminal,
      invokeSync: request => {
        if ((JSON.parse(request) as { member: string }).member === 'stdout/stderr.destroy') {
          released.add('process-2-stdout')
        }
        return JSON.stringify({ ok: true, value: {} })
      },
      releaseResource: bindingId => {
        if (released.has(bindingId)) throw new Error('runtime.generation_stale')
        released.add(bindingId)
      },
      subscribeResource: (bindingId, listener) => {
        listeners.set(bindingId, listener)
        return () => listeners.delete(bindingId)
      }
    }, {})!
    const child = (binding.namespace as Record<string, Function>).spawn('tool')
    child.stdout.destroy()
    expect(() => listeners.get('process-2')!(JSON.stringify({ event: 'close', tuple: [0, null] }))).not.toThrow()
    expect(released.has('process-2')).toBe(true)
    expect(listeners.size).toBe(0)
    expect(child.pid).toBe(2)
  })
})
