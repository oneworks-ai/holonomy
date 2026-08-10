import { HttpServerBridgeClient } from './bridge-client.js'
import { createHttpServerError } from './errors.js'
import { resolveHttpServerLimits } from './limits.js'
import { Server } from './server.js'

import type { RequestListener } from './server.js'
import type { HttpServerRuntimeOptions } from './types.js'

export class HttpServerRuntime {
  private readonly client: HttpServerBridgeClient
  private disposed = false
  private readonly limits
  private readonly servers = new Set<Server>()

  constructor(options: HttpServerRuntimeOptions) {
    this.client = new HttpServerBridgeClient(options.bridge)
    this.limits = resolveHttpServerLimits(options.limits)
  }

  createServer(requestListener?: RequestListener) {
    if (this.disposed) throw createHttpServerError('ERR_MOBILE_HTTP_DISPOSED')
    const server = new Server(this.client, this.limits, requestListener)
    this.servers.add(server)
    server.once('close', () => this.servers.delete(server))
    return server
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const server of this.servers) server.dispose()
    this.servers.clear()
    this.client.dispose()
  }
}

export const createHttpServerRuntime = (options: HttpServerRuntimeOptions) => new HttpServerRuntime(options)
