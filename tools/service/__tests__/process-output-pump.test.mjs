import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { ProcessOutputPump } from '../process-output-pump.mjs'

const waitFor = async predicate => {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.fail('Timed out waiting for output pump state')
}

const memoryLogStore = persisted => ({
  appendMany: async (_processId, events) => {
    persisted.push(...events)
    return events.map((event, index) => ({ ...event, sequence: persisted.length - events.length + index + 1 }))
  },
  close: async () => undefined,
  open: async () => undefined,
  page: () => ({ cursor: 0, events: [] }),
  prune: async () => 0,
  remove: async () => true
})

describe('process output pump', () => {
  it('ingests Android Network diagnostics without a logs reader and persists only visible output', async () => {
    const diagnostics = []
    const persisted = []
    let calls = 0
    const pump = new ProcessOutputPump({
      adapterDispatcher: {
        target: () => ({
          readLogs: async ({ after }) => {
            calls += 1
            if (after > 0) return { cursor: after, events: [] }
            return {
              cursor: 2,
              events: [
                {
                  chunk: JSON.stringify({
                    requestId: 'native-request',
                    type: 'requestWillBeSent',
                    url: 'https://example.test'
                  }),
                  sequence: 1,
                  stream: 'network'
                },
                { chunk: 'ready', sequence: 2, stream: 'stdout' }
              ]
            }
          }
        })
      },
      inspectorProxy: { emitDiagnostic: (...input) => diagnostics.push(input) },
      logStore: memoryLogStore(persisted),
      pollIntervalMs: 1
    })
    const process = { generation: 3, id: 'process_network', target: 'android' }
    await pump.open()
    await pump.start(process)
    for (let turn = 0; turn < 100 && diagnostics.length === 0; turn += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    await pump.stop(process, { drain: true })
    assert.ok(calls >= 1)
    assert.equal(diagnostics.length, 1)
    assert.deepEqual(diagnostics[0].slice(0, 2), ['process_network', 3])
    assert.deepEqual(persisted, [{ chunk: 'ready', generation: 3, sequence: 2, stream: 'stdout' }])
    await pump.close()
  })

  it('recovers after a transient adapter failure and resets the failure budget', async () => {
    const persisted = []
    let calls = 0
    const failures = []
    const pump = new ProcessOutputPump({
      adapterDispatcher: {
        target: () => ({
          readLogs: async ({ after }) => {
            calls += 1
            if (calls === 1) throw new Error('temporary')
            if (after === 0) return { cursor: 1, events: [{ chunk: 'recovered', sequence: 1, stream: 'stdout' }] }
            return { cursor: after, events: [] }
          }
        })
      },
      logStore: memoryLogStore(persisted),
      maxFailures: 2,
      pollIntervalMs: 1
    })
    pump.setFailureHandler(error => failures.push(error))
    const process = { generation: 1, id: 'process_retry', target: 'node' }
    await pump.open()
    await pump.start(process)
    await waitFor(() => persisted.length === 1)
    await pump.stop(process)
    assert.equal(calls >= 2, true)
    assert.deepEqual(failures, [])
    await pump.close()
  })

  it('reports one terminal failure after bounded consecutive adapter failures', async () => {
    const failures = []
    const pump = new ProcessOutputPump({
      adapterDispatcher: {
        target: () => ({
          readLogs: async () => {
            throw new Error('offline')
          }
        })
      },
      logStore: memoryLogStore([]),
      maxFailures: 3,
      pollIntervalMs: 1
    })
    pump.setFailureHandler((process, error) => failures.push({ error, process }))
    const process = { generation: 2, id: 'process_failed', target: 'android' }
    await pump.open()
    await pump.start(process)
    await waitFor(() => failures.length === 1)
    assert.equal(failures[0].process, process)
    assert.equal(failures[0].error.message, 'offline')
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(failures.length, 1)
    await pump.close()
  })

  it('does not append a late adapter response after a non-draining stop', async () => {
    const persisted = []
    let resolveRead
    let reading = false
    const pump = new ProcessOutputPump({
      adapterDispatcher: {
        target: () => ({
          readLogs: async () => {
            reading = true
            return await new Promise(resolve => resolveRead = resolve)
          }
        })
      },
      logStore: memoryLogStore(persisted),
      pollIntervalMs: 1
    })
    const process = { generation: 4, id: 'process_stop', target: 'node' }
    await pump.open()
    await pump.start(process)
    await waitFor(() => reading)
    const stopping = pump.stop(process)
    resolveRead({ cursor: 1, events: [{ chunk: 'late', sequence: 1, stream: 'stderr' }] })
    await stopping
    assert.deepEqual(persisted, [])
    await pump.close()
  })
})
