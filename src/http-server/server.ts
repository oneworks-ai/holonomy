/* eslint-disable max-lines -- server exchange ownership and accept pump share one finalizer. */

import { Buffer } from '../node-compat/buffer.js'
import { EventEmitter } from '../node-compat/events.js'

import { HTTP_SERVER_OPERATIONS, HTTP_SERVER_RESOURCE_TYPES } from './contract.js'
import { createHttpServerError } from './errors.js'
import { IncomingMessage } from './incoming-message.js'
import { ServerResponse } from './server-response.js'
import { decodeAddress, decodeIncomingRequest } from './validation.js'
import { UpgradeSocket } from './websocket.js'

import type { NativeResourceHandle, NativeStream } from '../native-port/types.js'
import type { HttpServerBridgeClient } from './bridge-client.js'
import type { HttpServerAddress, HttpServerLimits } from './types.js'

export type RequestListener = (request: IncomingMessage, response: ServerResponse) => void

export class Server extends EventEmitter {
  private acceptStream: NativeStream | undefined
  private activeConnections = 0
  private addressValue: HttpServerAddress | null = null
  private closing = false
  private listening = false
  private referenced = true
  private serverResource: NativeResourceHandle | undefined
  private readonly exchanges = new Set<NativeResourceHandle>()

  constructor(
    private readonly client: HttpServerBridgeClient,
    private readonly limits: Readonly<HttpServerLimits>,
    requestListener?: RequestListener
  ) {
    super()
    if (requestListener != null) this.on('request', requestListener)
  }

  address() {
    return this.addressValue
  }

  close(callback?: (error?: Error) => void) {
    if (this.closing) {
      callback?.()
      return this
    }
    this.closing = true
    this.listening = false
    this.acceptStream?.close('server_close')
    this.acceptStream = undefined
    for (const exchange of [...this.exchanges]) this.abortExchange(exchange, 'server_close')
    const resource = this.serverResource
    this.serverResource = undefined
    this.addressValue = null
    if (resource == null) {
      this.emit('close')
      callback?.()
      return this
    }
    void this.client.request(HTTP_SERVER_OPERATIONS.server.close, { server: resource }).then(
      () => {
        resource.close('server_close')
        this.emit('close')
        callback?.()
      },
      error => {
        resource.close('server_close_failed')
        callback?.(error instanceof Error ? error : createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL'))
      }
    )
    return this
  }

  listen(port = 0, host = '127.0.0.1', callback?: () => void) {
    if (this.listening || this.closing) throw createHttpServerError('ERR_HOLONOMY_HTTP_INVALID_STATE')
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535 || host !== '127.0.0.1') {
      throw createHttpServerError('ERR_HOLONOMY_HTTP_INVALID_ARGUMENT')
    }
    this.listening = true
    void this.client.request(HTTP_SERVER_OPERATIONS.server.open, { host, port }).then(
      result => {
        if (!this.listening || this.closing) {
          for (const resource of result.resources ?? []) resource.close('server_open_cancelled')
          return
        }
        try {
          if (result.resources?.length !== 1 || result.resources[0]?.type !== HTTP_SERVER_RESOURCE_TYPES.server) {
            throw createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL')
          }
          const address = decodeAddress(result.value)
          const resource = result.resources[0]
          const acceptStream = this.client.stream(HTTP_SERVER_OPERATIONS.server.accept, {
            server: resource
          })
          this.serverResource = resource
          this.addressValue = address
          this.acceptStream = acceptStream
        } catch (error) {
          for (const resource of result.resources ?? []) resource.close('unexpected_server_resource')
          this.listening = false
          this.emit('error', error instanceof Error ? error : createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL'))
          return
        }
        callback?.()
        this.emit('listening')
        void this.pumpAccepts(this.acceptStream!)
      },
      error => {
        this.listening = false
        this.emit('error', error)
      }
    )
    return this
  }

  ref() {
    this.referenced = true
    return this
  }

  unref() {
    this.referenced = false
    return this
  }

  hasRef() {
    return this.referenced
  }

  dispose() {
    this.close()
  }

  private abortExchange(exchange: NativeResourceHandle, reason: string) {
    void this.client.request(HTTP_SERVER_OPERATIONS.exchange.abort, { exchange, reason })
      .catch(() => undefined)
      .finally(() => this.finalizeExchange(exchange, reason))
  }

  private beginExchange(exchange: NativeResourceHandle) {
    this.exchanges.add(exchange)
    this.activeConnections += 1
  }

  private finalizeExchange(exchange: NativeResourceHandle, reason = 'exchange_finalized') {
    if (!this.exchanges.delete(exchange)) return
    this.activeConnections -= 1
    exchange.close(reason)
  }

  private async pumpAccepts(stream: NativeStream) {
    try {
      for await (const event of stream) {
        if (this.closing || !this.listening) {
          for (const resource of event.resources ?? []) resource.close('server_closed')
          continue
        }
        if (event.resources?.length !== 1 || event.resources[0]?.type !== HTTP_SERVER_RESOURCE_TYPES.exchange) {
          for (const resource of event.resources ?? []) resource.close('unexpected_exchange_resource')
          throw createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL')
        }
        if (this.activeConnections >= this.limits.maxConnections) {
          this.abortExchange(event.resources[0], 'connection_limit')
          continue
        }
        const exchange = event.resources[0]
        this.beginExchange(exchange)
        let requestData
        try {
          requestData = decodeIncomingRequest(event.value, this.limits)
          const binary = event.binary ?? []
          const validUpgradeHead = requestData.kind === 'upgrade' && binary.length <= 1 &&
            (binary[0] == null ||
              (binary[0].handle === 'head' && binary[0].data.byteLength <= this.limits.maxChunkBytes))
          if (
            (requestData.kind === 'request' && binary.length !== 0) ||
            (requestData.kind === 'upgrade' && !validUpgradeHead)
          ) {
            throw createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL')
          }
        } catch (error) {
          this.abortExchange(exchange, 'invalid_request_event')
          throw error
        }
        const abort = (reason: string) => this.abortExchange(exchange, reason)
        const finalize = (reason?: string) => this.finalizeExchange(exchange, reason)
        const request = new IncomingMessage(this.client, exchange, requestData, this.limits, abort)
        if (requestData.kind === 'upgrade') {
          const head = event.binary?.[0]
          const socket = new UpgradeSocket(this.client, exchange, this.limits, finalize, abort)
          try {
            if (!this.emit('upgrade', request, socket, Buffer.from(head?.data ?? new Uint8Array()))) {
              socket.destroy('upgrade_unhandled')
            }
          } catch (error) {
            socket.destroy('upgrade_handler_failed')
            this.reportHandlerError(error)
          }
          continue
        }
        const response = new ServerResponse(this.client, exchange, this.limits, finalize, abort)
        try {
          if (!this.emit('request', request, response)) {
            response.statusCode = 404
            response.end()
          }
        } catch (error) {
          response.destroy()
          this.reportHandlerError(error)
        }
      }
    } catch (error) {
      if (!this.closing && this.listenerCount('error') > 0) this.emit('error', error)
    }
  }

  private reportHandlerError(error: unknown) {
    if (this.listenerCount('error') === 0) return
    this.emit('error', error instanceof Error ? error : createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL'))
  }
}
