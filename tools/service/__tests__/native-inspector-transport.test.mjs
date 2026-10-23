import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { InspectorCdpProxy } from '../inspector-proxy.mjs'
import { NativeInspectorConnection } from '../native-inspector-transport.mjs'

const fixture = async work => {
  const directory = await mkdtemp(join(tmpdir(), 'holo-native-cdp-test-'))
  const path = join(directory, 'cdp.sock')
  const connections = []
  const messages = []
  const server = createServer(socket => {
    connections.push(socket)
    let input = ''
    socket.on('data', bytes => {
      input += bytes.toString('utf8')
      while (true) {
        const end = input.indexOf('\n')
        if (end < 0) break
        messages.push(JSON.parse(input.slice(0, end)))
        input = input.slice(end + 1)
      }
    })
  })
  await new Promise(resolve => server.listen(path, resolve))
  try {
    await work({ connections, messages, path })
  } finally {
    for (const socket of connections) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { force: true, recursive: true })
  }
}

const waitForMessages = async (messages, count) => {
  for (let turn = 0; turn < 100; turn++) {
    if (messages.length >= count) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Native CDP request did not reach the socket')
}

describe('native Inspector Service transport', () => {
  it('remaps equal client IDs across leases and keeps the one upstream alive after a lease closes', async () => {
    await fixture(async ({ connections, messages, path }) => {
      const upstream = new NativeInspectorConnection(path)
      await upstream.connect()
      const first = upstream.lease()
      const second = upstream.lease()
      const firstResult = first.send({ id: 7, method: 'Runtime.getIsolateId' })
      const secondResult = second.send({ id: 7, method: 'Debugger.enable' })
      await waitForMessages(messages, 2)
      assert.equal(connections.length, 1)
      assert.notEqual(messages[0].id, messages[1].id)
      connections[0].write(`${JSON.stringify({ id: messages[1].id, result: { owner: 'second' } })}\n`)
      connections[0].write(`${JSON.stringify({ id: messages[0].id, result: { owner: 'first' } })}\n`)
      assert.deepEqual(await firstResult, { id: 7, result: { owner: 'first' } })
      assert.deepEqual(await secondResult, { id: 7, result: { owner: 'second' } })

      const notifications = []
      second.subscribe(value => notifications.push(value.method))
      first.close()
      const next = second.send({ id: 7, method: 'Runtime.enable' })
      await waitForMessages(messages, 3)
      connections[0].write(`${JSON.stringify({ method: 'Runtime.executionContextCreated', params: {} })}\n`)
      connections[0].write(`${JSON.stringify({ id: messages[2].id, result: {} })}\n`)
      assert.deepEqual(await next, { id: 7, result: {} })
      assert.deepEqual(notifications, ['Runtime.executionContextCreated'])
      assert.equal(connections.length, 1)
      upstream.close()
      await assert.rejects(
        second.send({ id: 8, method: 'Runtime.enable' }),
        error => error.code === 'service.unavailable'
      )
    })
  })

  it('rejects closed-lease pending requests while admitting a different lease', async () => {
    await fixture(async ({ connections, messages, path }) => {
      const upstream = new NativeInspectorConnection(path)
      await upstream.connect()
      const first = upstream.lease()
      const second = upstream.lease()
      const pending = first.send({ id: 1, method: 'Runtime.enable' })
      const rejection = assert.rejects(pending, error => error.code === 'service.unavailable')
      await waitForMessages(messages, 1)
      first.close()
      await rejection
      connections[0].write(`${JSON.stringify({ id: messages[0].id, result: { stale: true } })}\n`)
      const current = second.send({ id: 1, method: 'Runtime.getIsolateId' })
      await waitForMessages(messages, 2)
      connections[0].write(`${JSON.stringify({ id: messages[1].id, result: { id: 'current' } })}\n`)
      assert.deepEqual(await current, { id: 1, result: { id: 'current' } })
      await assert.rejects(
        second.send({ id: 2, method: 'Runtime.evaluate', params: { expression: 'x'.repeat(64 * 1024) } }),
        error => error.code === 'service.limit_exceeded'
      )
      upstream.close()
    })
  })

  it('passes Native execution commands to its upstream Gate and rejects a bad lease token', async () => {
    const calls = []
    const proxy = new InspectorCdpProxy({
      engineGate: () => {
        throw new Error('Service Gate must not run')
      }
    })
    proxy.configureEndpoint('http://127.0.0.1:12345')
    const endpoint = proxy.attach({
      inspector: { generation: 2, id: 'inspector_native', processId: 'process_native' },
      process: { generation: 2, id: 'process_native', target: 'native' },
      transport: {
        close() {},
        async send(message) {
          calls.push(message)
          return { id: message.id, error: { code: -32_000, message: 'Inspector command denied' } }
        }
      }
    })
    assert.throws(
      () => proxy.connectAuthorized('inspector_native', 'bad', () => undefined),
      error => error.code === 'service.unauthorized'
    )
    const token = new URL(endpoint.webSocketDebuggerUrl).searchParams.get('access_token')
    const session = proxy.connectAuthorized('inspector_native', token, () => undefined)
    assert.deepEqual(await session.receive({ id: 1, method: 'Runtime.evaluate', params: { expression: '1+1' } }), {
      id: 1,
      error: { code: -32_000, message: 'Inspector command denied' }
    })
    assert.equal(calls.length, 1)
    proxy.closeProcess('process_native', 2)
    assert.equal((await session.receive({ id: 2, method: 'Runtime.enable' })).error.code, -32_000)
  })
})
