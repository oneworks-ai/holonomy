import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fetchConformanceEntry = resolve(root, 'conformance/specs/fetch.test.mjs')

const listen = (server, port) =>
  new Promise((resolvePromise, reject) => {
    const onError = error => {
      reject(error)
    }
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      resolvePromise()
    })
  })

const close = (server, sockets) =>
  new Promise((resolvePromise, reject) => {
    server.close(error => error == null ? resolvePromise() : reject(error))
    for (const socket of sockets) socket.destroy()
  })

const handleRequest = (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/profile') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ runtime: 'holonomy' }))
    return
  }
  if (request.method === 'GET' && url.pathname === '/slow') {
    request.once('aborted', () => response.destroy())
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('Not found')
}

export const requiresHolonomyNetworkFixture = (command, entries) =>
  command === 'test' && entries.some(entry => resolve(entry) === fetchConformanceEntry)

export const startHolonomyNetworkFixture = async (options = {}) => {
  const port = options.port ?? 0
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('Holonomy network fixture port must be a valid TCP port')
  }
  const sockets = new Set()
  const server = createServer(handleRequest)
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await listen(server, port)
  const address = server.address()
  if (address == null || typeof address === 'string') {
    await close(server, sockets)
    throw new Error('Unable to bind the Holonomy network fixture')
  }
  let closed = false
  return Object.freeze({
    close: async () => {
      if (closed) return
      closed = true
      await close(server, sockets)
    },
    port: address.port,
    url: `http://127.0.0.1:${address.port}`
  })
}

export const runWithHolonomyNetworkFixture = async (input, callback) => {
  if (!requiresHolonomyNetworkFixture(input.command, input.entries)) {
    return callback({ env: input.env, networkFixturePort: undefined })
  }
  const fixture = await startHolonomyNetworkFixture()
  try {
    return await callback({
      env: { ...input.env, HOLONOMY_FIXTURE_URL: fixture.url },
      networkFixturePort: fixture.port
    })
  } finally {
    await fixture.close()
  }
}
