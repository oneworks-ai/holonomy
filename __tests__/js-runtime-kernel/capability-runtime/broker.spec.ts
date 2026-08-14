import { describe, expect, it, vi } from 'vitest'

import {
  CapabilityFacadeDispatcherV1,
  CapabilityInvocationBrokerV1,
  CapabilityInvocationError,
  canonicalizeProcessNetworkEndpointResource
} from '../../../src/capability-runtime/index.js'
import { creation, fsResource, middleware, policyV2, provider, snapshot, systemResource } from './broker-fixtures.js'

const fsInvocation = (mode: 'callback' | 'promise' | 'sync', member = 'readFile') => ({
  arguments: snapshot({
    options: { encoding: 'utf8' },
    path: 'holo-fs://workspace/demo.txt'
  }, 'argument'),
  invocationMode: mode,
  member,
  module: mode === 'promise' ? 'node:fs/promises' : 'node:fs',
  requestId: `request-${mode}`,
  resource: fsResource()
})

describe('capability invocation broker v1', () => {
  it('runs Policy, frozen Koa middleware, narrow authority and Provider in order', async () => {
    const events: string[] = []
    const fs = provider('host.fs', 'async', 'hello', (context, authority) => {
      events.push('provider')
      expect(context.capabilities[0]?.constraints).toMatchObject({
        roots: [{ pathPrefixSegments: ['demo.txt'], rights: ['read'], rootId: 'workspace' }]
      })
      expect(authority.bindings).toHaveLength(1)
    })
    const broker = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }, {
        registrations: [middleware('audit', async (context, next) => {
          events.push(`before:${(context.hostContext as { tenantId: string }).tenantId}`)
          const result = await next()
          events.push('after')
          return result
        })],
        schemaVersion: 1
      }),
      engine: 'node-vm',
      target: 'node'
    })
    const result = await broker.invoke(fsInvocation('promise'))
    expect(result.value).toBe('hello')
    expect(events).toEqual(['before:tenant-a', 'provider', 'after'])
  })

  it('authorizes a Linux process endpoint with source attribution through Host middleware', async () => {
    const endpoint = canonicalizeProcessNetworkEndpointResource({
      hostname: '127.0.0.1',
      label: 'Local package proxy',
      port: 8123,
      transport: 'tcp'
    })
    const observed: unknown[] = []
    const process = provider('host.process', 'sync', undefined, (context, authority) => {
      expect(authority.bindings).toEqual([
        expect.objectContaining({
          capabilityName: 'host.process.network',
          constraints: {
            endpoints: [{ hostname: '127.0.0.1', ports: [8123], transport: 'tcp' }],
            maxSockets: 2
          }
        })
      ])
      return authority.complete(snapshot({
        authorized: true,
        generation: context.runtime.generation,
        invocationBindingDigest: authority.invocationBinding.invocationBindingDigest,
        semanticResourceDigest: endpoint.semanticResourceDigest
      }, 'result'))
    })
    const policy = {
      ...policyV2(),
      process: {
        access: 'sandboxed' as const,
        environment: { allowedNames: [], maxValueBytes: 1024 },
        executables: [{ argumentBytes: 1024, executableId: 'curl' }],
        limits: {
          maxConcurrentProcesses: 1,
          maxExecutionTimeMs: 1000,
          maxOpenPipes: 3,
          maxProcessTreeDepth: 1,
          maxStderrBytes: 1024,
          maxStdinBytes: 1024,
          maxStdoutBytes: 1024,
          maxTotalProcesses: 1,
          maxWritableRootfsBytes: 0
        },
        mounts: [],
        network: {
          access: 'restricted' as const,
          endpoints: [{ hostname: '127.0.0.1', ports: [8123], transport: 'tcp' as const }],
          maxSockets: 2
        },
        shell: { access: 'none' as const }
      }
    }
    const broker = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.process': process }, {
        registrations: [middleware('linux-network-audit', async (context, next) => {
          observed.push({ operation: context.operation, source: context.source })
          return await next()
        })],
        schemaVersion: 1
      }, policy),
      engine: 'node-v8-v86',
      target: 'node'
    })
    await expect(broker.invoke({
      arguments: snapshot({ hostname: '127.0.0.1', port: 8123, transport: 'tcp' }, 'argument'),
      invocationMode: 'promise',
      member: 'authorizeProcessNetwork',
      module: 'holo:runtime',
      preferredProviderModule: 'host.process',
      requestId: 'process-network-1',
      resource: endpoint,
      source: {
        environmentId: 'environment-1',
        environmentScope: 'processTree',
        executableId: 'curl',
        kind: 'linuxProcess',
        linuxPid: 41,
        processResourceId: 'process-resource-1',
        syntheticProcessId: 37
      }
    })).resolves.toEqual(expect.objectContaining({ value: expect.objectContaining({ authorized: true }) }))
    expect(observed).toEqual([{
      operation: 'process.network.connect',
      source: expect.objectContaining({ executableId: 'curl', linuxPid: 41, syntheticProcessId: 37 })
    }])
  })

  it('supports sync interception without allowing async work to run first', () => {
    let providerCalls = 0
    const fs = provider('host.fs', 'sync', 'sync-value', () => {
      providerCalls += 1
    })
    const broker = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }, {
        registrations: [middleware('sync', (_context, next) => next(), 'sync')],
        schemaVersion: 1
      }),
      engine: 'node-vm',
      target: 'node'
    })
    expect(broker.invokeSync(fsInvocation('sync', 'readFileSync')).value).toBe('sync-value')
    expect(providerCalls).toBe(1)

    const rejected = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }, {
        registrations: [middleware('async', async (_context, next) => await next())],
        schemaVersion: 1
      }),
      engine: 'node-vm',
      target: 'node'
    })
    expect(() => rejected.invokeSync(fsInvocation('sync', 'readFileSync'))).toThrow(
      expect.objectContaining({ code: 'runtime.async_required' })
    )
    expect(providerCalls).toBe(1)
  })

  it('projects one terminal into sync, callback and Promise facade delivery', async () => {
    const fs = provider('host.fs', 'sync', 'shared')
    const broker = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }),
      engine: 'node-vm',
      target: 'node'
    })
    const facade = new CapabilityFacadeDispatcherV1(broker, 'nodeFs')
    expect(facade.invokeSync(fsInvocation('sync', 'readFileSync')).value).toBe('shared')
    expect((await facade.invokePromise(fsInvocation('promise'))).value).toBe('shared')
    const callback = await new Promise<{ args: number; error: unknown; value: unknown }>(resolve => {
      facade.invokeCallback(fsInvocation('callback'), function(error, result) {
        resolve({ args: arguments.length, error, value: result?.value })
      })
    })
    expect(callback).toEqual({ args: 2, error: null, value: 'shared' })

    const deniedPolicy = { ...policyV2(), filesystem: { access: 'none' as const } }
    const denied = new CapabilityFacadeDispatcherV1(
      new CapabilityInvocationBrokerV1({
        admitted: creation({ 'host.fs': fs }, undefined, deniedPolicy),
        engine: 'node-vm',
        target: 'node'
      }),
      'nodeFs'
    )
    expect(() => denied.invokeSync(fsInvocation('sync', 'readFileSync'))).toThrow(
      expect.objectContaining({ code: 'EACCES', name: 'Error' })
    )
    const failed = await new Promise<{ args: number; code?: string }>(resolve => {
      denied.invokeCallback(fsInvocation('callback'), function(error) {
        resolve({ args: arguments.length, code: error?.code })
      })
    })
    expect(failed).toEqual({ args: 1, code: 'EACCES' })
  })

  it('validates short-circuit results and rejects a duplicate next call', async () => {
    const fs = provider('host.fs', 'async', 'provider')
    const short = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }, {
        registrations: [middleware('short', () => snapshot('short', 'result'))],
        schemaVersion: 1
      }),
      engine: 'node-vm',
      target: 'node'
    })
    expect((await short.invoke(fsInvocation('promise'))).value).toBe('short')

    const duplicate = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }, {
        registrations: [middleware('duplicate', async (_context, next) => {
          await next()
          return await next()
        })],
        schemaVersion: 1
      }),
      engine: 'node-vm',
      target: 'node'
    })
    await expect(duplicate.invoke(fsInvocation('promise'))).rejects.toMatchObject({ code: 'middleware.failed' })
  })

  it('applies policy before Host middleware and reads only the frozen System projection', () => {
    let middlewareCalls = 0
    const system = provider('host.system', 'sync', 'arm64')
    const broker = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': provider('host.fs', 'sync', 'x'), 'host.system': system }, {
        registrations: [middleware('observe', (_context, next) => {
          middlewareCalls += 1
          return next()
        }, 'sync')],
        schemaVersion: 1
      }),
      engine: 'node-vm',
      target: 'node'
    })
    const value = broker.invokeSync({
      arguments: snapshot({}, 'argument'),
      invocationMode: 'sync',
      member: 'arch',
      module: 'node:os',
      requestId: 'system-arch',
      resource: systemResource()
    })
    expect(value.value).toBe('arm64')
    expect(middlewareCalls).toBe(1)

    const deniedPolicy = {
      ...policyV2(),
      systemInformation: { defaultMode: 'unavailable' as const, fields: {} }
    }
    const denied = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': provider('host.fs', 'sync', 'x'), 'host.system': system }, {
        registrations: [middleware('never', (_context, next) => {
          middlewareCalls += 1
          return next()
        }, 'sync')],
        schemaVersion: 1
      }, deniedPolicy),
      engine: 'node-vm',
      target: 'node'
    })
    expect(() =>
      denied.invokeSync({
        arguments: snapshot({}, 'argument'),
        invocationMode: 'sync',
        member: 'arch',
        module: 'node:os',
        requestId: 'system-denied',
        resource: systemResource()
      })
    ).toThrow(expect.objectContaining({ code: 'policy.denied' }))
    expect(middlewareCalls).toBe(1)
  })

  it('fences timeout, cancellation, live disposal and stopped generations', async () => {
    vi.useFakeTimers()
    const fs = provider('host.fs', 'async', 'done')
    const broker = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }, {
        registrations: [middleware('wait', () => new Promise(() => {}), 'async', 10)],
        schemaVersion: 1
      }),
      engine: 'node-vm',
      target: 'node'
    })
    const pending = expect(broker.invoke(fsInvocation('promise'))).rejects.toMatchObject({
      code: 'middleware.timeout'
    })
    await vi.advanceTimersByTimeAsync(11)
    await pending
    vi.useRealTimers()

    const live = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }),
      engine: 'node-vm',
      target: 'node'
    })
    let calls = 0
    const registration = live.interceptors.use({}, async (_context, next) => {
      calls += 1
      return await next()
    })
    await live.invoke(fsInvocation('promise'))
    registration.dispose()
    registration.dispose()
    await live.invoke({ ...fsInvocation('promise'), requestId: 'after-dispose' })
    expect(calls).toBe(1)
    live.close('generation-stale')
    await expect(live.invoke({ ...fsInvocation('promise'), requestId: 'stale' })).rejects.toMatchObject({
      code: 'runtime.generation_stale'
    })
    expect(() => live.invokeSync(fsInvocation('sync', 'readFileSync'))).toThrow(CapabilityInvocationError)
  })

  it('rejects late Provider completion after cancellation or generation close', async () => {
    let complete: (value: string) => unknown = () => undefined
    const delayed = provider('host.fs', 'async', 'unused', (_context, authority) =>
      new Promise(resolve => {
        complete = value => resolve(authority.complete(snapshot(value, 'result')))
      }))
    const broker = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': delayed }),
      engine: 'node-vm',
      target: 'node'
    })
    const pending = broker.invoke(fsInvocation('promise'))
    await Promise.resolve()
    broker.close('generation-stale')
    await expect(pending).rejects.toMatchObject({ code: 'runtime.generation_stale' })
    expect(() => complete('late')).toThrow(expect.objectContaining({ code: 'runtime.generation_stale' }))

    let cancelledComplete: (value: string) => unknown = () => undefined
    const cancellable = provider('host.fs', 'async', 'unused', (_context, authority) =>
      new Promise(resolve => {
        cancelledComplete = value => resolve(authority.complete(snapshot(value, 'result')))
      }))
    const next = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': cancellable }),
      engine: 'node-vm',
      target: 'node'
    })
    const controller = new AbortController()
    const cancelled = next.invoke({ ...fsInvocation('promise'), requestId: 'cancelled', signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'runtime.cancelled' })
    expect(() => cancelledComplete('late')).toThrow(expect.objectContaining({ code: 'runtime.cancelled' }))
  })

  it('maps Provider failures to a stable terminal without completing authority', async () => {
    const failed = provider('host.fs', 'async', 'unused', () => {
      throw new Error('PRIVATE_PROVIDER_FAILURE')
    })
    const broker = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': failed }),
      engine: 'node-vm',
      target: 'node'
    })
    await expect(broker.invoke(fsInvocation('promise'))).rejects.toMatchObject({ code: 'provider.unavailable' })
  })

  it('publishes generation-bound resources and reuses inherited authority without Host middleware', () => {
    let hostCalls = 0
    let resourceClosed = 0
    let providerCalls = 0
    const fs = provider('host.fs', 'sync', 'unused', (context, authority) => {
      providerCalls += 1
      if (context.member === 'openSync') {
        return authority.complete(snapshot({ binding: 'opaque', fd: 7 }, 'result'), [{
          bindingId: 'fd-7',
          close: () => {
            resourceClosed += 1
          },
          resource: context.resource.requested,
          resourceType: 'filesystem.file-handle'
        }])
      }
      return authority.complete(snapshot({}, 'result'))
    })
    const broker = new CapabilityInvocationBrokerV1({
      admitted: creation({ 'host.fs': fs }, {
        registrations: [middleware('host', (_context, next) => {
          hostCalls += 1
          return next()
        }, 'sync')],
        schemaVersion: 1
      }),
      engine: 'node-vm',
      target: 'node'
    })
    const opened = broker.invokeSync({
      arguments: snapshot({ flag: 'r', path: 'holo-fs://workspace/demo.txt' }, 'argument'),
      invocationMode: 'sync',
      member: 'openSync',
      module: 'node:fs',
      requestId: 'open-resource',
      resource: fsResource()
    })
    expect(opened.value).toEqual({ binding: 'opaque', fd: 7 })
    expect(broker.resource('fd-7').semanticResourceDigest).toBe(fsResource().semanticResourceDigest)

    broker.invokeSync({
      arguments: snapshot({ fd: 7 }, 'argument'),
      inheritedBindingId: 'fd-7',
      invocationMode: 'sync',
      member: 'closeSync',
      module: 'node:fs',
      requestId: 'close-resource',
      resource: fsResource()
    })
    expect({ hostCalls, providerCalls }).toEqual({ hostCalls: 1, providerCalls: 2 })
    expect(resourceClosed).toBe(1)
    expect(() => broker.resource('fd-7')).toThrow(expect.objectContaining({ code: 'runtime.generation_stale' }))
  })
})
