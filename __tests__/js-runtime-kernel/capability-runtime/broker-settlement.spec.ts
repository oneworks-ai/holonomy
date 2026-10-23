import { describe, expect, it, vi } from 'vitest'

import {
  CapabilityInvocationBrokerV1,
  CapabilityInvocationError,
  CapabilityRuntimeInvocationKernelV1,
  STORAGE_LIMIT_MAXIMA_V2,
  createStorageInvocationV1
} from '../../../src/capability-runtime/index.js'
import type { HoloMiddlewareNextV1 } from '../../../src/capability-runtime/index.js'
import { creation, fsResource, policyV2, provider, snapshot } from './broker-fixtures.js'

const fsInvocation = (requestId: string, mode: 'promise' | 'sync' = 'promise') => ({
  arguments: snapshot({ options: { encoding: 'utf8' }, path: 'holo-fs://workspace/demo.txt' }, 'argument'),
  invocationMode: mode,
  member: mode === 'sync' ? 'readFileSync' : 'readFile',
  module: mode === 'sync' ? 'node:fs' : 'node:fs/promises',
  requestId,
  resource: fsResource()
})

describe('capability Broker frame settlement', () => {
  it('returns an outer short circuit promptly but retains the retired graph and closes unpublished resources', async () => {
    let started!: () => void
    const providerStarted = new Promise<void>(resolve => started = resolve)
    let finish!: () => void
    let resourceCloses = 0
    const fs = {
      execution: 'async' as const,
      module: 'host.fs',
      invoke: (_context: unknown, authority: Parameters<ReturnType<typeof provider>['invoke']>[1]) => {
        const terminal = authority.complete(snapshot('inner', 'result'), [{
          bindingId: 'unpublished',
          close: () => {
            resourceCloses += 1
          },
          resourceType: 'fs.file'
        }])
        started()
        return new Promise<typeof terminal>(resolve => finish = () => resolve(terminal))
      }
    }
    const broker = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }),
      engine: 'node-vm',
      target: 'node'
    })
    const oldScope = broker.createPluginInterceptorScope('old')
    oldScope.use({}, async (_context, next) => {
      void next()
      await providerStarted
      return snapshot('outer', 'result')
    })
    broker.publishPluginGraph(1, [oldScope])
    const tracked = broker.invokeTracked(fsInvocation('outer-short-circuit'))
    await providerStarted
    broker.publishPluginGraph(2, [])
    let drained = false
    const drain = broker.drainPluginGraph(1).then(() => {
      drained = true
    })
    expect((await tracked.result).value).toBe('outer')
    expect(drained).toBe(false)
    expect(resourceCloses).toBe(0)
    finish()
    await tracked.settled
    await drain
    expect(drained).toBe(true)
    expect(resourceCloses).toBe(1)
  })

  it('cancels a synchronous deny after void next before Provider I/O, and poisons a caught duplicate next', async () => {
    let io = 0
    const fs = provider('host.fs', 'async', 'inner', () => {
      io += 1
    })
    const denied = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }, {
        registrations: [{
          execution: 'async',
          layer: 'application',
          matcher: {},
          registrationId: 'deny',
          middleware: (_context, next) => {
            void next()
            throw new CapabilityInvocationError('middleware.permission_denied', 'filesystem.file.read')
          }
        }],
        schemaVersion: 1
      }),
      engine: 'node-vm',
      target: 'node'
    })
    const terminal = denied.invokeTracked(fsInvocation('deny-before-provider'))
    await expect(terminal.result).rejects.toMatchObject({ code: 'middleware.permission_denied' })
    await terminal.settled
    expect(io).toBe(0)

    const asyncDenied = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }, {
        registrations: [{
          execution: 'async',
          layer: 'application',
          matcher: {},
          registrationId: 'async-deny',
          middleware: async (_context, next) => {
            void next()
            throw new CapabilityInvocationError('middleware.permission_denied', 'filesystem.file.read')
          }
        }],
        schemaVersion: 1
      }),
      engine: 'node-vm',
      target: 'node'
    })
    const asyncTerminal = asyncDenied.invokeTracked(fsInvocation('async-deny-before-provider'))
    await expect(asyncTerminal.result).rejects.toMatchObject({ code: 'middleware.permission_denied' })
    await asyncTerminal.settled
    expect(io).toBe(0)

    const short = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }, {
        registrations: [{
          execution: 'async',
          layer: 'application',
          matcher: {},
          registrationId: 'short',
          middleware: async (_context, next) => {
            void next()
            return snapshot('outer', 'result')
          }
        }],
        schemaVersion: 1
      }),
      engine: 'node-vm',
      target: 'node'
    })
    const shortTerminal = short.invokeTracked(fsInvocation('short-before-provider'))
    expect((await shortTerminal.result).value).toBe('outer')
    await shortTerminal.settled
    expect(io).toBe(0)

    const duplicate = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }, {
        registrations: [{
          execution: 'async',
          layer: 'application',
          matcher: {},
          registrationId: 'duplicate',
          middleware: async (_context, next) => {
            const first = next()
            try {
              await next()
            } catch {}
            await Promise.resolve(first).catch(() => undefined)
            return snapshot('forged-success', 'result')
          }
        }],
        schemaVersion: 1
      }),
      engine: 'node-vm',
      target: 'node'
    })
    await expect(duplicate.invoke(fsInvocation('duplicate-next'))).rejects.toMatchObject({ code: 'middleware.failed' })
    expect(io).toBe(0)
  })

  it('reports deny after Provider start promptly, then holds settlement until late work finishes', async () => {
    let started!: () => void
    const providerStarted = new Promise<void>(resolve => started = resolve)
    let finish!: () => void
    let io = 0
    const fs = {
      execution: 'async' as const,
      module: 'host.fs',
      invoke: (_context: unknown, authority: Parameters<ReturnType<typeof provider>['invoke']>[1]) => {
        io += 1
        const terminal = authority.complete(snapshot('already-started', 'result'))
        started()
        return new Promise<typeof terminal>(resolve => finish = () => resolve(terminal))
      }
    }
    const broker = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }, {
        registrations: [{
          execution: 'async',
          layer: 'application',
          matcher: {},
          registrationId: 'deny-after-start',
          middleware: async (_context, next) => {
            void next()
            await providerStarted
            throw new CapabilityInvocationError('middleware.permission_denied', 'filesystem.file.read')
          }
        }],
        schemaVersion: 1
      }),
      engine: 'node-vm',
      target: 'node'
    })
    const tracked = broker.invokeTracked(fsInvocation('deny-after-start'))
    await providerStarted
    await expect(tracked.result).rejects.toMatchObject({ code: 'middleware.permission_denied' })
    let settled = false
    void tracked.settled.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(io).toBe(1) // Started I/O cannot be retroactively rolled back.
    finish()
    await tracked.settled
    expect(settled).toBe(true)
  })

  it('rejects late next after a terminal and retains a sync Promise frame until it settles', async () => {
    let lateNext!: HoloMiddlewareNextV1
    let io = 0
    const fs = provider('host.fs', 'sync', 'inner', () => {
      io += 1
    })
    const broker = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }),
      engine: 'node-vm',
      target: 'node'
    })
    const oldScope = broker.createPluginInterceptorScope('late')
    oldScope.use({}, (_context, next) => {
      lateNext = next
      return snapshot('outer', 'result')
    })
    broker.publishPluginGraph(1, [oldScope])
    expect((await broker.invoke(fsInvocation('late-next'))).value).toBe('outer')
    await expect(lateNext()).rejects.toMatchObject({ code: 'middleware.failed' })
    expect(io).toBe(0)

    let rejectLate!: (error: Error) => void
    const syncScope = broker.createPluginInterceptorScope('sync')
    syncScope.use({}, () =>
      new Promise((_resolve, reject) => {
        rejectLate = reject
      }), { execution: 'sync' })
    broker.publishPluginGraph(2, [syncScope])
    expect(() => broker.invokeSync(fsInvocation('sync-promise', 'sync')))
      .toThrow(expect.objectContaining({ code: 'runtime.async_required' }))
    broker.publishPluginGraph(3, [])
    let drained = false
    const drain = broker.drainPluginGraph(2).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    rejectLate(new Error('late rejection'))
    await drain
    expect(drained).toBe(true)
    expect(io).toBe(0)

    let rejectProvider!: (error: Error) => void
    const nonCooperative = new CapabilityInvocationBrokerV1({
      admitted: creation({
        'host.fs': {
          execution: 'sync',
          module: 'host.fs',
          invoke: () =>
            new Promise((_resolve, reject) => {
              rejectProvider = reject
            })
        }
      }),
      engine: 'node-vm',
      target: 'node'
    })
    nonCooperative.publishPluginGraph(1, [])
    expect(() => nonCooperative.invokeSync(fsInvocation('sync-provider-promise', 'sync')))
      .toThrow(expect.objectContaining({ code: 'runtime.async_required' }))
    nonCooperative.publishPluginGraph(2, [])
    let providerDrained = false
    const providerDrain = nonCooperative.drainPluginGraph(1).then(() => {
      providerDrained = true
    })
    await Promise.resolve()
    expect(providerDrained).toBe(false)
    rejectProvider(new Error('late provider rejection'))
    await providerDrain
    expect(providerDrained).toBe(true)
  })

  it('holds the Storage Policy pending slot through an unawaited Provider frame', async () => {
    let started!: () => void
    const providerStarted = new Promise<void>(resolve => started = resolve)
    let finish!: () => void
    let io = 0
    const storage = {
      execution: 'async' as const,
      module: 'host.storage',
      invoke: (_context: unknown, authority: Parameters<ReturnType<typeof provider>['invoke']>[1]) => {
        io += 1
        const terminal = authority.complete(snapshot({ found: false }, 'result'))
        if (io === 1) {
          started()
          return new Promise<typeof terminal>(resolve => finish = () => resolve(terminal))
        }
        return Promise.resolve(terminal)
      }
    }
    const policy = {
      ...policyV2(),
      storage: {
        access: 'sandboxed' as const,
        limits: { ...STORAGE_LIMIT_MAXIMA_V2, maxPendingOperations: 1 },
        namespaces: [{
          databases: [],
          keyPrefixes: [''],
          namespaceId: 'default',
          operations: ['storage.kv.get'] as const
        }]
      }
    }
    const kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted: creation({ 'host.storage': storage }, {
        registrations: [{
          execution: 'async',
          layer: 'application',
          matcher: {},
          registrationId: 'short',
          middleware: async (_context, next) => {
            void next()
            await providerStarted
            return snapshot({ found: false }, 'result')
          }
        }],
        schemaVersion: 1
      }, policy),
      engine: 'node-vm',
      networkProvider: 'host.network',
      requestPrefix: 'storage-slot',
      target: 'node'
    })
    const request = (key: string) =>
      createStorageInvocationV1({
        args: { key },
        module: 'host.storage',
        operation: 'v1.kv.get'
      })
    const first = kernel.invokeTracked(request('first'))
    await providerStarted
    expect(JSON.parse(await first.result)).toMatchObject({ ok: true, value: { found: false } })
    expect(JSON.parse(await kernel.invokeTracked(request('second')).result))
      .toMatchObject({ ok: false, error: { code: 'holo.resource_exhausted' } })
    expect(io).toBe(1)
    finish()
    await first.settled
    expect(JSON.parse(await kernel.invokeTracked(request('third')).result))
      .toMatchObject({ ok: true, value: { found: false } })
  })

  it('returns cancellation and timeout promptly while retired graph leases await raw frame settlement', async () => {
    let started!: () => void
    const providerStarted = new Promise<void>(resolve => started = resolve)
    let rejectProvider!: (error: Error) => void
    const fs = {
      execution: 'async' as const,
      module: 'host.fs',
      invoke: () =>
        new Promise((_resolve, reject) => {
          rejectProvider = reject
          started()
        })
    }
    const broker = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }),
      engine: 'node-vm',
      target: 'node'
    })
    const old = broker.createPluginInterceptorScope('cancel-old')
    old.use({}, async (_context, next) => await next())
    broker.publishPluginGraph(1, [old])
    const controller = new AbortController()
    const tracked = broker.invokeTracked({ ...fsInvocation('cancel-raw'), signal: controller.signal })
    await providerStarted
    broker.publishPluginGraph(2, [])
    let drained = false
    const drain = broker.drainPluginGraph(1).then(() => {
      drained = true
    })
    controller.abort()
    await expect(tracked.result).rejects.toMatchObject({ code: 'runtime.cancelled' })
    expect(drained).toBe(false)
    rejectProvider(new Error('late private failure'))
    await tracked.settled
    await drain
    expect(drained).toBe(true)

    vi.useFakeTimers()
    try {
      let resolveMiddleware!: (value: ReturnType<typeof snapshot>) => void
      const slow = new CapabilityInvocationBrokerV1({
        admitted: creation({ 'host.fs': provider('host.fs', 'async', 'unused') }, {
          registrations: [{
            execution: 'async',
            layer: 'application',
            matcher: {},
            registrationId: 'timeout-raw',
            timeoutMs: 10,
            middleware: () =>
              new Promise(resolve => {
                resolveMiddleware = resolve
              })
          }],
          schemaVersion: 1
        }),
        engine: 'node-vm',
        target: 'node'
      })
      const timeout = slow.invokeTracked(fsInvocation('timeout-raw'))
      const rejected = expect(timeout.result).rejects.toMatchObject({ code: 'middleware.timeout' })
      await vi.advanceTimersByTimeAsync(11)
      await rejected
      let settled = false
      void timeout.settled.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      resolveMiddleware(snapshot('late', 'result'))
      await timeout.settled
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
