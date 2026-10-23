/* eslint-disable test/no-import-node-test -- Unit tests for a Host-only test fixture. */
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { createSustainedHttpFixture, sustainedDuration, verifyRuntimeStopped } from './sustained_native_fixture.mjs'

test('sustained duration defaults and strict finite bounds preserve the baseline', () => {
  assert.equal(sustainedDuration(undefined), 185_000)
  assert.equal(sustainedDuration('185000'), 185_000)
  assert.equal(sustainedDuration('300000'), 300_000)
  assert.equal(sustainedDuration('1800000'), 1_800_000)
  for (const value of ['', '0', '-1', '184999', '1800001', '185000.1', '1e6', 'Infinity', 'NaN', ' 185000']) {
    assert.throws(() => sustainedDuration(value), /must be an integer/u)
  }
})

test('Runtime cleanup requires absence, not the CLI close event', async () => {
  let calls = 0
  await verifyRuntimeStopped(123, pid => {
    assert.equal(pid, 123)
    calls += 1
    return calls < 2
  })
  assert.equal(calls, 2)
  await assert.rejects(verifyRuntimeStopped(123, () => true, 0), /exit was not confirmed/u)
  await assert.rejects(
    verifyRuntimeStopped(123, () => {
      throw new Error('inspection failed')
    }),
    /inspection failed/u
  )
})

test('sustained HTTP echo counts complete requests and rejects unknown routes', async () => {
  const fixture = await createSustainedHttpFixture()
  try {
    const response = await fetch(`${fixture.origin}/echo`, { method: 'POST', body: 'hello' })
    assert.equal(await response.text(), 'hello')
    assert.equal(fixture.requests(), 1)
    assert.equal((await fetch(`${fixture.origin}/unknown`)).status, 404)
    assert.equal(fixture.requests(), 1)
  } finally {
    await fixture.close()
  }
})

test('an upload closed mid-body is contained and a following request still completes', { timeout: 5_000 }, async () => {
  const fixture = await createSustainedHttpFixture()
  let socket
  try {
    const target = new URL(fixture.origin)
    socket = connect({ host: target.hostname, port: Number(target.port) })
    await new Promise((resolve, reject) => {
      socket.once('error', reject)
      socket.once('connect', resolve)
    })
    socket.write('POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\na')
    const acceptedDeadline = performance.now() + 2_000
    while (fixture.started() === 0 && performance.now() < acceptedDeadline) await delay(5)
    assert.equal(fixture.started(), 1, 'the server must acknowledge the partial upload before cancellation')
    socket.destroy()
    const deadline = performance.now() + 2_000
    while (fixture.aborted() === 0 && performance.now() < deadline) await delay(5)
    assert.equal(fixture.aborted(), 1)
    assert.equal(await (await fetch(`${fixture.origin}/echo`, { method: 'POST', body: 'after' })).text(), 'after')
    assert.equal(fixture.requests(), 1)
  } finally {
    socket?.destroy()
    await fixture.close()
  }
})
