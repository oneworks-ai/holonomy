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
  it('uses the Host default and removes the Symbol from the JSON snapshot', () => {
    const snapshot = snapshotChildProcessOptionsV1({ stdio: ['pipe', 'pipe', 'pipe'] }, false, false, environment)

    expect(snapshot).toEqual({
      environmentScope: 'runtime',
      options: { stdio: ['pipe', 'pipe', 'pipe'] }
    })
    expect(Object.getOwnPropertySymbols(snapshot.options)).toHaveLength(0)
  })

  it('accepts only the exported Symbol and a Host-allowed narrower scope', () => {
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

  it('releases the child and every stdio binding when close becomes terminal', () => {
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
      invokeSync: () => terminal,
      releaseResource: bindingId => released.push(bindingId),
      subscribeResource: (bindingId, listener) => {
        listeners.set(bindingId, listener)
        return () => listeners.delete(bindingId)
      }
    }, {})!
    const child = (binding.namespace as Record<string, Function>).spawn('tool')

    listeners.get('process-1')!(JSON.stringify({ event: 'close', tuple: [0, null] }))

    expect(child.pid).toBe(1)
    expect(released).toEqual([
      'process-1-stdin',
      'process-1-stdout',
      'process-1-stderr',
      'process-1'
    ])
  })
})
