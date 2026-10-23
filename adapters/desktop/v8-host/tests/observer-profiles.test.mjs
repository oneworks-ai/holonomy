import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it as test } from 'vitest'

import { compileRuntimeCreationHostBindingsV1 } from '../../../../packages/runtime/src/kernel/index.ts'

import { createNativeObserverProfilesV1 } from '../bootstrap/observer-profiles.mjs'

const source = 'export default (_event, _config, sink) => sink.publish()'
const bytes = new TextEncoder().encode(source)
const sourceSha256 = createHash('sha256').update(bytes).digest('hex')
const moduleFor = id => ({
  config: { label: id },
  configSchema: null,
  entryUrl: `holo-plugins:///observer.${id}/index.mjs`,
  exportName: 'default',
  instanceId: `observer.${id}`,
  integrity: null,
  rootUrl: `holo-plugins:///observer.${id}/`
})
const profile = (id, registration = { events: ['runtime.terminated'] }) => ({
  id,
  module: moduleFor(id),
  registration
})
const policy = {
  diagnostics: {
    maxObserverCallbackMs: 100,
    maxQueuedEvents: 16,
    observerEvents: ['runtime.terminated', 'script.compiled']
  }
}
const createHarness = () => {
  const calls = []
  const subscriptions = []
  const native = {
    now: () => 0,
    observerProfileSource(id, url) {
      calls.push(['source', id, url])
      return JSON.stringify({ bytes: [...bytes], sha256: sourceSha256 })
    },
    observerProfileStart(...args) {
      calls.push(['start', ...args])
      return true
    },
    observerProfileStatus: id => {
      calls.push(['status', id])
      return 'ready'
    },
    observerProfilePublish(id, event) {
      calls.push(['publish', id, event])
      return true
    },
    observerProfilesClose() {
      calls.push(['close'])
    },
    schedule: (callback, delay) => setTimeout(callback, delay),
    clear: id => clearTimeout(id)
  }
  const observers = {
    observe(registration, callback) {
      calls.push(['observe', registration])
      subscriptions.push(callback)
      return { dispose: () => calls.push(['dispose']) }
    }
  }
  return { calls, native, observers, subscriptions }
}
const useVirtualHostClock = native => {
  let now = 0
  let nextTimer = 0
  native.now = () => now
  native.schedule = (callback, delay) => {
    queueMicrotask(() => {
      now += delay
      callback()
    })
    return ++nextTimer
  }
  native.clear = () => {}
  return () => now
}

test('profiles reject denied high-cost registration before any helper starts', async () => {
  const { calls, native, observers } = createHarness()
  const manager = createNativeObserverProfilesV1(native, policy, observers)
  await assert.rejects(manager.prepare([
    profile('first'),
    profile('monitor', { events: ['script.compiled'] })
  ]))
  assert.equal(calls.some(call => call[0] === 'start'), false)
  assert.equal(calls.some(call => call[0] === 'source'), false)
  manager.close()
})

test('profiles reject a later mismatched source identity before source reading', async () => {
  const { calls, native, observers } = createHarness()
  const manager = createNativeObserverProfilesV1(native, policy, observers)
  await assert.rejects(manager.prepare([
    profile('first'),
    { ...profile('second'), module: { ...moduleFor('second'), instanceId: 'observer.first' } }
  ]))
  assert.equal(calls.some(call => call[0] === 'source' || call[0] === 'start'), false)
  manager.close()
})

test('profiles reject bundle integrity before any helper starts', async () => {
  const { calls, native, observers } = createHarness()
  const manager = createNativeObserverProfilesV1(native, policy, observers)
  await assert.rejects(manager.prepare([{
    ...profile('monitor'),
    module: {
      ...moduleFor('monitor'),
      integrity: '0'.repeat(64)
    }
  }]))
  assert.equal(calls.some(call => call[0] === 'start'), false)
  manager.close()
})

test('profile planning rejects a source above the diagnostic module limit before helper start', async () => {
  const { calls, native, observers } = createHarness()
  const oversized = new TextEncoder().encode(`${source}\n${' '.repeat(1024 * 1024)}`)
  native.observerProfileSource = () =>
    JSON.stringify({
      bytes: [...oversized],
      sha256: createHash('sha256').update(oversized).digest('hex')
    })
  const manager = createNativeObserverProfilesV1(native, policy, observers)
  await assert.rejects(manager.prepare([profile('monitor')]))
  assert.equal(calls.some(call => call[0] === 'start'), false)
  manager.close()
})

test('all plans prepare before helpers start, and forwarding binds only after ready', async () => {
  const { calls, native, observers, subscriptions } = createHarness()
  const manager = createNativeObserverProfilesV1(native, policy, observers)
  await manager.prepare([profile('first'), profile('second')])
  assert.deepEqual(calls.map(call => call[0]), ['source', 'source'])
  assert.throws(() => manager.bind('desktop-host'))
  await manager.start()
  const { bindings, references } = manager.bind('desktop-host')
  assert.deepEqual(references.map(item => item.bindingId), ['observer.first', 'observer.second'])
  assert.equal(bindings.size, 2)
  assert.equal(references[0].version, calls.find(call => call[0] === 'start')[3])
  assert.deepEqual(
    compileRuntimeCreationHostBindingsV1({
      engineGate: { bindingId: 'gate', ownerId: 'desktop-host', version: '1' },
      initialMiddlewareSet: { bindingId: 'middleware', ownerId: 'desktop-host', version: '1' },
      initialObservers: references,
      moduleResolver: { bindingId: 'resolver', ownerId: 'desktop-host', version: '1' },
      providerBindings: []
    }).initialObservers.map(item => item.bindingId),
    ['observer.first', 'observer.second']
  )
  manager.subscribe(bindings)
  assert.equal(subscriptions.length, 2)
  subscriptions[0]({
    event: 'runtime.terminated',
    generation: 1,
    observedAt: 0,
    payload: { reason: 'completed' },
    schemaVersion: 1,
    sequence: 1
  })
  const publish = calls.find(call => call[0] === 'publish')
  assert.equal(publish[1], 'first')
  assert.equal(JSON.parse(publish[2]).event, 'runtime.terminated')
  subscriptions[0]({
    event: 'runtime.terminated',
    generation: 1,
    observedAt: 0,
    payload: { reason: 'completed' },
    schemaVersion: 1,
    sequence: 2,
    source: 'private'
  })
  assert.equal(calls.filter(call => call[0] === 'publish').length, 1)
  manager.close()
  assert.deepEqual(calls.slice(-3).map(call => call[0]), ['dispose', 'dispose', 'close'])
})

test('helper readiness failure closes all candidates before subscription', async () => {
  const { calls, native, observers } = createHarness()
  native.observerProfileStatus = () => 'failed'
  const manager = createNativeObserverProfilesV1(native, policy, observers)
  await manager.prepare([profile('first'), profile('second')])
  await assert.rejects(manager.start())
  assert.equal(calls.some(call => call[0] === 'observe'), false)
  assert.equal(calls.some(call => call[0] === 'close'), true)
})

test('readiness waits through the Host timer without subscribing early', async () => {
  const { calls, native, observers } = createHarness()
  let polls = 0
  native.observerProfileStatus = () => ++polls < 3 ? 'starting' : 'ready'
  const manager = createNativeObserverProfilesV1(native, policy, observers)
  await manager.prepare([profile('monitor')])
  await manager.start()
  assert.equal(polls, 3)
  assert.equal(calls.some(call => call[0] === 'observe'), false)
  manager.close()
})

test('readiness permits mixed ready and starting helpers without publishing early', async () => {
  const { calls, native, observers } = createHarness()
  const now = useVirtualHostClock(native)
  native.observerProfileStatus = id => id === 'first' || now() >= 30 ? 'ready' : 'starting'
  const manager = createNativeObserverProfilesV1(native, policy, observers)
  await manager.prepare([profile('first'), profile('second')])
  assert.throws(() => manager.bind('desktop-host'))
  await manager.start()
  assert.equal(now(), 30)
  assert.equal(manager.bind('desktop-host').references.length, 2)
  assert.equal(calls.some(call => call[0] === 'observe'), false)
  manager.close()
})

test('an unknown helper status still fails closed when another helper is ready', async () => {
  const { calls, native, observers } = createHarness()
  native.observerProfileStatus = id => id === 'first' ? 'ready' : 'unknown'
  const manager = createNativeObserverProfilesV1(native, policy, observers)
  await manager.prepare([profile('first'), profile('second')])
  await assert.rejects(manager.start(), /readiness timed out/u)
  assert.equal(calls.filter(call => call[0] === 'close').length, 1)
  assert.equal(calls.some(call => call[0] === 'observe'), false)
})

test('readiness accepts a helper after its third bounded initialization attempt', async () => {
  const { calls, native, observers } = createHarness()
  const now = useVirtualHostClock(native)
  native.observerProfileStatus = () => now() >= 6_100 ? 'ready' : 'starting'
  const manager = createNativeObserverProfilesV1(native, policy, observers)
  await manager.prepare([profile('monitor')])
  await manager.start()
  assert.equal(now(), 6_100)
  assert.equal(manager.bind('desktop-host').references.length, 1)
  assert.equal(calls.some(call => call[0] === 'observe'), false)
  manager.close()
})

test('readiness stops at the total initialization budget and closes candidates', async () => {
  const { calls, native, observers } = createHarness()
  const now = useVirtualHostClock(native)
  native.observerProfileStatus = () => 'starting'
  const manager = createNativeObserverProfilesV1(native, policy, observers)
  await manager.prepare([profile('monitor')])
  await assert.rejects(manager.start(), /readiness timed out/u)
  assert.equal(now(), 7_000)
  assert.equal(calls.filter(call => call[0] === 'close').length, 1)
  assert.equal(calls.some(call => call[0] === 'observe'), false)
})
