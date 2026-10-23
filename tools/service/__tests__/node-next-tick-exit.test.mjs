import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'

import { HolonomyControlCore } from '../control-core.mjs'
import { createNodeRuntimeAdapter } from '../node-target-adapter.mjs'
import { ServiceLogStore } from '../service-log-store.mjs'
import { AtomicServiceStateStore } from '../state-store.mjs'
import { createTargetAdapterDispatcher } from '../target-adapters.mjs'

const waitFor = async (read, predicate) => {
  for (let turn = 0; turn < 1000; turn++) {
    const value = read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Node Service exit did not settle')
}

it('preserves pre-ACK nextTick exit code through Service start and restart without trusting log text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-node-tick-exit-'))
  const core = new HolonomyControlCore({
    adapterDispatcher: createTargetAdapterDispatcher({ node: createNodeRuntimeAdapter() }),
    logStore: new ServiceLogStore({ directory: join(root, 'logs') }),
    store: new AtomicServiceStateStore({ directory: root })
  })
  try {
    await core.open()
    const entryUrl = 'app://fixture/main.mjs'
    const started = await core.startProcess({
      deviceId: 'node:local',
      entryUrl,
      inspectorMode: 'off',
      isolation: 'runtime',
      target: 'node',
      launch: {
        modules: [{
          url: entryUrl,
          source:
            `import process from 'node:process'; console.log('Runtime terminated: process.exit(0)'); process.nextTick(()=>process.exit(4))`
        }]
      }
    }, 'start')
    const id = started.value.process.id
    const operation = operationId => core.get('operations', operationId, 'Operation')
    const process = () => core.get('processes', id, 'Runtime process')
    assert.equal(
      (await waitFor(
        () => operation(started.value.operation.id),
        value => ['succeeded', 'failed'].includes(value.state)
      )).state,
      'succeeded'
    )
    let ended = await waitFor(process, value => value.state === 'failed')
    assert.equal(ended.exit.code, 4)
    const restart = await core.restartProcess(id, ended.generation, 'restart')
    assert.equal(
      (await waitFor(
        () => operation(restart.value.operation.id),
        value => ['succeeded', 'failed'].includes(value.state)
      )).state,
      'succeeded'
    )
    ended = await waitFor(process, value => value.generation === 2 && value.state === 'failed')
    assert.equal(ended.exit.code, 4)
    await core.removeProcess(id, 2, 'remove')
  } finally {
    await core.close()
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
