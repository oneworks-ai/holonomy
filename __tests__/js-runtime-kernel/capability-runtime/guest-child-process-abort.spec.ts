import { describe, expect, it } from 'vitest'

import { createCapabilityChildProcessOverrideV1 } from '../../../packages/capabilities/process/src/kernel/guest-child-process-facade.js'

const fixture = (
  onKill?: () => void,
  processControl?: { exit(code: number): void; nextTick(callback: () => void): void }
) => {
  const subscriptions = new Map<string, (value: string) => void>()
  const kills: string[] = []
  let nextId = 0
  const binding = createCapabilityChildProcessOverrideV1({
    invoke: async () => JSON.stringify({ ok: true, value: {} }),
    invokeImmediate: () =>
      JSON.stringify({
        ok: true,
        value: {
          binding: { bindingId: `child-${++nextId}`, generation: 1 },
          pid: nextId,
          resourceType: 'process.child',
          stderr: null,
          stdin: null,
          stdout: null
        }
      }),
    invokeSync: request => {
      const input = JSON.parse(request) as { member: string; arguments: string }
      if (input.member === 'ChildProcess.kill') {
        kills.push(input.arguments)
        onKill?.()
      }
      return JSON.stringify({ ok: true, value: true })
    },
    releaseResource() {},
    subscribeResource: (id, listener) => {
      subscriptions.set(id, listener)
      return () => subscriptions.delete(id)
    }
  }, { processControl, processShellExecutableId: 'shell' })!
  const facade = binding.namespace as Record<string, Function>
  const event = (name: string, tuple: unknown[] = [], id = 'child-1') => {
    subscriptions.get(id)!(JSON.stringify({ event: name, tuple }))
  }
  return { event, facade, kills }
}

describe('controlled child process AbortSignal errors', () => {
  it('delivers pre-aborted spawn error after callers can install a listener', async () => {
    const { facade, kills } = fixture()
    const controller = new AbortController()
    controller.abort()
    const child = facade.spawn!('tool', [], { signal: controller.signal }) as Record<string, Function>
    const errors: Error[] = []
    child.on('error', (error: Error) => errors.push(error))
    expect(errors).toHaveLength(0)
    await Promise.resolve()
    expect(kills).toEqual(['SIGTERM'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'ABORT_ERR', name: 'AbortError' })
  })

  it('uses the Runtime nextTick delegate for a pre-aborted child when installed', async () => {
    const ticks: Array<() => void> = []
    const { facade, kills } = fixture(undefined, {
      exit() {},
      nextTick(callback) {
        ticks.push(callback)
      }
    })
    const controller = new AbortController()
    controller.abort()
    const child = facade.spawn!('tool', [], { signal: controller.signal }) as Record<string, Function>
    const errors: Error[] = []
    child.on('error', (error: Error) => errors.push(error))
    await Promise.resolve()
    expect(kills).toEqual([])
    expect(ticks).toHaveLength(1)
    ticks[0]!()
    expect(kills).toEqual(['SIGTERM'])
    expect(errors[0]).toMatchObject({ code: 'ABORT_ERR', name: 'AbortError' })
  })

  it('delivers one post-abort spawn error, before close, and ignores an abort after close', async () => {
    const { event, facade, kills } = fixture()
    const controller = new AbortController()
    const child = facade.spawn!('tool', [], { signal: controller.signal }) as Record<string, Function>
    const order: string[] = []
    child.on('error', (error: Error) => {
      expect(error).toMatchObject({ code: 'ABORT_ERR', name: 'AbortError' })
      order.push('error')
    })
    child.on('close', () => order.push('close'))
    controller.abort()
    expect(order).toEqual(['error'])
    event('close', [null, 'SIGTERM'])
    await Promise.resolve()
    expect(order).toEqual(['error', 'close'])
    expect(kills).toEqual(['SIGTERM'])

    const later = new AbortController()
    const laterChild = facade.spawn!('tool', [], { signal: later.signal }) as Record<string, Function>
    const lateErrors: Error[] = []
    laterChild.on('error', (error: Error) => lateErrors.push(error))
    event('close', [0, null], 'child-2')
    await Promise.resolve()
    later.abort()
    expect(kills).toEqual(['SIGTERM'])
    expect(lateErrors).toEqual([])
  })

  it.each(['execFile', 'exec'])('%s gives its callback the same AbortError emitted by child', async method => {
    const { event, facade, kills } = fixture()
    const controller = new AbortController()
    let callbackError: Error | null = null
    const callback = (error: Error | null) => {
      callbackError = error
    }
    const child = method === 'execFile'
      ? facade.execFile!('tool', [], { encoding: 'utf8', signal: controller.signal }, callback)
      : facade.exec!('echo hi', { encoding: 'utf8', signal: controller.signal }, callback)
    const errors: Error[] = []
    child.on('error', (error: Error) => errors.push(error))
    controller.abort()
    event('close', [null, 'SIGTERM'])
    await Promise.resolve()
    expect(kills).toEqual(['SIGTERM'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'ABORT_ERR', name: 'AbortError' })
    expect(callbackError).toBe(errors[0])
  })

  it.each(['execFile', 'exec'])(
    '%s pre-aborted signal emits after callback and event listeners attach',
    async method => {
      const { event, facade, kills } = fixture()
      const controller = new AbortController()
      controller.abort()
      let callbackError: Error | null = null
      const callback = (error: Error | null) => {
        callbackError = error
      }
      const child = method === 'execFile'
        ? facade.execFile!('tool', [], { signal: controller.signal }, callback)
        : facade.exec!('echo hi', { signal: controller.signal }, callback)
      const errors: Error[] = []
      child.on('error', (error: Error) => errors.push(error))
      expect(errors).toEqual([])
      await Promise.resolve()
      expect(kills).toEqual(['SIGTERM'])
      expect(errors).toHaveLength(1)
      event('close', [null, 'SIGTERM'])
      await Promise.resolve()
      expect(callbackError).toBe(errors[0])
    }
  )

  it('removes the abort listener after exit even before close', () => {
    const { event, facade, kills } = fixture()
    const controller = new AbortController()
    const child = facade.spawn!('tool', [], { signal: controller.signal }) as Record<string, Function>
    const errors: Error[] = []
    child.on('error', (error: Error) => errors.push(error))
    event('exit', [0, null])
    controller.abort()
    expect(kills).toEqual([])
    expect(errors).toEqual([])
  })

  it('emits the abort error before a close reentered by Host kill', async () => {
    let close = () => {}
    const { event, facade } = fixture(() => close())
    close = () => event('close', [null, 'SIGTERM'])
    const controller = new AbortController()
    const child = facade.spawn!('tool', [], { signal: controller.signal }) as Record<string, Function>
    const order: string[] = []
    child.on('error', () => order.push('error'))
    child.on('close', () => order.push('close'))
    controller.abort()
    expect(order).toEqual(['error'])
    await Promise.resolve()
    expect(order).toEqual(['error', 'close'])
  })

  it('emits the kill failure once instead of inventing an AbortError', () => {
    const failed = Object.assign(new Error('Host refused signal'), { code: 'policy.denied' })
    const { facade } = fixture(() => {
      throw failed
    })
    const controller = new AbortController()
    const child = facade.spawn!('tool', [], { signal: controller.signal }) as Record<string, Function>
    const errors: Error[] = []
    child.on('error', (error: Error) => errors.push(error))
    controller.abort()
    expect(errors).toEqual([failed])
  })

  it('does not duplicate an earlier Host error when abort races close', async () => {
    const { event, facade } = fixture()
    const controller = new AbortController()
    const child = facade.spawn!('tool', [], { signal: controller.signal }) as Record<string, Function>
    const errors: Error[] = []
    child.on('error', (error: Error) => errors.push(error))
    event('error', [{ code: 'provider.failed', message: 'failed' }])
    controller.abort()
    event('close', [null, 'SIGTERM'])
    await Promise.resolve()
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error & { code: string }).code).toBe('provider.failed')
  })
})
