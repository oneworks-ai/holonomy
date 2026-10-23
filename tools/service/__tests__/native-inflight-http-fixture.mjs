import assert from 'node:assert/strict'
import { createServer } from 'node:http'

export const nativeInflightBounded = async (work, label, durationMs = 8_000) => {
  let timer
  try {
    return await Promise.race([
      work,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} was not confirmed`)), durationMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

// The server callback acknowledges real transport admission. Socket 'close',
// separately from response destruction or child 'exit', proves transport teardown.
export const createNativeInflightHttpFixture = async () => {
  const requests = []
  const sockets = new Map()
  let heldResponse
  let heldAccepted = false
  let heldSocketClosed = false
  let freshResponse
  let acknowledgeHeld
  let acknowledgeHeldClose
  let acknowledgeFresh
  let closing
  const held = new Promise(resolve => acknowledgeHeld = resolve)
  const heldClose = new Promise(resolve => acknowledgeHeldClose = resolve)
  const fresh = new Promise(resolve => acknowledgeFresh = resolve)
  const headers = response => response.writeHead(200, { 'content-type': 'text/plain', connection: 'close' })
  const reply = (response, body) => {
    headers(response)
    response.end(body)
  }
  const server = createServer((request, response) => {
    requests.push(request.url)
    if (request.url === '/held' && !heldAccepted) {
      heldAccepted = true
      heldResponse = response
      request.socket.once('close', () => {
        heldSocketClosed = true
        acknowledgeHeldClose()
      })
      acknowledgeHeld()
      return
    }
    if (request.url === '/fresh-latch') {
      freshResponse = response
      acknowledgeFresh()
      return
    }
    reply(response, request.url === '/held' ? 'fresh-generation' : 'fresh-quota')
  })
  server.on('connection', socket => {
    sockets.set(
      socket,
      new Promise(resolve =>
        socket.once('close', () => {
          sockets.delete(socket)
          resolve()
        })
      )
    )
  })
  await nativeInflightBounded(
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    }),
    'HTTP fixture listen'
  )
  return Object.freeze({
    origin: `http://127.0.0.1:${server.address().port}`,
    requests: () => [...requests],
    heldSocketClosed: () => heldSocketClosed,
    waitForHeld: () => nativeInflightBounded(held, 'held transport admission'),
    waitForHeldClose: () => nativeInflightBounded(heldClose, 'held socket close'),
    waitForFreshLatch: () => nativeInflightBounded(fresh, 'fresh transport admission'),
    releaseHeldHeaders() {
      assert(heldResponse != null && !heldResponse.destroyed, 'held response must still be open')
      headers(heldResponse)
      heldResponse.flushHeaders()
    },
    releaseHeld(body = 'old-approved') {
      assert(heldResponse != null && !heldResponse.destroyed, 'held response must still be open')
      reply(heldResponse, body)
      heldResponse = undefined
    },
    releaseFreshLatch() {
      assert(freshResponse != null && !freshResponse.destroyed, 'fresh response must still be open')
      reply(freshResponse, 'fresh-latch')
      freshResponse = undefined
    },
    close() {
      closing ??= (async () => {
        const socketCloses = [...sockets.values()]
        for (const socket of sockets.keys()) socket.destroy()
        server.closeAllConnections()
        await nativeInflightBounded(
          Promise.all([
            ...socketCloses,
            new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
          ]),
          'HTTP fixture server and socket close'
        )
        assert.equal(sockets.size, 0)
      })()
      return closing
    }
  })
}
