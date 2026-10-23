import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { it } from 'vitest'

import { handleInspectorUpgrade } from '../cdp-websocket-server.mjs'

it('force-closes a revoked WebSocket whose peer keeps its write half open', async () => {
  let revoke
  let upstream
  let signalUpgrade
  const upgraded = new Promise(resolve => signalUpgrade = resolve)
  const server = createServer()
  server.on('upgrade', (request, socket, head) => {
    upstream = socket
    handleInspectorUpgrade(
      {
        connectAuthorized: (_id, _token, _sink, onClose) => {
          revoke = onClose
          return { close() {}, receive: async () => ({}) }
        }
      },
      request,
      socket,
      head
    )
    signalUpgrade()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = createConnection({ allowHalfOpen: true, host: '127.0.0.1', port: server.address().port })
  client.on('data', () => undefined)
  try {
    await once(client, 'connect')
    client.write(
      'GET /v1/inspectors/lease/cdp?access_token=test HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n'
    )
    await upgraded
    const closed = once(upstream, 'close')
    revoke()
    const timeout = setTimeout(() => upstream.destroy(new Error('Unbounded socket cleanup')), 3_000)
    try {
      await closed
    } finally {
      clearTimeout(timeout)
    }
    assert.equal(upstream.destroyed, true)
    assert.equal(client.writableEnded, false)
  } finally {
    client.destroy()
    upstream?.destroy()
    server.close()
    await once(server, 'close')
  }
}, 8_000)
