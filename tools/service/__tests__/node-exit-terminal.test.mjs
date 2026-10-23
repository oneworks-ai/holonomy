import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { it } from 'vitest'

import { createNodeRuntimeAdapter } from '../node-target-adapter.mjs'

it('binds an actual child exit status to its Service generation, not the local supervisor counter', async () => {
  const supervisor = new EventEmitter()
  supervisor.generation = 1
  supervisor.start = async () => ({})
  supervisor.stop = async () => undefined
  const adapter = createNodeRuntimeAdapter({ createSupervisor: () => supervisor })
  const process = {
    id: 'service_process',
    generation: 2,
    inspectorMode: 'off',
    entryUrl: 'app://fixture/main.mjs',
    launch: {}
  }
  try {
    await adapter.startProcess({ process })
    const terminals = []
    await adapter.subscribeProcess({ process, onTerminal: value => terminals.push(value) })
    supervisor.emit('exit', { code: 4, generation: 1, signal: null })
    supervisor.emit('state', { state: 'failed' })
    assert.deepEqual(terminals, [{ exit: { code: 4, reason: 'failed' }, generation: 2, state: 'failed' }])
    supervisor.emit('exit', { code: 0, generation: 1, signal: null })
    assert.equal(terminals.length, 1)
  } finally {
    await adapter.close()
  }
})
