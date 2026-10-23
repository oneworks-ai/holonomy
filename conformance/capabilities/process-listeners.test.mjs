import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { it } from 'node:test'

// This workload runs inside a real Native Guest. Its caller supplies an
// explicitly allowlisted executable/profile; it never relies on PATH lookup.
export const registerNativeProcessListenerTests = ({ executableId, args }) => {
  it('keeps pipe listener removal and snapshot delivery observable through the Native Process profile', async () => {
    const child = spawn(executableId, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const received = []
    const chunks = []
    let deliveries = 0
    const second = () => received.push('second')
    const late = () => received.push('late')
    const first = chunk => {
      chunks.push(chunk)
      deliveries++
      received.push('first')
      child.stdout.removeListener('data', second)
      if (deliveries === 1) child.stdout.on('data', late)
    }
    const once = () => received.push('once')
    child.stdout.on('data', first)
    child.stdout.on('data', second)
    child.stdout.once('data', once)
    assert.equal(child.stdout.listeners('data').at(-1), once)
    assert.equal(child.stdout.removeListener('data', once), child.stdout)
    assert.equal(child.stdout.listenerCount('data'), 2)
    assert.deepEqual(child.stdout.eventNames(), ['data'])

    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    // A single Host data event snapshots its initial records: removing second
    // while first runs cannot suppress it, and reentrant additions wait.
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'LISTENER_PAYLOAD\n')
    assert(deliveries > 0)
    assert.deepEqual(received.slice(0, 2), ['first', 'second'])
    assert.equal(received.filter(value => value === 'first').length, deliveries)
    assert.equal(received.filter(value => value === 'second').length, 1)
    assert.equal(received.filter(value => value === 'late').length, deliveries - 1)
    assert.equal(received.includes('once'), false)
    assert.equal(child.stdout.listenerCount('data'), 0)
    assert.deepEqual(child.eventNames(), [])
  })
}
