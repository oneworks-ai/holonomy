import { IncomingMessage } from './incoming-message.js'
import { ServerResponse } from './server-response.js'
import { Server } from './server.js'
import { WebSocket, WebSocketServer } from './websocket.js'

import type { HttpServerRuntime } from './runtime.js'

export const createHttpServerSyntheticModules = (runtime: HttpServerRuntime) => {
  const http = Object.freeze({
    IncomingMessage,
    Server,
    ServerResponse,
    createServer: runtime.createServer.bind(runtime)
  })
  const ws = Object.freeze({
    WebSocket,
    WebSocketServer
  })
  return Object.freeze({
    'node:http': Object.freeze({ default: http, ...http }),
    ws: Object.freeze({ default: WebSocket, ...ws })
  })
}

export const createHttpServerSyntheticModuleBindings = (runtime: HttpServerRuntime) => {
  const modules = createHttpServerSyntheticModules(runtime)
  return Object.freeze(Object.fromEntries(
    Object.entries(modules).map(([specifier, namespace]) => [
      specifier,
      Object.freeze({
        descriptor: Object.freeze({ exportNames: Object.freeze(Object.keys(namespace)) }),
        namespace
      })
    ])
  ))
}
