import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { InspectorCdpProxy } from '../inspector-proxy.mjs'

describe('inspector resume coordination', () => {
  it('resumes one exact lease once and rejects its stale session', async () => {
    const calls = []
    const proxy = new InspectorCdpProxy()
    proxy.configureResume(async input => calls.push(input))
    proxy.attach({
      inspector: { generation: 4, id: 'inspector_resume', processId: 'process_resume' },
      process: { generation: 4, id: 'process_resume' },
      transport: {
        close() {},
        send: async message => ({ id: message.id, result: { upstream: true } })
      }
    })
    const session = proxy.connect('inspector_resume', () => undefined)
    for (const id of [1, 2]) {
      assert.deepEqual(await session.receive({ id, method: 'Runtime.runIfWaitingForDebugger' }), {
        id,
        result: { upstream: true }
      })
    }
    assert.deepEqual(calls, [{
      generation: 4,
      idempotencyKey: 'inspector-resume:inspector_resume:4',
      inspectorId: 'inspector_resume',
      processId: 'process_resume'
    }])
    proxy.closeProcess('process_resume', 4)
    assert.deepEqual(await session.receive({ id: 3, method: 'Runtime.runIfWaitingForDebugger' }), {
      error: { code: -32_000, message: 'Inspector operation failed' },
      id: 3
    })
    assert.equal(calls.length, 1)
  })

  it('does not resume a process when its lease closes during an upstream command', async () => {
    const calls = []
    let releaseResponse
    let signalStarted
    const started = new Promise(resolve => {
      signalStarted = resolve
    })
    const proxy = new InspectorCdpProxy()
    proxy.configureResume(async input => calls.push(input))
    proxy.attach({
      inspector: { generation: 5, id: 'inspector_deferred', processId: 'process_deferred' },
      process: { generation: 5, id: 'process_deferred' },
      transport: {
        close() {},
        send: message =>
          new Promise(resolve => {
            releaseResponse = () => resolve({ id: message.id, result: {} })
            signalStarted()
          })
      }
    })
    const session = proxy.connect('inspector_deferred', () => undefined)
    const response = session.receive({ id: 7, method: 'Runtime.runIfWaitingForDebugger' })
    await started
    proxy.closeProcess('process_deferred', 5)
    releaseResponse()
    assert.deepEqual(await response, {
      error: { code: -32_000, message: 'Inspector operation failed' },
      id: 7
    })
    assert.deepEqual(calls, [])
  })
})
