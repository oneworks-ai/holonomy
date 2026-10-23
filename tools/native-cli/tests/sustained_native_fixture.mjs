import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

export const sustainedDuration = value => {
  if (value == null) return 185_000
  if (!/^\d+$/u.test(value)) throw new Error('HOLONOMY_NATIVE_SOAK_MS must be an integer from 185000 to 1800000')
  const duration = Number(value)
  if (!Number.isSafeInteger(duration) || duration < 185_000 || duration > 1_800_000) {
    throw new Error('HOLONOMY_NATIVE_SOAK_MS must be an integer from 185000 to 1800000')
  }
  return duration
}

export const verifyRuntimeStopped = async (pid, alive, timeoutMs = 2_000) => {
  if (pid == null) return
  const deadline = performance.now() + timeoutMs
  do {
    if (!alive(pid)) return
    if (performance.now() >= deadline) throw new Error(`Owned Native Runtime ${pid} exit was not confirmed`)
    await delay(10)
  } while (true)
}

export const createSustainedHttpFixture = async () => {
  const sockets = new Set()
  let requests = 0
  let aborted = 0
  let started = 0
  const echo = async (request, response) => {
    if (request.url !== '/echo' || request.method !== 'POST') {
      response.writeHead(404, { connection: 'close' }).end()
      return
    }
    started += 1
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 256) {
        response.writeHead(413, { connection: 'close' }).end()
        return
      }
      chunks.push(chunk)
    }
    requests += 1
    response.writeHead(200, { 'content-type': 'text/plain', connection: 'close' })
    response.end(Buffer.concat(chunks))
  }
  const server = createServer((request, response) => {
    // EventEmitter does not consume a Promise returned by an async listener.
    // Aborted uploads must not escape as an unhandled rejection in the driver.
    void echo(request, response).catch(() => {
      aborted += 1
      response.destroy()
      request.destroy()
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests: () => requests,
    aborted: () => aborted,
    started: () => started,
    async close() {
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections()
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Owned HTTP fixture close was not confirmed')), 5_000)
        server.close(error => {
          clearTimeout(timer)
          if (error != null) reject(error)
          else resolve()
        })
      })
      assert.equal(server.listening, false)
    }
  }
}
