import assert from 'node:assert/strict'
import { it as test } from 'vitest'

// eslint-disable-next-line antfu/no-import-dist -- Verify the Native descriptor against the built shared contract.
import {
  OBSERVER_EVENTS_V1,
  RuntimeObserverRegistryV1,
  compileRuntimeObserverAdmissionV1,
  compileRuntimeObserverPlatformDescriptorV1
} from '../../../../dist/capability-runtime/index.js'
import {
  NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1,
  NATIVE_RUNTIME_OBSERVER_PLATFORM_V1
} from '../bootstrap/native-observer-platform.mjs'
import { NATIVE_RUNTIME_OBSERVER_PLATFORM_V1 as LEGACY_PLATFORM } from '../bootstrap/native-observer.mjs'

test('native Observer descriptor is exact, frozen, and accepted by the shared schema', () => {
  const platform = NATIVE_RUNTIME_OBSERVER_PLATFORM_V1
  assert.equal(LEGACY_PLATFORM, platform)
  assert.deepEqual(compileRuntimeObserverPlatformDescriptorV1(platform), platform)
  assert.deepEqual(platform.events.map(row => row.event), OBSERVER_EVENTS_V1)
  assert.deepEqual(NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1, {
    maxObserverCallbackMs: 1_000,
    maxQueuedEvents: 256
  })
  assert.equal(platform.maxObserverCallbackMs, NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1.maxObserverCallbackMs)
  assert.equal(platform.maxQueuedEvents, NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1.maxQueuedEvents)
  assert.equal(Object.isFrozen(platform), true)
  assert.equal(Object.isFrozen(platform.events), true)
  assert.equal(platform.events.every(Object.isFrozen), true)
  assert.deepEqual(platform.events.filter(row => row.supportLevel === 'optional').map(row => row.event), [
    'runtime.exception',
    'runtime.terminated',
    'script.compiled',
    'script.execution-finished',
    'script.execution-started'
  ])
  assert.deepEqual(platform.events.filter(row => row.supportLevel === 'unsupported').map(row => row.event), [
    'gc.completed',
    'memory.pressure',
    'promise.rejected'
  ])
  for (const row of platform.events) {
    const script = row.event.startsWith('script.')
    assert.equal(row.cost, script ? 'high' : 'low')
    assert.equal(row.optIn, script)
  }
})

test('native Host Registry retains real high-cost opt-in and fixed caps', () => {
  const policy = {
    maxObserverCallbackMs: 5_000,
    maxQueuedEvents: 512,
    observerEvents: ['script.compiled']
  }
  assert.deepEqual(
    compileRuntimeObserverAdmissionV1(
      { acceptHighCost: true, events: ['script.compiled'] },
      policy,
      NATIVE_RUNTIME_OBSERVER_PLATFORM_V1,
      NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1
    ),
    { callbackTimeoutMs: 1_000, events: ['script.compiled'], maxQueuedEvents: 256 }
  )
  const registry = new RuntimeObserverRegistryV1({
    generation: 1,
    hostCaps: NATIVE_RUNTIME_OBSERVER_HOST_CAPS_V1,
    platform: NATIVE_RUNTIME_OBSERVER_PLATFORM_V1,
    policy
  })
  assert.throws(() => registry.subscribe({ events: ['script.compiled'] }, () => undefined))
  const subscription = registry.subscribe({ acceptHighCost: true, events: ['script.compiled'] }, () => undefined)
  subscription.dispose()
  registry.close()
})
