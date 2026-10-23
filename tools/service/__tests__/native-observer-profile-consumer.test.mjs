import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { runtimePluginBundleDigestV1 } from '../../../packages/runtime/src/app/plugin-bundle.ts'
import { createServiceCapabilityRuntimeManagerV1 } from '../capability-runtime-manager.mjs'
import { materializeNativeLaunch } from '../native-launch-materialization.mjs'
import { privateLaunchLine } from '../native-target-adapter.mjs'
import { publicProcessDto } from '../public-process-dto.mjs'
import { compileSandboxPolicy } from '../sandbox-policy.mjs'

const entryUrl = 'app://workspace/main.mjs'
const guest = 'export {}'
const marker = 'PRIVATE_OBSERVER_SOURCE_SENTINEL'
const bundle = (id = 'monitor', source = `export default () => '${marker}'`, config = {}) => {
  const rootUrl = `holo-plugins:///observer.${id}/`
  const raw = {
    config,
    entryUrl: `${rootUrl}index.mjs`,
    exportName: 'default',
    files: [{
      sha256: createHash('sha256').update(source).digest('hex'),
      source,
      url: `${rootUrl}index.mjs`
    }],
    instanceId: `observer.${id}`,
    rootUrl,
    schemaVersion: 1
  }
  return { ...raw, bundleSha256: runtimePluginBundleDigestV1(raw) }
}
const profile = (id = 'monitor', source) => ({
  bundle: bundle(id, source),
  registration: {
    acceptHighCost: true,
    callbackTimeoutMs: 700,
    events: ['script.compiled'],
    maxQueuedEvents: 16
  },
  sink: { maxBytes: 4096 }
})
const expected = target => ({
  fixture: undefined,
  inspectorMode: 'off',
  launch: {
    argv: [entryUrl],
    command: 'run',
    entryUrl,
    moduleRootUrl: 'app://workspace/',
    modules: [{ source: guest, url: entryUrl }],
    schemaVersion: 2,
    target
  },
  sandboxPolicy: compileSandboxPolicy().policy,
  target
})
const request = (ids = ['monitor'], diagnostics = {}) => ({
  context: {
    guest: { application: { id: 'observer.consumer', name: 'Observer consumer' } },
    host: { tenantId: 'private-tenant' },
    schemaVersion: 1
  },
  initialMiddlewareId: 'service.continue.v1',
  initialObserverIds: ids,
  sandboxPolicy: {
    diagnostics: {
      maxObserverCallbackMs: 1000,
      maxQueuedEvents: 32,
      maxSourceReadBytes: 0,
      observerEvents: ['script.compiled'],
      retentionMs: 0,
      sourceReader: 'none',
      ...diagnostics
    },
    schemaVersion: 2
  },
  schemaVersion: 1
})
const asProcess = capabilityRuntime => ({
  capabilityRuntime,
  generation: 1,
  id: 'observer-consumer',
  launch: expected('native').launch,
  target: 'native'
})
const code = value => error => error.code === value

describe('service Native observer profile consumer', () => {
  it('pins an installed source and stages only selected resources in an owner-private generation', async () => {
    const installed = profile()
    const manager = createServiceCapabilityRuntimeManagerV1({
      nativeObserverProfiles: { monitor: installed },
      observerRegistry: {
        monitor: { observer: () => undefined, registration: { events: ['script.compiled'] } }
      }
    })
    const admitted = manager.admit(request(), expected('native'))
    assert.deepEqual(admitted.initialObserverIds, ['monitor'])
    assert.match(admitted.nativeObserverBindingVersions.monitor, /^[a-f\d]{64}$/u)
    assert(Object.isFrozen(admitted.nativeObserverBindingVersions))
    const process = asProcess(admitted)
    const prepared = await manager.prepare(process)
    assert.equal(prepared.observerProfiles.length, 1)
    assert.equal(prepared.observerProfiles[0].version, admitted.nativeObserverBindingVersions.monitor)
    const root = await mkdtemp(join(tmpdir(), 'holo-service-observer-consumer-'))
    try {
      const staged = await materializeNativeLaunch(process, root, prepared)
      const host = JSON.parse(await readFile(staged.hostConfigPath, 'utf8'))
      assert.equal(host.plugins.length, 0)
      assert.equal(host.observerProfiles.length, 1)
      assert.deepEqual(host.observerProfiles[0], {
        config: {},
        export: 'default',
        id: 'monitor',
        integrity: installed.bundle.bundleSha256,
        registration: prepared.observerProfiles[0].registration,
        sink: { maxBytes: 4096, path: './observer-output/monitor.jsonl' },
        use: './observers/plugin-graphs/r0/observer.monitor/package.json'
      })
      assert.equal(staged.hostConfig.observerProfiles[0].id, 'monitor')
      assert.equal((await stat(join(staged.hostRoot, 'observer-output'))).mode & 0o777, 0o700)
      assert.equal(
        await readFile(
          join(staged.hostRoot, 'observers', 'plugin-graphs', 'r0', 'observer.monitor', 'index.mjs'),
          'utf8'
        ),
        installed.bundle.files[0].source
      )
      const publicValue = JSON.stringify(publicProcessDto({
        ...process,
        entryUrl,
        isolation: 'runtime',
        sandboxPolicy: compileSandboxPolicy().policy,
        state: 'running'
      }))
      assert(!publicValue.includes(marker))
      assert(!publicValue.includes('observer-output'))
      assert(!publicValue.includes(admitted.nativeObserverBindingVersions.monitor))
      assert(!publicValue.includes('private-tenant'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps Native resources separate from Node callbacks and existing inline Native availability', async () => {
    const manager = createServiceCapabilityRuntimeManagerV1({
      nativeObserverProfiles: { monitor: profile() },
      observerRegistry: {
        monitor: {
          observer: () => undefined,
          registration: {
            acceptHighCost: true,
            events: ['script.compiled']
          }
        }
      }
    })
    assert.deepEqual(manager.admit(request(), expected('node')).initialObserverIds, ['monitor'])
    assert.equal(Object.hasOwn(manager.admit(request(), expected('node')), 'nativeObserverBindingVersions'), false)
    assert.deepEqual(manager.admit(request([]), expected('native')).initialObserverIds, [])
    assert.equal(
      Object.hasOwn(
        await manager.prepare(asProcess(manager.admit(request([]), expected('native')))),
        'observerProfiles'
      ),
      false
    )
    assert.throws(
      () =>
        createServiceCapabilityRuntimeManagerV1({
          observerRegistry: {
            monitor: {
              observer: () => undefined,
              registration: {
                acceptHighCost: true,
                events: ['script.compiled']
              }
            }
          }
        }).admit(request(), expected('native')),
      code('sandbox.capability_unsupported')
    )
    assert.throws(() => manager.admit(request(), expected('android')), code('sandbox.capability_unsupported'))
  })

  it('loads the staged Host config for a Native test with only an observer profile', async () => {
    const manager = createServiceCapabilityRuntimeManagerV1({ nativeObserverProfiles: { monitor: profile() } })
    const admitted = manager.admit(request(), expected('native'))
    const process = asProcess(admitted)
    process.launch = { ...process.launch, command: 'test' }
    const prepared = await manager.prepare(process)
    const root = await mkdtemp(join(tmpdir(), 'holo-service-observer-test-launch-'))
    try {
      const staged = await materializeNativeLaunch(process, root, prepared)
      const launch = JSON.parse(privateLaunchLine(process, staged))
      assert.equal(launch.servicePluginConfig, staged.hostConfigPath)
      assert.equal(launch.servicePluginRevision, 0)
      assert.equal(launch.watchConfig, null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prepares lexical numeric IDs after JSON persistence without accepting extra version keys', async () => {
    const manager = createServiceCapabilityRuntimeManagerV1({
      nativeObserverProfiles: {
        1: profile('1'),
        10: profile('10'),
        2: profile('2')
      }
    })
    const admitted = manager.admit(request(['2', '1', '10']), expected('native'))
    assert.deepEqual(admitted.initialObserverIds, ['1', '10', '2'])
    assert.deepEqual(Object.keys(admitted.nativeObserverBindingVersions), ['1', '2', '10'])
    const persisted = JSON.parse(JSON.stringify(admitted))
    const process = asProcess(persisted)
    const prepared = await manager.prepare(process)
    assert.deepEqual(prepared.observerProfiles.map(row => row.id), ['1', '10', '2'])
    const root = await mkdtemp(join(tmpdir(), 'holo-service-observer-numeric-'))
    try {
      const staged = await materializeNativeLaunch(process, root, prepared)
      const host = JSON.parse(await readFile(staged.hostConfigPath, 'utf8'))
      assert.deepEqual(host.observerProfiles.map(row => row.id), ['1', '10', '2'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    persisted.nativeObserverBindingVersions.extra = '0'.repeat(64)
    await assert.rejects(manager.prepare(process), code('service.precondition_failed'))
  })

  it('rejects absent Policy events, exhausted budgets, excessive IDs and public private fields', () => {
    const manager = createServiceCapabilityRuntimeManagerV1({ nativeObserverProfiles: { monitor: profile() } })
    assert.throws(
      () => manager.admit(request(['monitor'], { observerEvents: [] }), expected('native')),
      code('sandbox.capability_unsupported')
    )
    assert.throws(
      () => manager.admit(request(['monitor'], { maxQueuedEvents: 0 }), expected('native')),
      code('sandbox.capability_unsupported')
    )
    assert.throws(
      () => manager.admit(request(['a', 'b', 'c', 'd', 'e']), expected('native')),
      code('service.invalid_request')
    )
    for (const field of ['nativeObserverBindingVersions', 'observerProfiles', 'source', 'path']) {
      assert.throws(
        () => manager.admit({ ...request(), [field]: {} }, expected('native')),
        code('service.invalid_request')
      )
    }
  })

  it('rejects stale manager versions and private staged selection tampering before Guest entry', async () => {
    const original = profile()
    const manager = createServiceCapabilityRuntimeManagerV1({ nativeObserverProfiles: { monitor: original } })
    const admitted = manager.admit(request(), expected('native'))
    const process = asProcess(admitted)
    const prepared = await manager.prepare(process)
    const changed = createServiceCapabilityRuntimeManagerV1({
      nativeObserverProfiles: { monitor: profile('monitor', 'export default () => 1') }
    })
    await assert.rejects(changed.prepare(process), code('service.precondition_failed'))
    await assert.rejects(
      createServiceCapabilityRuntimeManagerV1().prepare(process),
      code('sandbox.capability_unsupported')
    )
    const altered = structuredClone(prepared)
    altered.observerProfiles[0].bundle.files[0].source = 'export default () => 2'
    const root = await mkdtemp(join(tmpdir(), 'holo-service-observer-tamper-'))
    try {
      await assert.rejects(materializeNativeLaunch(process, root, altered), code('service.precondition_failed'))
      await assert.rejects(stat(join(root, 'native-processes', process.id, 'g1')))
      const wrongPin = asProcess(structuredClone(admitted))
      wrongPin.capabilityRuntime.nativeObserverBindingVersions.monitor = '0'.repeat(64)
      await assert.rejects(materializeNativeLaunch(wrongPin, root, prepared), code('service.precondition_failed'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
