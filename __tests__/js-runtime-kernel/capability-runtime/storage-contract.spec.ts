import { describe, expect, it } from 'vitest'

import {
  CapabilityInvocationBrokerV1,
  CapabilityRuntimeInvocationKernelV1,
  DEFAULT_SANDBOX_POLICY_V2,
  STORAGE_LIMIT_MAXIMA_V2,
  canonicalizeStorageKvResourceV1,
  canonicalizeStorageSqlResourceV1,
  compileSandboxPolicyV2,
  createStorageInvocationV1,
  mapStorageKernelErrorV1,
  meetStorageCapabilityConstraintsV1,
  storageCapabilitySatisfiesV1,
  storageSelectionForProviderV1
} from '../../../src/capability-runtime/index.js'
import { creation, middleware, policyV2, provider, snapshot } from './broker-fixtures.js'

const limits = { ...STORAGE_LIMIT_MAXIMA_V2, maxValueBytes: 16 }
const storagePolicy = () => ({
  ...policyV2(),
  storage: {
    access: 'sandboxed' as const,
    limits,
    namespaces: [{
      databases: ['main'],
      keyPrefixes: ['notes/'],
      namespaceId: 'default',
      operations: ['storage.kv.get', 'storage.kv.list', 'storage.kv.set', 'storage.sqlite.query'] as const
    }]
  }
})
const request = (
  operation: string,
  args: Record<string, unknown>,
  binary?: readonly { base64: string; handle: string }[]
) =>
  createStorageInvocationV1(
    { args, binary, module: 'host.storage', operation },
    'default',
    'native-controller:1:call:1'
  )

describe('storage shared Policy and Kernel contract', () => {
  it('defaults to none and rejects unknown fields, invalid scalars and limit overflow', () => {
    expect(compileSandboxPolicyV2({ schemaVersion: 2 }).policy.storage).toEqual({ access: 'none' })
    expect(DEFAULT_SANDBOX_POLICY_V2.storage).toEqual({ access: 'none' })
    expect(() => compileSandboxPolicyV2({ schemaVersion: 2, storage: { access: 'none', extra: true } }))
      .toThrow(expect.objectContaining({ code: 'runtime.configuration_invalid' }))
    expect(() =>
      compileSandboxPolicyV2({
        schemaVersion: 2,
        storage: {
          ...storagePolicy().storage,
          limits: { ...limits, maxSqlInstructions: 10_000_001 }
        }
      })
    ).toThrow(expect.objectContaining({ code: 'runtime.configuration_invalid' }))
    expect(() =>
      compileSandboxPolicyV2({
        schemaVersion: 2,
        storage: {
          ...storagePolicy().storage,
          namespaces: [{ ...storagePolicy().storage.namespaces[0], keyPrefixes: ['bad\uD800'] }]
        }
      })
    ).toThrow(expect.objectContaining({ code: 'runtime.configuration_invalid' }))
  })

  it('keeps KV key, list prefix and SQLite database identities distinct and stable', () => {
    const key = canonicalizeStorageKvResourceV1('default', 'key', 'notes/alpha')
    const list = canonicalizeStorageKvResourceV1('default', 'prefix', 'notes/alpha')
    const sql = canonicalizeStorageSqlResourceV1('default', 'main')
    expect(key.semanticResourceDigest).not.toBe(list.semanticResourceDigest)
    expect(key.semanticResourceDigest).not.toBe(sql.semanticResourceDigest)
    expect(sql.semanticResourceDigest).toBe(canonicalizeStorageSqlResourceV1('default', 'main').semanticResourceDigest)
    expect(JSON.stringify(key)).not.toContain('notes/alpha')
    expect(canonicalizeStorageKvResourceV1('other', 'key', 'notes/alpha').semanticResourceDigest)
      .not.toBe(key.semanticResourceDigest)
  })

  it('narrows prefixes and numeric limits but refuses wider authority and cross-namespace meets', () => {
    const available = { ...storagePolicy().storage.namespaces[0], limits }
    const required = {
      databases: [],
      keyPrefixes: ['notes/alpha'],
      limits: { ...limits, maxValueBytes: 8 },
      namespaceId: 'default',
      operations: ['storage.kv.get']
    }
    expect(storageCapabilitySatisfiesV1(available, required)).toBe(true)
    expect(storageCapabilitySatisfiesV1(required, available)).toBe(false)
    expect(meetStorageCapabilityConstraintsV1(available, required)).toMatchObject({
      keyPrefixes: ['notes/alpha'],
      limits: { maxValueBytes: 8 },
      operations: ['storage.kv.get']
    })
    expect(meetStorageCapabilityConstraintsV1(available, { ...required, namespaceId: 'other' })).toBeNull()
  })

  it('maps copied transport bytes to a hash-bound Kernel invocation without changing Storage args on signal', async () => {
    let observed: unknown
    let selection: unknown
    const storage = provider('host.storage', 'async', { found: false }, (context, authority) => {
      observed = context.arguments
      selection = storageSelectionForProviderV1(authority.bindings[0]!, 'storage.kv.get')
      expect(context.providerData).toEqual({ storageCallToken: 'native-controller:1:call:1' })
    })
    const kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted: creation({ 'host.storage': storage }, undefined, storagePolicy()),
      engine: 'node-vm',
      networkProvider: 'host.network',
      requestPrefix: 'storage-test',
      target: 'node'
    })
    const controller = new AbortController()
    expect(JSON.parse(await kernel.invoke(request('v1.kv.get', { key: 'notes/alpha' }), controller.signal)))
      .toEqual({ ok: true, value: { found: false } })
    expect(observed).toEqual({ key: 'notes/alpha', namespaceId: 'default' })
    expect(selection).toMatchObject({
      keyPrefixes: ['notes/alpha'],
      namespaceId: 'default',
      operation: 'storage.kv.get'
    })
    const set = JSON.parse(request('v1.kv.set', { key: 'notes/alpha' }, [{ handle: 'value', base64: 'YQ==' }]))
    expect(set.arguments).toMatchObject({
      valueByteLength: 1,
      valueSha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'
    })
    expect(set).not.toHaveProperty('binary')
  })

  it('denies outside prefix and invalid limits before Middleware and Provider I/O', async () => {
    let middlewareCalls = 0
    let ioCalls = 0
    const storage = provider('host.storage', 'async', { found: false }, () => {
      ioCalls += 1
    })
    const kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted: creation({ 'host.storage': storage }, {
        registrations: [middleware('observe', (_context, next) => {
          middlewareCalls += 1
          return next()
        })],
        schemaVersion: 1
      }, storagePolicy()),
      engine: 'node-vm',
      networkProvider: 'host.network',
      requestPrefix: 'storage-deny',
      target: 'node'
    })
    const outside = JSON.parse(await kernel.invoke(request('v1.kv.get', { key: 'secret' })))
    expect(outside).toMatchObject({ ok: false, error: { code: 'holo.policy_denied' } })
    expect(JSON.parse(await kernel.invoke(request('v1.kv.delete', { key: 'notes/alpha' }))))
      .toMatchObject({ ok: false, error: { code: 'holo.policy_denied' } })
    expect(JSON.parse(
      await kernel.invoke(createStorageInvocationV1({
        args: { key: 'notes/alpha' },
        module: 'host.storage',
        operation: 'v1.kv.get'
      }, 'other'))
    )).toMatchObject({ ok: false, error: { code: 'holo.policy_denied' } })
    const tooLarge = JSON.parse(
      await kernel.invoke(request('v1.kv.set', { key: 'notes/alpha' }, [{
        handle: 'value',
        base64: 'AAAAAAAAAAAAAAAAAAAAAAA='
      }]))
    )
    expect(tooLarge).toMatchObject({ ok: false, error: { code: 'holo.policy_denied' } })
    expect(middlewareCalls).toBe(0)
    expect(ioCalls).toBe(0)
  })

  it('checks Policy output ceilings after a Middleware short circuit with zero Provider I/O', async () => {
    let ioCalls = 0
    const policy = storagePolicy()
    policy.storage.limits = { ...limits, maxKeysPerList: 1, maxRowsPerQuery: 1, maxValueBytes: 1 }
    const storage = provider('host.storage', 'async', null, () => {
      ioCalls += 1
    })
    const kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted: creation({ 'host.storage': storage }, {
        registrations: [middleware('short-circuit', context => {
          if (context.operation === 'storage.kv.get') {
            return snapshot({ found: true, valueBase64: 'YWI=' }, 'result')
          }
          if (context.operation === 'storage.kv.list') {
            return snapshot(['notes/a', 'notes/b'], 'result')
          }
          return snapshot([[['value', 1]], [['value', 2]]], 'result')
        })],
        schemaVersion: 1
      }, policy),
      engine: 'node-vm',
      networkProvider: 'host.network',
      requestPrefix: 'storage-output',
      target: 'node'
    })
    const calls = [
      request('v1.kv.get', { key: 'notes/a' }),
      request('v1.kv.list', { prefix: 'notes/' }),
      request('v1.sqlite.query', { database: 'main', statement: { sql: 'SELECT 1' } })
    ]
    for (const call of calls) {
      expect(JSON.parse(await kernel.invoke(call))).toMatchObject({
        error: { code: 'holo.invalid_result' },
        ok: false
      })
    }
    expect(ioCalls).toBe(0)
  })

  it('rejects resource family mismatch, malformed Provider results and a cancelled generation', async () => {
    const storage = provider('host.storage', 'async', { found: true, valueBase64: '!' })
    const admitted = creation({ 'host.storage': storage }, undefined, storagePolicy())
    const broker = new CapabilityInvocationBrokerV1({ admitted, engine: 'node-vm', target: 'node' })
    await expect(broker.invoke({
      arguments: snapshot({ key: 'notes/alpha', namespaceId: 'default' }, 'argument'),
      invocationMode: 'promise',
      member: 'kv.get',
      module: 'holo:storage',
      requestId: 'cross-family',
      resource: canonicalizeStorageSqlResourceV1('default', 'main')
    })).rejects.toMatchObject({ code: 'resource.invalid' })
    const kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted,
      engine: 'node-vm',
      networkProvider: 'host.network',
      requestPrefix: 'storage-result',
      target: 'node'
    })
    expect(JSON.parse(await kernel.invoke(request('v1.kv.get', { key: 'notes/alpha' }))))
      .toMatchObject({ ok: false, error: { code: 'holo.invalid_result' } })
    const controller = new AbortController()
    controller.abort()
    expect(JSON.parse(await kernel.invoke(request('v1.kv.get', { key: 'notes/alpha' }), controller.signal)))
      .toMatchObject({ ok: false, error: { code: 'holo.operation_cancelled' } })
    expect(mapStorageKernelErrorV1({ code: 'holo.operation_cancelled' })).toBe('storage.cancelled')
    expect(mapStorageKernelErrorV1({ code: 'holo.policy_denied' })).toBe('storage.authorization_denied')
  })

  it('applies the aggregate SQL data budget to short-circuit rows, not just each cell', async () => {
    let io = 0
    let calls = 0
    const policy = storagePolicy()
    policy.storage.limits = { ...limits, maxValueBytes: 4 }
    const kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted: creation({
        'host.storage': provider('host.storage', 'async', null, () => {
          io++
        })
      }, {
        registrations: [middleware('sql-budget', () =>
          snapshot(
            ++calls === 1
              ? [[['x', 'a']]]
              : [[['x', 'a']], [['x', 'b']]],
            'result'
          ))],
        schemaVersion: 1
      }, policy),
      engine: 'node-vm',
      networkProvider: 'host.network',
      requestPrefix: 'sql-budget',
      target: 'node'
    })
    const call = request('v1.sqlite.query', { database: 'main', statement: { sql: 'SELECT 1' } })
    expect(JSON.parse(await kernel.invoke(call))).toMatchObject({ ok: true })
    expect(JSON.parse(await kernel.invoke(call))).toMatchObject({ ok: false, error: { code: 'holo.invalid_result' } })
    expect(io).toBe(0)
  })

  it('cancels an in-flight Storage invocation when its Runtime generation closes', async () => {
    let started!: () => void
    const admitted = creation(
      {
        'host.storage': {
          execution: 'async' as const,
          invoke: () => {
            started()
            return new Promise(() => {})
          },
          module: 'host.storage'
        }
      },
      undefined,
      storagePolicy()
    )
    const kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted,
      engine: 'node-vm',
      networkProvider: 'host.network',
      requestPrefix: 'storage-generation',
      target: 'node'
    })
    const providerStarted = new Promise<void>(resolve => {
      started = resolve
    })
    const terminal = kernel.invoke(request('v1.kv.get', { key: 'notes/alpha' }))
    await providerStarted
    kernel.close(true)
    expect(JSON.parse(await terminal)).toMatchObject({
      error: { code: 'holo.generation_stale' },
      ok: false
    })
  })
})
