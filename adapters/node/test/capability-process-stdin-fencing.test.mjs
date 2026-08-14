import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

// Adapter integration intentionally consumes the public build output installed in packages.
// eslint-disable-next-line antfu/no-import-dist
import { CapabilityResourceRegistryV1 } from '../../../dist/capability-runtime/index.js'

import { ProcessCallbackEventChannelV1 } from '../src/capability-process-events.mjs'
import { closeProcessStdinV1 } from '../src/capability-process-publications.mjs'

test('generation close synchronously fences pending stdin terminals', () => {
  const channel = new ProcessCallbackEventChannelV1()
  const delivered = []
  let destroys = 0
  const stdin = {
    destroyed: false,
    destroy() {
      destroys += 1
      this.destroyed = true
    }
  }
  const state = {
    child: { stdin },
    pendingStdinCallbacks: new Set([7, 8]),
    stdinClosed: false,
    stdinEnded: false,
    stdinError: undefined,
    stdinEvents: channel
  }
  const registry = new CapabilityResourceRegistryV1({
    engine: 'node-vm',
    generation: 1,
    policyDigest: '1'.repeat(64),
    processId: 'process-stdin-fencing',
    target: 'node'
  })
  const selection = {
    authorityBindings: [{
      authorityDigest: '2'.repeat(64),
      authorityVersion: 1,
      capabilityName: 'host.process.execute',
      constraints: {},
      providerModule: 'host.process'
    }],
    bindings: [],
    branchId: 'process-stdin-fencing',
    requirement: { anyOf: [] }
  }
  registry.publish(
    {
      binding: { bindingId: 'process-1-stdin', generation: 1 },
      resourceType: 'process.stdin'
    },
    [{
      bindingId: 'process-1-stdin',
      close: () => closeProcessStdinV1(state, true),
      eventSchemaId: 'ChildProcessStdinEventV1',
      resourceType: 'process.stdin',
      subscribe: listener => channel.subscribe(listener)
    }],
    'host.process',
    selection
  )
  registry.subscribe('process-1-stdin', event => delivered.push(event))

  registry.close('generation-stale')
  assert.deepEqual(delivered.map(event => event.event), ['callback', 'callback', 'close'])
  assert.deepEqual(delivered.slice(0, 2).map(event => event.callbackId), [7, 8])
  assert.deepEqual(delivered.slice(0, 2).map(event => event.error.code), ['ERR_INVALID_STATE', 'ERR_INVALID_STATE'])
  assert.equal(state.pendingStdinCallbacks.size, 0)
  assert.equal(destroys, 1)

  assert.equal(channel.emit({ callbackId: 7, error: null, event: 'callback' }), false)
  closeProcessStdinV1(state, true)
  assert.equal(delivered.length, 3)
  assert.equal(destroys, 1)
})
