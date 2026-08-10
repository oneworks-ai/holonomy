import { createWebNetworkError } from './errors.js'
import { cloneBodyBytes } from './request-validation.js'
import { createInlineBody } from './web-body.js'
import { WebHeaders } from './web-headers.js'

import type { WebBodyInit } from './types.js'
import type { WebBodyController } from './web-body.js'
import type { WebHeadersInit } from './web-headers.js'

export interface WebResponseInit {
  headers?: WebHeadersInit
  status?: number
  statusText?: string
}

export interface WebNetworkResponseInit extends WebResponseInit {
  body: WebBodyController
  maxBodyBytes: number
  redirected: boolean
  url: string
}

const STATUS_TEXT_INVALID = /[\r\n\0]/u
const NULL_BODY_STATUSES = new Set([204, 205, 304])

export class WebResponse {
  readonly headers: WebHeaders
  readonly redirected: boolean
  readonly status: number
  readonly statusText: string
  readonly type = 'basic'
  readonly url: string
  private readonly bodyController: WebBodyController
  private readonly maxBodyBytes: number

  constructor(body?: WebBodyInit | null, init: WebResponseInit = {}) {
    this.status = init.status ?? 200
    if (!Number.isInteger(this.status) || this.status < 200 || this.status > 599) {
      throw new RangeError('Invalid response status')
    }
    this.statusText = init.statusText ?? ''
    if (STATUS_TEXT_INVALID.test(this.statusText)) throw new TypeError('Invalid status text')
    if (body != null && NULL_BODY_STATUSES.has(this.status)) {
      throw new TypeError('Response status cannot have a body')
    }
    this.headers = new WebHeaders(init.headers)
    this.redirected = false
    this.url = ''
    const bytes = cloneBodyBytes(body)
    this.bodyController = createInlineBody(bytes)
    this.maxBodyBytes = bytes?.byteLength ?? 0
  }

  static fromNetwork(init: WebNetworkResponseInit) {
    const response = Object.create(WebResponse.prototype) as WebResponse
    Object.assign(response, {
      bodyController: init.body,
      headers: new WebHeaders(init.headers),
      maxBodyBytes: init.maxBodyBytes,
      redirected: init.redirected,
      status: init.status ?? 200,
      statusText: init.statusText ?? '',
      type: 'basic',
      url: init.url
    })
    return response
  }

  static error() {
    return WebResponse.fromNetwork({
      body: createInlineBody(undefined),
      maxBodyBytes: 0,
      redirected: false,
      status: 0,
      statusText: '',
      url: ''
    })
  }

  static json(value: unknown, init: WebResponseInit = {}) {
    const headers = new WebHeaders(init.headers)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    return new WebResponse(JSON.stringify(value), { ...init, headers })
  }

  get body() {
    return this.bodyController.hasBody ? this.bodyController.stream : null
  }

  get bodyUsed() {
    return this.bodyController.bodyUsed
  }

  get ok() {
    return this.status >= 200 && this.status <= 299
  }

  async arrayBuffer() {
    const bytes = await this.bodyController.bytes(this.maxBodyBytes)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }

  async text() {
    return this.bodyController.text(this.maxBodyBytes)
  }

  async json() {
    return JSON.parse(await this.text()) as unknown
  }

  clone() {
    return WebResponse.fromNetwork({
      body: this.bodyController.clone(),
      headers: this.headers,
      maxBodyBytes: this.maxBodyBytes,
      redirected: this.redirected,
      status: this.status,
      statusText: this.statusText,
      url: this.url
    })
  }

  dispose() {
    this.bodyController.cancel('response_disposed')
  }

  assertNetworkShape() {
    if (
      !Number.isInteger(this.status) ||
      this.status < 100 ||
      this.status > 599 ||
      STATUS_TEXT_INVALID.test(this.statusText)
    ) throw createWebNetworkError('network.protocol_error')
  }
}
