import { Buffer } from '../node-compat/buffer.js'
import type { RuntimeBuffer } from '../node-compat/buffer.js'
import { Writable } from '../streams/node-writable.js'

import { HTTP_SERVER_OPERATIONS } from './contract.js'
import { createHttpServerError } from './errors.js'
import { normalizeOutgoingHeaders } from './validation.js'

import type { NativeResourceHandle } from '../native-port/types.js'
import type { RuntimeStreamCallback, RuntimeStreamChunk } from '../streams/node-stream-types.js'
import type { HttpServerBridgeClient } from './bridge-client.js'
import type { HttpServerLimits } from './types.js'

export class ServerResponse extends Writable {
  headersSent = false
  statusCode = 200
  statusMessage: string | undefined
  private headers = new Map<string, string | readonly string[]>()
  private responseBytes = 0
  private terminal = false

  constructor(
    private readonly client: HttpServerBridgeClient,
    private readonly exchange: NativeResourceHandle,
    private readonly limits: Readonly<HttpServerLimits>,
    private readonly finishExchange: () => void,
    private readonly abortExchange: (reason: string) => void
  ) {
    super({
      highWaterMark: limits.maxChunkBytes,
      write: (chunk, _encoding, callback) => void this.writeChunk(chunk, callback),
      final: callback => void this.finishResponse(callback),
      destroy: (error, callback) => {
        if (!this.terminal) this.abortExchange('response_destroyed')
        callback(error)
      }
    })
  }

  getHeader(name: string) {
    return this.headers.get(this.normalizeHeaderName(name))
  }

  getHeaders() {
    return Object.freeze(Object.fromEntries(this.headers))
  }

  hasHeader(name: string) {
    return this.headers.has(this.normalizeHeaderName(name))
  }

  removeHeader(name: string) {
    if (this.headersSent) throw createHttpServerError('ERR_HOLONOMY_HTTP_INVALID_STATE')
    this.headers.delete(this.normalizeHeaderName(name))
  }

  setHeader(name: string, value: number | string | readonly string[]) {
    if (this.headersSent) throw createHttpServerError('ERR_HOLONOMY_HTTP_INVALID_STATE')
    const headers = new Map(this.headers)
    this.stageHeader(headers, name, value)
    normalizeOutgoingHeaders(headers, this.limits)
    this.headers = headers
    return this
  }

  writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | Readonly<Record<string, number | string | readonly string[]>>,
    maybeHeaders?: Readonly<Record<string, number | string | readonly string[]>>
  ) {
    if (this.headersSent) throw createHttpServerError('ERR_HOLONOMY_HTTP_INVALID_STATE')
    if (!Number.isSafeInteger(statusCode) || statusCode < 100 || statusCode > 999) {
      throw createHttpServerError('ERR_HOLONOMY_HTTP_INVALID_ARGUMENT')
    }
    const headers = typeof statusMessageOrHeaders === 'string' ? maybeHeaders : statusMessageOrHeaders
    if (
      typeof statusMessageOrHeaders === 'string' &&
      (statusMessageOrHeaders.includes('\0') || /[\r\n]/u.test(statusMessageOrHeaders) ||
        Buffer.byteLength(statusMessageOrHeaders) > 1_024)
    ) {
      throw createHttpServerError('ERR_HOLONOMY_HTTP_INVALID_ARGUMENT')
    }
    const stagedHeaders = new Map(this.headers)
    for (const [name, value] of Object.entries(headers ?? {})) this.stageHeader(stagedHeaders, name, value)
    normalizeOutgoingHeaders(stagedHeaders, this.limits)
    this.statusCode = statusCode
    this.statusMessage = typeof statusMessageOrHeaders === 'string' ? statusMessageOrHeaders : undefined
    this.headers = stagedHeaders
    return this
  }

  override end(chunk?: RuntimeStreamChunk | RuntimeStreamCallback, callback?: RuntimeStreamCallback): this {
    return super.end(chunk, callback)
  }

  private async ensureStarted() {
    if (this.headersSent) return
    this.headersSent = true
    try {
      const result = await this.client.request(HTTP_SERVER_OPERATIONS.response.start, {
        exchange: this.exchange,
        headers: normalizeOutgoingHeaders(this.headers, this.limits).map(entry => [entry[0], entry[1]]),
        statusCode: this.statusCode,
        ...(this.statusMessage == null ? {} : { statusMessage: this.statusMessage })
      })
    } catch (error) {
      this.abortExchange('response_start_failed')
      throw error
    }
  }

  private async writeChunk(chunk: RuntimeBuffer, callback: RuntimeStreamCallback) {
    try {
      if (chunk.byteLength > this.limits.maxChunkBytes) {
        throw createHttpServerError('ERR_HOLONOMY_HTTP_LIMIT_EXCEEDED')
      }
      this.responseBytes += chunk.byteLength
      if (this.responseBytes > this.limits.maxResponseBodyBytes) {
        throw createHttpServerError('ERR_HOLONOMY_HTTP_LIMIT_EXCEEDED')
      }
      await this.ensureStarted()
      await this.client.request(
        HTTP_SERVER_OPERATIONS.response.write,
        { exchange: this.exchange },
        [Buffer.from(chunk)]
      )
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL'))
    }
  }

  private async finishResponse(callback: RuntimeStreamCallback) {
    try {
      await this.ensureStarted()
      await this.client.request(HTTP_SERVER_OPERATIONS.response.end, { exchange: this.exchange })
      this.terminal = true
      this.finishExchange()
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL'))
    }
  }

  private normalizeHeaderName(name: string) {
    const normalized = String(name).trim().toLowerCase()
    if (normalized === '') throw createHttpServerError('ERR_HOLONOMY_HTTP_INVALID_ARGUMENT')
    return normalized
  }

  private stageHeader(
    headers: Map<string, string | readonly string[]>,
    name: string,
    value: number | string | readonly string[]
  ) {
    const normalizedName = this.normalizeHeaderName(name)
    const normalizedValue = Array.isArray(value) ? value.map(String) : String(value)
    headers.set(normalizedName, normalizedValue)
  }
}
