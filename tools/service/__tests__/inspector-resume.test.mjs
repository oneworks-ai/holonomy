import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { InspectorCdpProxy } from '../inspector-proxy.mjs'

describe('inspector resume coordination', () => {
  it('owns Native resume before upstream I/O even when a client and its lease close', async () => {
    const proxy = new InspectorCdpProxy()
    let release
    let entered
    let committed = false
    let calls = 0
    let upstream = 0
    const started = new Promise(resolve => entered = resolve)
    proxy.configureResume(async () => {
      calls++
      entered()
      await new Promise(resolve => release = resolve)
      committed = true
    })
    for (const id of ['one', 'two']) {
      proxy.attach({
        inspector: { generation: 1, id: `inspector_${id}`, processId: 'native_process' },
        process: { generation: 1, id: 'native_process', target: 'native' },
        transport: {
          close() {},
          send: async () => {
            upstream++
            return { result: {} }
          }
        }
      })
    }
    const first = proxy.connect('inspector_one', () => undefined)
    const second = proxy.connect('inspector_two', () => undefined)
    const a = first.receive({ id: 1, method: 'Runtime.runIfWaitingForDebugger' })
    const b = second.receive({ id: 1, method: 'Runtime.runIfWaitingForDebugger' })
    await started
    first.close()
    proxy.closeLease('inspector_one')
    release()
    assert.equal((await a).error.code, -32_000)
    assert.deepEqual(await b, { id: 1, result: {} })
    assert.equal(committed, true)
    assert.equal(calls, 1)
    assert.equal(upstream, 0)
    await proxy.close()
  })

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
