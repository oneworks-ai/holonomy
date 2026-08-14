import { describe, expect, it } from 'vitest'

import { createCapabilityChildProcessOverrideV1 } from '../../../src/capability-runtime/guest-child-process-facade.js'

const errorSnapshot = (code: string) => ({
  code,
  message: `Controlled child process failed: ${code}`,
  name: 'Error',
  retryable: false
})

const childSnapshot = (id: number) => ({
  binding: { bindingId: `process-${id}`, generation: 1 },
  pid: id,
  resourceType: 'process.child',
  stderr: null,
  stdin: {
    binding: { bindingId: `process-${id}-stdin`, generation: 1 },
    resourceType: 'process.stdin'
  },
  stdout: null
})

describe('controlled child process stdin callbacks', () => {
  it('binds write and end callbacks to Host resource terminals', async () => {
    const listeners = new Map<string, (event: string) => void>()
    const requests: Record<string, unknown>[] = []
    const child = childSnapshot(1)
    const terminal = (value: unknown) => JSON.stringify({ ok: true, value })
    const binding = createCapabilityChildProcessOverrideV1({
      invoke: async () => terminal({}),
      invokeImmediate: source => {
        const request = JSON.parse(source) as Record<string, unknown>
        requests.push(request)
        if (request.member === 'spawn') return terminal(child)
        if (request.member === 'ChildProcess.stdin.write') return terminal(false)
        if (request.member === 'ChildProcess.stdin.end') return terminal(child.stdin)
        throw new Error(`Unexpected member: ${String(request.member)}`)
      },
      invokeSync: () => terminal({}),
      subscribeResource: (bindingId, listener) => {
        listeners.set(bindingId, listener)
        return () => listeners.delete(bindingId)
      }
    }, {})!
    const process = (binding.namespace as Record<string, Function>).spawn('tool')
    const stdin = process.stdin as Record<string, Function>
    const delivered: unknown[][] = []

    let writing = true
    const accepted = stdin.write('first', function(error: unknown) {
      delivered.push([arguments.length, error, writing])
    })
    writing = false
    expect(accepted).toBe(false)
    expect(delivered).toEqual([])
    const first = requests.at(-1) as { providerData: { callbackId: number } }
    listeners.get('process-1-stdin')!(JSON.stringify({
      callbackId: first.providerData.callbackId,
      error: null,
      event: 'callback'
    }))
    await Promise.resolve()
    expect(delivered).toEqual([[1, null, false]])

    stdin.write('second', function(error: unknown) {
      delivered.push([arguments.length, (error as { code: string }).code])
    })
    const second = requests.at(-1) as { providerData: { callbackId: number } }
    listeners.get('process-1-stdin')!(JSON.stringify({
      callbackId: second.providerData.callbackId,
      error: errorSnapshot('EIO'),
      event: 'callback'
    }))
    await Promise.resolve()
    expect(delivered.at(-1)).toEqual([1, 'EIO'])

    let endArguments = 0
    expect(stdin.end(function(error: unknown) {
      endArguments = arguments.length
      delivered.push([error])
    })).toBe(stdin)
    expect(endArguments).toBe(0)
    const ending = requests.at(-1) as { providerData: { callbackId: number } }
    listeners.get('process-1-stdin')!(JSON.stringify({
      callbackId: ending.providerData.callbackId,
      error: null,
      event: 'callback'
    }))
    await Promise.resolve()
    expect(endArguments).toBe(1)
    const hostWrites = requests.filter(request => request.member === 'ChildProcess.stdin.write').length
    expect(() => stdin.write('after-end')).toThrowError(expect.objectContaining({ code: 'ERR_INVALID_STATE' }))
    expect(requests.filter(request => request.member === 'ChildProcess.stdin.write')).toHaveLength(hostWrites)
  })

  it('settles an in-flight callback once when the stdin resource closes', async () => {
    const listeners = new Map<string, (event: string) => void>()
    let callbackId = 0
    const child = childSnapshot(2)
    const terminal = (value: unknown) => JSON.stringify({ ok: true, value })
    const binding = createCapabilityChildProcessOverrideV1({
      invoke: async () => terminal({}),
      invokeImmediate: source => {
        const request = JSON.parse(source) as {
          member: string
          providerData?: { callbackId: number }
        }
        if (request.member === 'spawn') return terminal(child)
        callbackId = request.providerData!.callbackId
        return terminal(true)
      },
      invokeSync: () => terminal({}),
      subscribeResource: (bindingId, listener) => {
        listeners.set(bindingId, listener)
        return () => listeners.delete(bindingId)
      }
    }, {})!
    const process = (binding.namespace as Record<string, Function>).spawn('tool')
    const codes: string[] = []
    process.stdin.write('pending', (error: { code: string }) => codes.push(error.code))

    const listener = listeners.get('process-2-stdin')!
    listener(JSON.stringify({ event: 'close' }))
    await Promise.resolve()
    listener(JSON.stringify({ callbackId, error: null, event: 'callback' }))
    await Promise.resolve()
    expect(codes).toEqual(['ERR_INVALID_STATE'])
  })
})
