import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

// eslint-disable-next-line antfu/no-import-dist -- Service preparation verifies the built Policy digest.
import { compileSandboxPolicyV2 } from '../../../dist/capability-runtime/index.js'
import { createServiceCapabilityRuntimeManagerV1 } from '../capability-runtime-manager.mjs'
import { compileSandboxPolicy } from '../sandbox-policy.mjs'

const entryUrl = 'app://workspace/main.mjs'
const expected = target => ({
  fixture: undefined,
  inspectorMode: 'off',
  launch: {
    argv: [entryUrl],
    command: 'run',
    entryUrl,
    moduleRootUrl: 'app://workspace/',
    modules: [{ source: 'export {}', url: entryUrl }],
    schemaVersion: 2,
    target
  },
  sandboxPolicy: compileSandboxPolicy().policy,
  target
})
const policyWith = observerEvents => ({
  diagnostics: {
    maxObserverCallbackMs: 5_000,
    maxQueuedEvents: 512,
    maxSourceReadBytes: 0,
    observerEvents,
    retentionMs: 0,
    sourceReader: 'none'
  },
  schemaVersion: 2
})
const request = (observerEvents, initialObserverIds = []) => ({
  context: {
    guest: { application: { id: 'example.guest', name: 'Example Guest' } },
    host: { tenantId: 'private-tenant' },
    inspector: { title: 'Example Guest' },
    schemaVersion: 1
  },
  initialMiddlewareId: 'service.continue.v1',
  initialObserverIds,
  sandboxPolicy: policyWith(observerEvents),
  schemaVersion: 1
})
const asProcess = capabilityRuntime => ({
  ...expected('native'),
  capabilityRuntime,
  generation: 1,
  id: 'native-observer-test'
})
const hasCode = code => error => error.code === code

describe('native managed Runtime Observer admission', () => {
  it('admits supported Policy events with no initial Observer IDs and prepares the same Policy', async () => {
    const manager = createServiceCapabilityRuntimeManagerV1()
    const admitted = manager.admit(
      request([
        'runtime.exception',
        'script.compiled',
        'script.execution-started',
        'script.execution-finished',
        'runtime.terminated'
      ]),
      expected('native')
    )
    assert.deepEqual(admitted.initialObserverIds, [])
    assert.deepEqual(admitted.sandboxPolicy.diagnostics.observerEvents, [
      'runtime.exception',
      'runtime.terminated',
      'script.compiled',
      'script.execution-finished',
      'script.execution-started'
    ])
    const prepared = await manager.prepare(asProcess(admitted))
    assert.equal(prepared.policyDigest, admitted.policyDigest)
    assert.deepEqual(prepared.policy.diagnostics.observerEvents, admitted.sandboxPolicy.diagnostics.observerEvents)
  })

  it.each(['gc.completed', 'memory.pressure', 'promise.rejected'])(
    'rejects unsupported Native event %s before admission',
    event => {
      const manager = createServiceCapabilityRuntimeManagerV1()
      assert.throws(
        () => manager.admit(request([event]), expected('native')),
        hasCode('sandbox.capability_unsupported')
      )
    }
  )

  it('rejects unknown events and all Native initial IDs, including existing Node IDs', () => {
    const manager = createServiceCapabilityRuntimeManagerV1({
      observerHostCaps: { maxObserverCallbackMs: 120_000, maxQueuedEvents: 4096 },
      observerRegistry: {
        'service.node-observer': {
          observer: () => undefined,
          registration: { events: ['script.compiled'] }
        }
      }
    })
    assert.throws(
      () => manager.admit(request(['unknown.event']), expected('native')),
      hasCode('service.invalid_request')
    )
    assert.throws(
      () => manager.admit(request(['gc.completed']), expected('native')),
      hasCode('sandbox.capability_unsupported')
    )
    assert.throws(
      () => manager.admit(request(['script.compiled'], ['service.node-observer']), expected('native')),
      hasCode('sandbox.capability_unsupported')
    )
    assert.throws(
      () => manager.admit(request([], ['service.node-observer']), expected('native')),
      hasCode('sandbox.capability_unsupported')
    )
    const node = manager.admit(request(['script.compiled'], ['service.node-observer']), expected('node'))
    assert.deepEqual(node.initialObserverIds, ['service.node-observer'])
    assert.deepEqual(manager.admit(request([]), expected('native')).sandboxPolicy.diagnostics.observerEvents, [])
  })

  it('revalidates persisted Native event support, IDs, and Policy digest during prepare', async () => {
    const manager = createServiceCapabilityRuntimeManagerV1({
      observerRegistry: {
        'service.node-observer': {
          observer: () => undefined,
          registration: { events: ['script.compiled'] }
        }
      }
    })
    const admitted = manager.admit(request(['script.compiled']), expected('native'))
    const withId = structuredClone(admitted)
    withId.initialObserverIds = ['service.node-observer']
    await assert.rejects(manager.prepare(asProcess(withId)), hasCode('sandbox.capability_unsupported'))

    const unsupported = structuredClone(admitted)
    unsupported.sandboxPolicy.diagnostics.observerEvents = ['gc.completed']
    unsupported.policyDigest = compileSandboxPolicyV2(unsupported.sandboxPolicy).digest
    await assert.rejects(manager.prepare(asProcess(unsupported)), hasCode('sandbox.capability_unsupported'))

    const mismatch = structuredClone(admitted)
    mismatch.sandboxPolicy.diagnostics.observerEvents = ['runtime.exception']
    await assert.rejects(manager.prepare(asProcess(mismatch)), hasCode('service.precondition_failed'))
  })
})
