import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { RunnerCapabilityActions } from '../control-runner-capabilities.mjs'
import { ControlRegistry } from '../registry.mjs'
import { AtomicServiceStateStore } from '../state-store.mjs'
import { restrictedSandboxPolicy } from './sandbox-fixture.mjs'

const seedProcess = async store => {
  await store.transact({ type: 'test.process_seeded' }, draft => {
    const process = {
      createdAt: 1,
      deviceId: 'android:emulator-5554',
      entryUrl: 'app+local://workspace/main.mjs',
      generation: 1,
      id: 'process_completion',
      inspectorMode: 'enabled',
      isolation: 'runtime',
      launch: {},
      revision: 1,
      sandboxPolicy: restrictedSandboxPolicy(),
      sandboxPolicyDigest: 'test-digest',
      sandboxPolicyState: 'effective',
      state: 'running',
      target: 'android',
      updatedAt: 1
    }
    draft.resources.processes.process_completion = process
    return process
  })
}

const createHarness = async adapter => {
  const directory = await mkdtemp(join(tmpdir(), 'holonomy-capability-completion-'))
  const store = new AtomicServiceStateStore({ directory })
  await store.open()
  await seedProcess(store)
  const registry = new ControlRegistry(store)
  const tasks = new Map()
  const actions = new RunnerCapabilityActions({
    adapterDispatcher: { target: () => adapter },
    inspectorProxy: adapter.inspectorProxy,
    registry,
    schedule: (_deviceId, operationId, work) => {
      tasks.set(operationId, work(new AbortController().signal))
    }
  })
  return {
    actions,
    close: async () => await rm(directory, { force: true, recursive: true }),
    registry,
    task: async operationId => await tasks.get(operationId)
  }
}

const ruleSet = id => ({
  mode: 'passthrough',
  rules: [{
    action: { status: 200, type: 'respond' },
    id,
    match: { method: 'GET', path: { op: 'exact', value: `/${id}` } },
    priority: 1
  }]
})

describe('capability completion fencing', () => {
  it('keeps out-of-order PUT, DELETE, PUT completions bound to admitted revisions', async () => {
    let releaseFirst
    let signalFirst
    const firstStarted = new Promise(resolve => {
      signalFirst = resolve
    })
    const calls = []
    const test = await createHarness({
      applyNetworkRules: async ({ networkRules }) => {
        calls.push(`put:${networkRules.ruleRevision}`)
        if (networkRules.ruleRevision === '1') {
          signalFirst()
          await new Promise(resolve => {
            releaseFirst = resolve
          })
        }
      },
      removeNetworkRules: async ({ networkRules }) => calls.push(`delete:${networkRules.ruleRevision}`)
    })
    try {
      const first = await test.registry.admitNetworkRules(
        'process_completion',
        1,
        ruleSet('first'),
        '0',
        'rules-first'
      )
      test.actions.networkRules(first.value)
      await firstStarted
      const removed = await test.registry.admitNetworkRulesRemove(
        first.value.networkRules.id,
        1,
        '1',
        'rules-remove'
      )
      const third = await test.registry.admitNetworkRules(
        'process_completion',
        1,
        ruleSet('third'),
        '2',
        'rules-third'
      )
      releaseFirst()
      await test.task(first.value.operation.id)
      assert.equal(
        test.registry.get('operations', first.value.operation.id, 'Operation').result.networkRules.ruleRevision,
        '1'
      )
      assert.equal(test.registry.get('networkRules', first.value.networkRules.id, 'Network rules').ruleRevision, '3')
      assert.equal(test.registry.get('networkRules', first.value.networkRules.id, 'Network rules').state, 'applying')

      test.actions.removeNetworkRules(removed.value)
      await test.task(removed.value.operation.id)
      const removeResult = test.registry.get('operations', removed.value.operation.id, 'Operation').result.networkRules
      assert.equal(removeResult.ruleRevision, '2')
      assert.equal(removeResult.state, 'removed')
      assert.equal(test.registry.get('networkRules', first.value.networkRules.id, 'Network rules').state, 'applying')

      test.actions.networkRules(third.value)
      await test.task(third.value.operation.id)
      const current = test.registry.get('networkRules', first.value.networkRules.id, 'Network rules')
      assert.equal(current.ruleRevision, '3')
      assert.equal(current.state, 'active')
      assert.deepEqual(calls, ['put:1', 'delete:2', 'put:3'])
    } finally {
      await test.close()
    }
  })

  it('marks the exact current DELETE revision failed when its adapter removal fails', async () => {
    const test = await createHarness({
      applyNetworkRules: async () => undefined,
      removeNetworkRules: async () => {
        throw new Error('remove failed')
      }
    })
    try {
      const first = await test.registry.admitNetworkRules(
        'process_completion',
        1,
        ruleSet('first'),
        '0',
        'rules-first-current-failure'
      )
      test.actions.networkRules(first.value)
      await test.task(first.value.operation.id)
      const removed = await test.registry.admitNetworkRulesRemove(
        first.value.networkRules.id,
        1,
        '1',
        'rules-remove-current-failure'
      )
      test.actions.removeNetworkRules(removed.value)
      await test.task(removed.value.operation.id)
      const current = test.registry.get('networkRules', first.value.networkRules.id, 'Network rules')
      assert.equal(current.ruleRevision, '2')
      assert.equal(current.state, 'failed')
      assert.equal(test.registry.get('operations', removed.value.operation.id, 'Operation').state, 'failed')
    } finally {
      await test.close()
    }
  })

  it('does not apply a late DELETE failure after a newer PUT revision is admitted', async () => {
    let releaseRemove
    let signalRemove
    const removeStarted = new Promise(resolve => {
      signalRemove = resolve
    })
    const test = await createHarness({
      applyNetworkRules: async () => undefined,
      removeNetworkRules: async () => {
        signalRemove()
        await new Promise(resolve => {
          releaseRemove = resolve
        })
        throw new Error('late remove failed')
      }
    })
    try {
      const first = await test.registry.admitNetworkRules(
        'process_completion',
        1,
        ruleSet('first'),
        '0',
        'rules-first-stale-failure'
      )
      test.actions.networkRules(first.value)
      await test.task(first.value.operation.id)
      const removed = await test.registry.admitNetworkRulesRemove(
        first.value.networkRules.id,
        1,
        '1',
        'rules-remove-stale-failure'
      )
      test.actions.removeNetworkRules(removed.value)
      await removeStarted
      const third = await test.registry.admitNetworkRules(
        'process_completion',
        1,
        ruleSet('third'),
        '2',
        'rules-third-after-failure'
      )
      releaseRemove()
      await test.task(removed.value.operation.id)
      let current = test.registry.get('networkRules', first.value.networkRules.id, 'Network rules')
      assert.equal(current.ruleRevision, '3')
      assert.equal(current.state, 'applying')
      assert.equal(test.registry.get('operations', removed.value.operation.id, 'Operation').state, 'failed')

      test.actions.networkRules(third.value)
      await test.task(third.value.operation.id)
      current = test.registry.get('networkRules', first.value.networkRules.id, 'Network rules')
      assert.equal(current.ruleRevision, '3')
      assert.equal(current.state, 'active')
    } finally {
      await test.close()
    }
  })

  it('discards a late inspector open after the allocating lease is closed', async () => {
    let releaseOpen
    let signalOpen
    let transportCloses = 0
    let adapterCloses = 0
    let proxyAttaches = 0
    const openStarted = new Promise(resolve => {
      signalOpen = resolve
    })
    const transport = { close: () => transportCloses += 1 }
    const test = await createHarness({
      closeInspector: async () => adapterCloses += 1,
      inspectorProxy: {
        attach: () => {
          proxyAttaches += 1
        },
        closeLease: () => false
      },
      openInspector: async () => {
        signalOpen()
        await new Promise(resolve => {
          releaseOpen = resolve
        })
        return { localPort: 9_229, transport }
      }
    })
    try {
      const admitted = await test.registry.admitInspector('process_completion', 1, {}, 'inspector-open')
      test.actions.inspector(admitted.value)
      await openStarted
      await test.registry.updateInspector(admitted.value.inspector.id, 'closed')
      releaseOpen()
      await test.task(admitted.value.operation.id)
      const inspector = test.registry.get('inspectors', admitted.value.inspector.id, 'Inspector lease')
      assert.equal(inspector.state, 'closed')
      assert.equal(inspector.localPort, undefined)
      assert.equal(test.registry.get('operations', admitted.value.operation.id, 'Operation').state, 'cancelled')
      assert.equal(proxyAttaches, 0)
      assert.equal(transportCloses, 1)
      assert.equal(adapterCloses, 1)
    } finally {
      await test.close()
    }
  })
})
