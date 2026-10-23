import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import { it as test } from 'vitest'

import { NativeV86ProcessNetworkBrokerV1 } from '../bootstrap/process-v86-network-broker.mjs'

const request = consumeNetworkAdmission => ({
  consumeNetworkAdmission,
  environmentId: 'vm-1',
  generation: 1,
  policy: { network: { access: 'restricted', endpoints: [], maxSockets: 2 } },
  scope: 'processTree',
  signal: new AbortController().signal
})

const udpFrame = payload => {
  const frame = new Uint8Array(42 + payload.length)
  const view = new DataView(frame.buffer)
  view.setUint16(12, 0x0800)
  frame[14] = 0x45
  view.setUint16(16, 28 + payload.length)
  frame[23] = 17
  frame.set([192, 168, 86, 100], 26)
  frame.set([127, 0, 0, 1], 30)
  view.setUint16(34, 49_152)
  view.setUint16(36, 8124)
  view.setUint16(38, 8 + payload.length)
  frame.set(payload, 42)
  return Buffer.from(frame).toString('base64')
}

test('vm TCP event without a HoloUV admission cannot open a Host socket', async () => {
  let authorized = 0
  const delivered = []
  const broker = new NativeV86ProcessNetworkBrokerV1({
    authorize() {
      authorized += 1
    },
    close() {},
    closeEnvironment() {},
    closeGeneration() {}
  })
  await broker.handle(
    { kind: 'tcpOpen', streamId: 1, address: '127.0.0.1', port: 9000 },
    request(() => {
      throw new Error('missing HoloUV ticket')
    }),
    value => delivered.push(value)
  )
  assert.equal(authorized, 0)
  assert.deepEqual(delivered, [{ streamId: 1, action: 'tcpClose' }])
})

test('http redirect reauthorizes with the original source and stops before a denied hop', async () => {
  const source = { linuxPid: 29, processId: 23 }
  let admissions = 0
  const authorized = []
  const requested = []
  const closed = []
  const delivered = []
  const broker = new NativeV86ProcessNetworkBrokerV1({
    async authorize(selected, _request, endpoint) {
      authorized.push([selected, endpoint.hostname])
      if (endpoint.hostname === 'denied.test') throw new Error('policy.denied')
      return { resolutionToken: 'dns-1', receipt: { authorized: true }, address: '127.0.0.1' }
    },
    async task(kind, fields) {
      requested.push([kind, fields.url])
      return {
        socketToken: 'http-1',
        status: 302,
        statusText: 'Found',
        headers: [['location', 'http://denied.test/']],
        url: 'http://allowed.test/'
      }
    },
    close(socketToken) {
      closed.push(socketToken)
    },
    closeEnvironment() {},
    closeGeneration() {}
  })
  await broker.handle(
    {
      kind: 'httpRequest',
      streamId: 7,
      url: 'http://allowed.test/',
      method: 'GET',
      headers: [],
      bodyBase64: ''
    },
    request(() => {
      admissions += 1
      return source
    }),
    value => delivered.push(value)
  )
  assert.equal(admissions, 1)
  assert.deepEqual(authorized, [[source, 'allowed.test'], [source, 'denied.test']])
  assert.deepEqual(requested, [['httpRequest', 'http://allowed.test/']])
  assert.deepEqual(closed, ['http-1'])
  assert.deepEqual(delivered, [{ streamId: 7, action: 'httpError' }])
})

test('http proxy removes hop headers and strips credentials on cross-endpoint redirects', async () => {
  const requested = []
  const broker = new NativeV86ProcessNetworkBrokerV1({
    async authorize() {
      return { resolutionToken: 'dns-1', receipt: { authorized: true }, address: '127.0.0.1' }
    },
    async task(_kind, fields) {
      requested.push(fields)
      return requested.length === 1
        ? { socketToken: 'one', status: 302, headers: [['location', 'http://second.test/']], url: fields.url }
        : { socketToken: 'two', status: 200, statusText: 'OK', headers: [], url: fields.url }
    },
    close() {},
    closeEnvironment() {},
    closeGeneration() {}
  })
  await broker.handle(
    {
      kind: 'httpRequest',
      streamId: 17,
      url: 'http://first.test/',
      method: 'GET',
      bodyBase64: '',
      headers: [
        ['Proxy-Connection', 'Keep-Alive, x-proxy-only'],
        ['X-Proxy-Only', 'fixture'],
        ['Connection', 'keep-alive, x-private-hop'],
        ['X-Private-Hop', 'fixture'],
        ['Content-Length', '0'],
        ['Authorization', 'fixture-token'],
        ['Cookie', 'fixture-cookie'],
        ['Accept', '*/*']
      ]
    },
    request(() => ({ linuxPid: 29, processId: 23 })),
    () => {}
  )
  assert.deepEqual(requested[0].headers, [['Authorization', 'fixture-token'], ['Cookie', 'fixture-cookie'], [
    'Accept',
    '*/*'
  ]])
  assert.deepEqual(requested[1].headers, [['Accept', '*/*']])
  broker.closeGeneration()
})

test('slow TCP writes reserve bytes before the Promise tail and release after close', async () => {
  let releaseWrite
  let writeStarted
  const started = new Promise(resolve => {
    writeStarted = resolve
  })
  const delivered = []
  const closed = []
  let writes = 0
  const broker = new NativeV86ProcessNetworkBrokerV1({
    async authorize() {
      return { resolutionToken: 'dns-1', receipt: { authorized: true }, address: '127.0.0.1' }
    },
    async task(kind) {
      if (kind === 'openTcp') return { socketToken: 'tcp-1' }
      if (kind === 'readTcp') return new Promise(() => {})
      if (kind === 'writeTcp') {
        writes += 1
        writeStarted()
        return new Promise(resolve => {
          releaseWrite = resolve
        })
      }
      throw new Error(`Unexpected ${kind}`)
    },
    close(token) {
      closed.push(token)
    },
    closeEnvironment() {},
    closeGeneration() {}
  })
  await broker.handle(
    { kind: 'tcpOpen', streamId: 9, address: '127.0.0.1', port: 9000 },
    request(() => ({ linuxPid: 29, processId: 23 })),
    value => delivered.push(value)
  )
  const chunk = Buffer.alloc(16 * 1024).toString('base64')
  broker.handle({ kind: 'tcpData', streamId: 9, base64: chunk }, request(() => {}), value => delivered.push(value))
  await started
  for (let index = 1; index < 16; index += 1) {
    broker.handle({ kind: 'tcpData', streamId: 9, base64: chunk }, request(() => {}), value => delivered.push(value))
  }
  assert.equal(broker.pendingWriteBytes, 256 * 1024)
  broker.handle({ kind: 'tcpData', streamId: 9, base64: chunk }, request(() => {}), value => delivered.push(value))
  assert.equal(broker.pendingWriteBytes, 256 * 1024)
  assert.deepEqual(closed, ['tcp-1'])
  assert.equal(delivered.at(-1).action, 'tcpClose')
  releaseWrite({ written: 16 * 1024 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(writes, 1)
  assert.equal(broker.pendingWriteBytes, 0)
})

test('slow UDP sends use the same bounded Promise-tail reservation', async () => {
  let releaseSend
  let sendStarted
  const started = new Promise(resolve => {
    sendStarted = resolve
  })
  const closed = []
  let sends = 0
  const broker = new NativeV86ProcessNetworkBrokerV1({
    async authorize() {
      return { resolutionToken: 'dns-udp', receipt: { authorized: true }, address: '127.0.0.1' }
    },
    async task(kind) {
      if (kind === 'openUdp') return { socketToken: 'udp-1' }
      if (kind === 'recvUdp') return new Promise(() => {})
      if (kind === 'sendUdp') {
        sends += 1
        sendStarted()
        return new Promise(resolve => {
          releaseSend = resolve
        })
      }
      throw new Error(`Unexpected ${kind}`)
    },
    close(token) {
      closed.push(token)
    },
    closeEnvironment() {},
    closeGeneration() {}
  })
  const event = { kind: 'udpFrame', streamId: 11, base64: udpFrame(new Uint8Array(1000)) }
  const guest = request(() => ({ linuxPid: 29, processId: 23 }))
  await broker.handle(event, guest, () => {})
  await started
  for (let index = 1; index < 263; index += 1) broker.handle(event, guest, () => {})
  assert.ok(broker.pendingWriteBytes <= 256 * 1024)
  assert.deepEqual(closed, ['udp-1'])
  releaseSend({ written: 1000 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sends, 1)
  assert.equal(broker.pendingWriteBytes, 0)
})

test('tcp FIN before authorization writes pending bytes then ends exactly once', async () => {
  let releaseAuthorization
  let releaseOpen
  let markOpenStarted
  const authorization = new Promise(resolve => {
    releaseAuthorization = resolve
  })
  const opened = new Promise(resolve => {
    releaseOpen = resolve
  })
  const openStarted = new Promise(resolve => {
    markOpenStarted = resolve
  })
  const order = []
  const delivered = []
  const broker = new NativeV86ProcessNetworkBrokerV1({
    authorize: () => authorization,
    async task(kind) {
      if (kind === 'openTcp') {
        markOpenStarted()
        return opened
      }
      if (kind === 'writeTcp') {
        order.push('write')
        return { written: 3 }
      }
      if (kind === 'endTcp') {
        order.push('end')
        return {}
      }
      if (kind === 'readTcp') return new Promise(() => {})
      throw new Error(`Unexpected ${kind}`)
    },
    close() {},
    closeEnvironment() {},
    closeGeneration() {}
  })
  const guest = request(() => ({ linuxPid: 29, processId: 23 }))
  const emit = value => delivered.push(value)
  const opening = broker.handle({ kind: 'tcpOpen', streamId: 13, address: '127.0.0.1', port: 9000 }, guest, emit)
  broker.handle({ kind: 'tcpData', streamId: 13, base64: 'AQID' }, guest, emit)
  broker.handle({ kind: 'tcpFin', streamId: 13 }, guest, emit)
  broker.handle({ kind: 'tcpFin', streamId: 13 }, guest, emit)
  releaseAuthorization({ resolutionToken: 'dns-1', receipt: { authorized: true }, address: '127.0.0.1' })
  await openStarted
  assert.deepEqual(order, [])
  releaseOpen({ socketToken: 'tcp-1' })
  await opening
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['write', 'end'])
  assert.equal(broker.pendingWriteBytes, 0)
  broker.handle({ kind: 'tcpData', streamId: 13, base64: 'BA==' }, guest, emit)
  assert.deepEqual(order, ['write', 'end'])
  assert.equal(delivered.at(-1).action, 'tcpClose')
})
