import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { it as test } from 'vitest'

const asset = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

const isolate = () => {
  const context = vm.createContext({ setTimeout, clearTimeout })
  for (
    const source of [
      asset('assets/v86-shim.js'),
      asset('generated/v86-web-standards.js'),
      asset('assets/v86-network.js')
    ]
  ) vm.runInContext(source, context)
  const adapter = {
    send() {},
    receive(bytes) {
      this.received = bytes
    }
  }
  context.__holoVmNetworkSetup({ network_adapter: adapter })
  return { context, adapter }
}

test('private v86 VM queues TCP bytes and refuses closed flow replies', () => {
  const { context, adapter } = isolate()
  const handlers = new Map()
  const connection = {
    sport: 443,
    on(name, callback) {
      handlers.set(name, callback)
    },
    accept() {
      this.accepted = true
    },
    close() {
      this.closed = true
    },
    write(bytes) {
      this.written = [...bytes]
    }
  }
  adapter.on_tcp_connection(connection, { ipv4: { dest: [127, 0, 0, 1] } })
  assert.equal(connection.accepted, true)
  const opened = JSON.parse(context.__holoVmNetworkDrain(4))
  assert.equal(opened.events[0].kind, 'tcpOpen')
  assert.equal(opened.events[0].address, '127.0.0.1')
  const streamId = opened.events[0].streamId
  handlers.get('data')(Uint8Array.from([1, 2, 3]))
  const data = JSON.parse(context.__holoVmNetworkDrain(4))
  assert.equal(data.events[0].base64, 'AQID')
  context.__holoVmNetworkDeliver(JSON.stringify({ streamId, action: 'tcpData', base64: 'BAU=' }))
  assert.deepEqual(connection.written, [4, 5])
  handlers.get('close')()
  const closed = JSON.parse(context.__holoVmNetworkDrain(4))
  assert.equal(closed.events[0].kind, 'tcpClose')
  assert.throws(() => context.__holoVmNetworkDeliver(JSON.stringify({ streamId, action: 'tcpData', base64: '' })))
})

test('private v86 HTTP proxy shims preserve Host header and pull response chunks', async () => {
  const { context, adapter } = isolate()
  const url = new context.URL('http://host/path')
  url.host = 'example.test:8080'
  assert.equal(url.href, 'http://example.test:8080/path')
  assert.equal(context.location.protocol, 'http:')
  const request = adapter.fetch('http://example.test:8080/path', {
    method: 'GET',
    headers: new context.Headers([['accept', 'text/plain']])
  })
  const queued = JSON.parse(context.__holoVmNetworkDrain(4))
  assert.equal(queued.events[0].kind, 'httpRequest')
  assert.equal(queued.events[0].url, 'http://example.test:8080/path')
  const streamId = queued.events[0].streamId
  context.__holoVmNetworkDeliver(JSON.stringify({
    streamId,
    action: 'httpHead',
    head: {
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'text/plain']],
      url: 'http://example.test:8080/path'
    }
  }))
  const response = await request
  const reader = response.body.getReader()
  const read = reader.read()
  assert.equal(JSON.parse(context.__holoVmNetworkDrain(4)).events[0].kind, 'httpPull')
  context.__holoVmNetworkDeliver(JSON.stringify({ streamId, action: 'httpChunk', base64: 'b2s=' }))
  assert.deepEqual([...((await read).value)], [111, 107])
  const end = reader.read()
  context.__holoVmNetworkDeliver(JSON.stringify({ streamId, action: 'httpEnd' }))
  assert.equal((await end).done, true)
})

test('vm reserves close notifications across two 32-flow waves without draining', () => {
  const { context, adapter } = isolate()
  const makeConnection = () => {
    const handlers = new Map()
    const connection = {
      sport: 443,
      on(name, callback) {
        handlers.set(name, callback)
      },
      accept() {
        this.accepted = true
      },
      close() {
        this.closed = true
      },
      write() {}
    }
    adapter.on_tcp_connection(connection, { ipv4: { dest: [127, 0, 0, 1] } })
    return { connection, handlers }
  }
  const drainAll = () => {
    const events = []
    for (;;) {
      const batch = JSON.parse(context.__holoVmNetworkDrain(4))
      events.push(...batch.events)
      if (batch.remaining === 0) return events
    }
  }
  for (let wave = 0; wave < 2; wave += 1) {
    const connections = Array.from({ length: 32 }, makeConnection)
    assert.equal(connections.every(item => item.connection.accepted === true), true)
    for (const item of connections) {
      item.handlers.get('shutdown')()
      item.handlers.get('shutdown')() // duplicate FIN is coalesced
      item.handlers.get('close')()
    }
    const blocked = makeConnection()
    assert.equal(blocked.connection.accepted, undefined)
    assert.equal(blocked.connection.closed, true)
    const events = drainAll()
    const closes = events.filter(event => event.kind === 'tcpClose')
    assert.equal(closes.length, 32)
    assert.equal(new Set(closes.map(event => event.streamId)).size, 32)
    assert.equal(events.filter(event => event.kind === 'tcpFin').length, 32)
  }
  const last = makeConnection()
  context.__holoVmNetworkClose()
  assert.equal(last.connection.closed, true)
  assert.deepEqual(JSON.parse(context.__holoVmNetworkDrain(4)).events, [])
})
