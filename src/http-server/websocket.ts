/* eslint-disable max-lines -- accepted socket, upgrade adapter and noServer facade share one lifecycle state machine. */

import { Buffer } from '../node-compat/buffer.js'
import { EventEmitter } from '../node-compat/events.js'

import { HTTP_SERVER_OPERATIONS } from './contract.js'
import { createHttpServerError } from './errors.js'

import type { NativeResourceHandle, NativeStream } from '../native-port/types.js'
import type { HttpServerBridgeClient } from './bridge-client.js'
import type { IncomingMessage } from './incoming-message.js'
import type { HttpServerLimits } from './types.js'

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

interface AcceptedWebSocket {
  readonly client: HttpServerBridgeClient
  readonly limits: Readonly<HttpServerLimits>
  readonly resource: NativeResourceHandle
  readonly release: () => void
}

export class WebSocket extends EventEmitter {
  static readonly CLOSED = CLOSED
  static readonly CLOSING = CLOSING
  static readonly CONNECTING = CONNECTING
  static readonly OPEN = OPEN
  readonly CLOSED = CLOSED
  readonly CLOSING = CLOSING
  readonly CONNECTING = CONNECTING
  readonly OPEN = OPEN
  binaryType = 'nodebuffer'
  bufferedAmount = 0
  readyState = OPEN
  private closeEmitted = false
  private readonly client: HttpServerBridgeClient
  private readonly limits: Readonly<HttpServerLimits>
  private readonly resource: NativeResourceHandle
  private readonly release: () => void
  private sendTail = Promise.resolve()
  private stream: NativeStream | undefined

  constructor(accepted?: AcceptedWebSocket) {
    super()
    if (accepted == null) throw createHttpServerError('ERR_MOBILE_HTTP_UNSUPPORTED')
    this.client = accepted.client
    this.limits = accepted.limits
    this.resource = accepted.resource
    this.release = accepted.release
    void this.pump()
  }

  close(code = 1000, reason = '') {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return
    if (!Number.isSafeInteger(code) || code < 1000 || code > 4999 || Buffer.byteLength(reason) > 123) {
      throw createHttpServerError('ERR_MOBILE_HTTP_INVALID_ARGUMENT')
    }
    this.readyState = CLOSING
    void this.sendTail.then(() =>
      this.client.request(HTTP_SERVER_OPERATIONS.websocket.close, {
        code,
        reason,
        websocket: this.resource
      })
    ).then(
      () => this.finishClose(code, reason),
      error => {
        this.emit('error', error)
        this.finishClose(1006, '')
      }
    )
  }

  send(
    data: string | Uint8Array,
    optionsOrCallback?: { readonly binary?: boolean } | ((error?: Error) => void),
    callback?: (error?: Error) => void
  ) {
    if (this.readyState !== OPEN) throw createHttpServerError('ERR_MOBILE_HTTP_INVALID_STATE')
    const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
    if (
      bytes.byteLength > this.limits.maxWebSocketMessageBytes ||
      this.bufferedAmount + bytes.byteLength > this.limits.maxWebSocketBufferedBytes
    ) {
      throw createHttpServerError('ERR_MOBILE_HTTP_LIMIT_EXCEEDED')
    }
    const completion = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
    const isBinary = typeof optionsOrCallback === 'object'
      ? optionsOrCallback.binary ?? typeof data !== 'string'
      : typeof data !== 'string'
    this.bufferedAmount += bytes.byteLength
    const send = this.sendTail.then(async () => {
      await this.client.request(
        HTTP_SERVER_OPERATIONS.websocket.send,
        { isBinary, websocket: this.resource },
        [bytes]
      )
    })
    this.sendTail = send.then(
      () => {
        this.bufferedAmount -= bytes.byteLength
        completion?.()
      },
      error => {
        this.bufferedAmount -= bytes.byteLength
        completion?.(error instanceof Error ? error : createHttpServerError('ERR_MOBILE_HTTP_PROTOCOL'))
        this.emit('error', error)
        this.finishClose(1006, '')
      }
    )
  }

  terminate() {
    this.finishClose(1006, '')
  }

  private async pump() {
    try {
      this.stream = this.client.stream(HTTP_SERVER_OPERATIONS.websocket.read, {
        websocket: this.resource
      })
      while (true) {
        const result = await this.stream.next()
        const resources = result.value?.resources ?? []
        for (const resource of resources) resource.close('unexpected_websocket_resource')
        if (resources.length !== 0) throw createHttpServerError('ERR_MOBILE_HTTP_PROTOCOL')
        if (result.done) {
          if ((result.value?.binary?.length ?? 0) !== 0 || result.value?.value !== undefined) {
            throw createHttpServerError('ERR_MOBILE_HTTP_PROTOCOL')
          }
          this.finishClose(1000, '')
          return
        }
        const event = result.value
        const value = event.value
        if (value == null || typeof value !== 'object' || Array.isArray(value)) {
          throw createHttpServerError('ERR_MOBILE_HTTP_PROTOCOL')
        }
        const record = value as Record<string, unknown>
        if (record.kind === 'close') {
          const code = typeof record.code === 'number' ? record.code : 1000
          const reason = typeof record.reason === 'string' ? record.reason : ''
          if (
            !Number.isSafeInteger(code) || code < 1000 || code > 4999 ||
            Buffer.byteLength(reason) > 123 || (event.binary?.length ?? 0) !== 0
          ) {
            throw createHttpServerError('ERR_MOBILE_HTTP_PROTOCOL')
          }
          this.finishClose(code, reason)
          return
        }
        if (record.kind !== 'message' || typeof record.isBinary !== 'boolean') {
          throw createHttpServerError('ERR_MOBILE_HTTP_PROTOCOL')
        }
        const binary = event.binary ?? []
        if (
          binary.length !== 1 || binary[0]?.handle !== 'message' ||
          binary[0].data.byteLength > this.limits.maxWebSocketMessageBytes
        ) {
          throw createHttpServerError('ERR_MOBILE_HTTP_PROTOCOL')
        }
        this.emit('message', Buffer.from(binary[0].data), record.isBinary)
      }
    } catch (error) {
      if (this.readyState !== CLOSED) this.emit('error', error)
      this.finishClose(1006, '')
    }
  }

  private finishClose(code: number, reason: string) {
    if (this.closeEmitted) return
    this.closeEmitted = true
    this.readyState = CLOSED
    this.stream?.close('websocket_closed')
    this.resource.close('websocket_closed')
    this.release()
    this.emit('close', code, Buffer.from(reason))
  }
}

export class UpgradeSocket extends EventEmitter {
  destroyed = false
  private consumed = false

  constructor(
    private readonly client: HttpServerBridgeClient,
    private readonly exchange: NativeResourceHandle,
    private readonly limits: Readonly<HttpServerLimits>,
    private readonly finalizeExchange: (reason?: string) => void,
    private readonly abortExchange: (reason: string) => void
  ) {
    super()
  }

  async accept(maxPayload?: number) {
    if (this.destroyed || this.consumed) throw createHttpServerError('ERR_MOBILE_HTTP_INVALID_STATE')
    this.consumed = true
    try {
      const result = await this.client.request(HTTP_SERVER_OPERATIONS.websocket.accept, {
        exchange: this.exchange
      })
      const resource = result.resources![0]!
      if (this.destroyed) {
        resource.close('late_websocket_accept')
        throw createHttpServerError('ERR_MOBILE_HTTP_ABORTED')
      }
      this.exchange.close('websocket_accepted')
      return new WebSocket({
        client: this.client,
        limits: maxPayload == null
          ? this.limits
          : Object.freeze({
            ...this.limits,
            maxWebSocketMessageBytes: Math.min(this.limits.maxWebSocketMessageBytes, maxPayload)
          }),
        release: () => this.finalizeExchange('websocket_closed'),
        resource
      })
    } catch (error) {
      this.destroy('websocket_accept_failed')
      throw error
    }
  }

  destroy(reason = 'upgrade_rejected') {
    if (this.destroyed) return this
    this.destroyed = true
    this.abortExchange(reason)
    this.emit('close')
    return this
  }
}

export interface WebSocketServerOptions {
  readonly maxPayload?: number
  readonly noServer?: boolean
}

export class WebSocketServer extends EventEmitter {
  readonly clients = new Set<WebSocket>()
  private closed = false

  constructor(readonly options: WebSocketServerOptions = {}) {
    super()
    if (options.noServer !== true) throw createHttpServerError('ERR_MOBILE_HTTP_UNSUPPORTED')
    if (options.maxPayload != null && (!Number.isSafeInteger(options.maxPayload) || options.maxPayload <= 0)) {
      throw createHttpServerError('ERR_MOBILE_HTTP_INVALID_ARGUMENT')
    }
  }

  close(callback?: () => void) {
    if (this.closed) {
      callback?.()
      return
    }
    this.closed = true
    for (const client of this.clients) client.close(1001, 'server closing')
    this.emit('close')
    callback?.()
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: UpgradeSocket,
    _head: Uint8Array,
    callback: (socket: WebSocket, request: IncomingMessage) => void
  ) {
    if (this.closed) {
      socket.destroy('websocket_server_closed')
      return
    }
    void socket.accept(this.options.maxPayload).then(websocket => {
      if (this.closed) {
        websocket.terminate()
        return
      }
      this.clients.add(websocket)
      websocket.once('close', () => this.clients.delete(websocket))
      callback(websocket, request)
      this.emit('connection', websocket, request)
    }).catch(error => this.emit('error', error))
  }
}
