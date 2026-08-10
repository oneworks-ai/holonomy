import { describe, expect, it, vi } from 'vitest'

import { RuntimeEventLoop } from '../src/event-loop/runtime-event-loop.js'
import { HttpServerBridgeClient } from '../src/http-server/bridge-client.js'
import { HTTP_SERVER_OPERATIONS } from '../src/http-server/contract.js'
import { MemoryHttpServerProvider, WebSocketServer, createHttpServerRuntime } from '../src/http-server/index.js'
import { createNativeBridge } from '../src/native-port/native-bridge.js'
import { Buffer } from '../src/node-compat/buffer.js'

import type { RuntimeEventLoop as RuntimeEventLoopType } from '../src/event-loop/runtime-event-loop.js'
import type { HostEventLoopPort, HostEventLoopTermination } from '../src/event-loop/types.js'
import type { Server } from '../src/http-server/server.js'
import type { WebSocket } from '../src/http-server/websocket.js'

class HttpServerHost implements HostEventLoopPort {
  checkpointMicrotasks() {}

  now() {
    return 0
  }

  requestWakeup(deadlineMs: number | null) {
    void deadlineMs
  }

  terminate(reason: HostEventLoopTermination) {
    void reason
  }
}

const settle = async <Value>(loop: RuntimeEventLoopType, promise: Promise<Value>) => {
  let failure: unknown
  let settled = false
  let value!: Value
  void promise.then(result => {
    settled = true
    value = result
  }, error => {
    failure = error
    settled = true
  })
  for (let index = 0; index < 256; index += 1) {
    if (settled) break
    let turn = loop.runTurn()
    while (turn.status === 'ran') turn = loop.runTurn()
    await Promise.resolve()
  }
  if (!settled) throw new Error('HTTP server test promise did not settle')
  if (failure !== undefined) throw failure
  return value
}

const setup = (
  providerOptions: ConstructorParameters<typeof MemoryHttpServerProvider>[0] = {},
  capabilities: readonly string[] = ['http.server']
) => {
  const loop = new RuntimeEventLoop(new HttpServerHost())
  const provider = new MemoryHttpServerProvider(providerOptions)
  const bridge = createNativeBridge(provider, {
    authority: { capabilities, principal: 'http-server-test' },
    eventLoop: loop
  })
  const runtime = createHttpServerRuntime({ bridge, limits: providerOptions.limits })
  return { bridge, loop, provider, runtime }
}

const listen = (loop: RuntimeEventLoopType, server: Server) =>
  settle(
    loop,
    new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve)
    })
  )

const close = (loop: RuntimeEventLoopType, server: Server) =>
  settle(
    loop,
    new Promise<void>((resolve, reject) => {
      server.close(error => error == null ? resolve() : reject(error))
    })
  )

describe('http and WebSocket server v1', () => {
  it('strictly rejects every unary acknowledgement shape after closing grants', async () => {
    const operations = [
      HTTP_SERVER_OPERATIONS.response.start,
      HTTP_SERVER_OPERATIONS.response.write,
      HTTP_SERVER_OPERATIONS.response.end,
      HTTP_SERVER_OPERATIONS.server.close,
      HTTP_SERVER_OPERATIONS.websocket.accept,
      HTTP_SERVER_OPERATIONS.websocket.send,
      HTTP_SERVER_OPERATIONS.websocket.close
    ]
    for (const operation of operations) {
      let closes = 0
      const resource = {
        close: () => {
          closes += 1
        },
        type: 'http.websocket'
      }
      const bridge = {
        isDisposed: false,
        request: async () => ({
          binary: operation === HTTP_SERVER_OPERATIONS.websocket.accept
            ? [{ data: new Uint8Array(), handle: 'bad' }]
            : [],
          resources: [resource],
          value: operation === HTTP_SERVER_OPERATIONS.websocket.accept ? undefined : { ok: true }
        })
      }
      const client = new HttpServerBridgeClient(bridge as never)
      await expect(client.request(operation, {})).rejects.toMatchObject({ code: 'ERR_HOLONOMY_HTTP_PROTOCOL' })
      expect(closes).toBe(1)
    }
  })

  it('finalizes aborted and shutdown exchanges exactly once', async () => {
    const test = setup({ limits: { maxConnections: 1 } })
    let calls = 0
    const server = test.runtime.createServer((_request, response) => {
      calls += 1
      if (calls === 1) response.destroy()
      else response.end('ok')
    })
    await listen(test.loop, server)
    await expect(settle(test.loop, test.provider.request(server.address()!, {}))).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_HTTP_ABORTED'
    })
    const second = await settle(test.loop, test.provider.request(server.address()!, {}))
    expect(second.statusCode).toBe(200)
    await close(test.loop, server)
    expect(test.bridge.getSnapshot()).toMatchObject({ openResources: 0, pendingRequests: 0 })
  })

  it('revokes provider-owned grants once during provider disposal', async () => {
    const test = setup()
    const server = test.runtime.createServer()
    await listen(test.loop, server)
    test.provider.dispose()
    await settle(test.loop, Promise.resolve())
    expect(test.bridge.getSnapshot()).toMatchObject({ openResources: 0, pendingRequests: 0 })
    server.close()
  })

  it('contains one synchronous handler failure and accepts the next exchange', async () => {
    const test = setup({ limits: { maxConnections: 1 } })
    const errors: unknown[] = []
    let calls = 0
    const server = test.runtime.createServer((_request, response) => {
      calls += 1
      if (calls === 1) throw new Error('first handler failure')
      response.statusCode = 200
      response.end('second')
    })
    server.on('error', error => errors.push(error))
    await listen(test.loop, server)
    await expect(settle(test.loop, test.provider.request(server.address()!, {}))).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_HTTP_ABORTED'
    })
    const second = await settle(test.loop, test.provider.request(server.address()!, {}))
    expect(second).toMatchObject({ body: Buffer.from('second'), statusCode: 200 })
    expect(errors).toHaveLength(1)
    await close(test.loop, server)
    expect(test.bridge.getSnapshot()).toMatchObject({ openResources: 0, pendingRequests: 0 })
  })

  it('drains an acknowledged outbound websocket frame before its close terminal', async () => {
    const test = setup()
    const server = test.runtime.createServer()
    const callbacks: Array<Error | undefined> = []
    const webSockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      webSockets.handleUpgrade(request, socket, head, websocket => {
        websocket.send('x', error => {
          callbacks.push(error)
          websocket.close()
        })
      })
    })
    await listen(test.loop, server)
    const peer = await settle(test.loop, test.provider.websocket(server.address()!, {}))
    const frame = await settle(test.loop, peer.next())
    const terminal = await settle(test.loop, peer.next())
    expect(callbacks).toEqual([undefined])
    expect(Buffer.from(frame.value!.data).toString()).toBe('x')
    expect(terminal.done).toBe(true)
    await close(test.loop, server)
    expect(test.bridge.getSnapshot()).toMatchObject({ openResources: 0, pendingRequests: 0 })
  })

  it('copies the upgrade head and rejects duplicate acceptance while ending the old reader', async () => {
    const test = setup()
    const server = test.runtime.createServer()
    const heads: Uint8Array[] = []
    const acceptFailures: unknown[] = []
    server.on('upgrade', (_request, socket, head) => {
      heads.push(head)
      void socket.accept().then(async (websocket: WebSocket) => {
        await expect(socket.accept()).rejects.toMatchObject({ code: 'ERR_HOLONOMY_HTTP_INVALID_STATE' })
        websocket.close()
      }).catch((error: unknown) => acceptFailures.push(error))
    })
    await listen(test.loop, server)
    const head = Buffer.from('head')
    const peer = test.provider.websocket(server.address()!, { head })
    head[0] = 0
    await settle(test.loop, peer)
    expect(Buffer.from(heads[0] ?? []).toString()).toBe('head')
    expect(acceptFailures).toEqual([])
    await close(test.loop, server)
  })

  it('keeps response status and headers unchanged when staged validation fails', async () => {
    const test = setup({ limits: { maxHeaders: 1 } })
    const server = test.runtime.createServer((_request, response) => {
      response.setHeader('x-stable', 'one')
      expect(() => response.setHeader('x-overflow', 'two')).toThrow()
      expect(response.getHeaders()).toEqual({ 'x-stable': 'one' })
      expect(() => response.writeHead(201, { 'x-other': 'two' })).toThrow()
      expect(response.statusCode).toBe(200)
      response.end()
    })
    await listen(test.loop, server)
    await settle(test.loop, test.provider.request(server.address()!, {}))
    await close(test.loop, server)
  })
  it('imports the HTTP leaf without ambient AbortSignal or EventTarget', async () => {
    const abortSignal = Object.getOwnPropertyDescriptor(globalThis, 'AbortSignal')
    const eventTarget = Object.getOwnPropertyDescriptor(globalThis, 'EventTarget')
    expect(abortSignal?.configurable).toBe(true)
    expect(eventTarget?.configurable).toBe(true)
    try {
      expect(Reflect.deleteProperty(globalThis, 'AbortSignal')).toBe(true)
      expect(Reflect.deleteProperty(globalThis, 'EventTarget')).toBe(true)
      vi.resetModules()
      await expect(import('../src/http-server/index.js')).resolves.toMatchObject({
        MemoryHttpServerProvider: expect.any(Function),
        createHttpServerRuntime: expect.any(Function)
      })
    } finally {
      if (abortSignal) Object.defineProperty(globalThis, 'AbortSignal', abortSignal)
      if (eventTarget) Object.defineProperty(globalThis, 'EventTarget', eventTarget)
    }
  })

  it('serves a bounded request body and acknowledged response through the virtual provider', async () => {
    const test = setup()
    const server = test.runtime.createServer((request, response) => {
      void (async () => {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        response.setHeader('x-method', request.method)
        response.writeHead(201, 'Created', { 'x-request-values': request.headers['x-request'] ?? '' })
        response.write('echo:')
        response.end(Buffer.concat(chunks))
      })().catch(error => response.destroy(error instanceof Error ? error : new Error('request failed')))
    })
    server.on('error', error => {
      throw error
    })
    await listen(test.loop, server)

    const address = server.address()!
    const response = await settle(
      test.loop,
      test.provider.request(address, {
        body: 'payload',
        headers: { 'x-request': ['one', 'two'] },
        method: 'POST',
        url: '/echo'
      })
    )

    expect(response).toMatchObject({
      headers: { 'x-method': 'POST', 'x-request-values': ['one', 'two'] },
      statusCode: 201,
      statusMessage: 'Created'
    })
    expect(Buffer.from(response.body).toString()).toBe('echo:payload')
    await close(test.loop, server)
    test.runtime.dispose()
    expect(test.bridge.getSnapshot()).toMatchObject({ openResources: 0, pendingRequests: 0 })
    test.bridge.dispose()
  })

  it('supports ws noServer upgrades, acknowledged echo and peer close', async () => {
    const test = setup()
    const webSockets = new WebSocketServer({ noServer: true })
    const server = test.runtime.createServer()
    const failures: unknown[] = []
    server.on('error', error => failures.push(error))
    webSockets.on('error', error => failures.push(error))
    server.on('upgrade', (request, socket, head) => {
      webSockets.handleUpgrade(request, socket, head, websocket => {
        websocket.on('error', error => failures.push(error))
        websocket.on('message', (data, isBinary) => websocket.send(data, { binary: isBinary }))
      })
    })
    await listen(test.loop, server)

    const peer = await settle(
      test.loop,
      test.provider.websocket(server.address()!, {
        headers: { upgrade: 'websocket' },
        url: '/socket'
      })
    )
    peer.send('hello')
    const echoed = await settle(test.loop, peer.next())
    expect(echoed.done).toBe(false)
    expect(Buffer.from(echoed.value!.data).toString()).toBe('hello')
    expect(echoed.value!.isBinary).toBe(false)

    peer.close(1000, 'done')
    await settle(test.loop, Promise.resolve())
    expect(failures).toEqual([])
    webSockets.close()
    await close(test.loop, server)
    test.runtime.dispose()
    expect(test.bridge.getSnapshot()).toMatchObject({ openResources: 0, pendingRequests: 0 })
    test.bridge.dispose()
  })

  it('maps missing host authority to a stable redacted server error', async () => {
    const test = setup({}, [])
    const server = test.runtime.createServer()
    const error = new Promise<Error>(resolve => server.once('error', resolve))
    server.listen()

    await expect(settle(test.loop, error)).resolves.toMatchObject({
      code: 'ERR_HOLONOMY_HTTP_PERMISSION_DENIED',
      message: 'HTTP server operation was denied'
    })
    server.close()
    test.runtime.dispose()
    expect(test.bridge.getSnapshot()).toMatchObject({ openResources: 0, pendingRequests: 0 })
    test.bridge.dispose()
  })

  it('enforces the reference provider connection quota before accept delivery', async () => {
    const test = setup({ limits: { maxConnections: 1 } })
    const server = test.runtime.createServer((_request, response) => response.end('ok'))
    server.on('error', error => {
      throw error
    })
    await listen(test.loop, server)

    const first = test.provider.request(server.address()!, { url: '/first' })
    await expect(test.provider.request(server.address()!, { url: '/second' })).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_HTTP_LIMIT_EXCEEDED'
    })
    await expect(settle(test.loop, first)).resolves.toMatchObject({ statusCode: 200 })
    await close(test.loop, server)
    test.runtime.dispose()
    expect(test.bridge.getSnapshot()).toMatchObject({ openResources: 0, pendingRequests: 0 })
    test.bridge.dispose()
  })
})
