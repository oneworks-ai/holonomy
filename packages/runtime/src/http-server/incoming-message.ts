import { Readable } from '../streams/node-readable.js'

import { HTTP_SERVER_OPERATIONS } from './contract.js'
import { createHttpServerError } from './errors.js'

import type { NativeResourceHandle, NativeStream } from '../native-port/types.js'
import type { HttpServerBridgeClient } from './bridge-client.js'
import type { HttpIncomingHeaders, HttpServerLimits } from './types.js'
import type { DecodedIncomingRequest } from './validation.js'

export class IncomingMessage extends Readable {
  readonly headers: HttpIncomingHeaders
  readonly httpVersion: string
  readonly method: string
  readonly rawHeaders: readonly string[]
  readonly url: string
  aborted = false
  private bodyBytes = 0
  private bodyDone = false
  private bodyStream: NativeStream | undefined
  private pulling = false

  constructor(
    private readonly client: HttpServerBridgeClient,
    private readonly exchange: NativeResourceHandle,
    request: DecodedIncomingRequest,
    private readonly limits: Readonly<HttpServerLimits>,
    private readonly abortExchange: (reason: string) => void
  ) {
    super({
      highWaterMark: limits.maxChunkBytes,
      read: () => void this.pullBody(),
      destroy: (error, callback) => {
        this.bodyStream?.close('request_destroyed')
        if (!this.bodyDone) this.abort('request_destroyed')
        callback(error)
      }
    })
    this.headers = request.headers
    this.httpVersion = request.httpVersion
    this.method = request.method
    this.rawHeaders = request.rawHeaders
    this.url = request.url
  }

  abort(reason: string) {
    if (this.aborted || this.bodyDone) return
    this.aborted = true
    this.bodyStream?.close(reason)
    this.emit('aborted')
    this.abortExchange(reason)
  }

  private async pullBody() {
    if (this.pulling || this.bodyDone || this.destroyed) return
    this.pulling = true
    try {
      this.bodyStream ??= this.client.stream(HTTP_SERVER_OPERATIONS.request.read, {
        exchange: this.exchange
      })
      const result = await this.bodyStream.next()
      const resources = result.value?.resources ?? []
      for (const resource of resources) resource.close('unexpected_request_body_resource')
      if (resources.length !== 0) throw createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL')
      if (result.done) {
        if ((result.value?.binary?.length ?? 0) !== 0 || result.value?.value !== undefined) {
          throw createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL')
        }
        this.bodyDone = true
        this.push(null)
        return
      }
      const binary = result.value.binary ?? []
      if (binary.length !== 1 || binary[0]?.handle !== 'body' || result.value.value !== undefined) {
        throw createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL')
      }
      const chunk = binary[0].data
      if (chunk.byteLength > this.limits.maxChunkBytes) {
        throw createHttpServerError('ERR_HOLONOMY_HTTP_LIMIT_EXCEEDED')
      }
      this.bodyBytes += chunk.byteLength
      if (this.bodyBytes > this.limits.maxRequestBodyBytes) {
        throw createHttpServerError('ERR_HOLONOMY_HTTP_LIMIT_EXCEEDED')
      }
      this.push(chunk)
    } catch (error) {
      this.abort('request_body_failed')
      this.destroy(error instanceof Error ? error : createHttpServerError('ERR_HOLONOMY_HTTP_PROTOCOL'))
    } finally {
      this.pulling = false
    }
  }
}
