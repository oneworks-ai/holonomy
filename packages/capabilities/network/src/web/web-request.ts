import { cloneBodyBytes, normalizeMethod } from './request-validation.js'
import { decodeUtf8 } from './utf8.js'
import { WebHeaders } from './web-headers.js'

import type { WebBodyInit } from './types.js'
import type { WebHeadersInit } from './web-headers.js'

export type WebRequestInfo = string | URL | WebRequest

export interface WebRequestInit {
  body?: WebBodyInit | null
  credentials?: 'omit'
  headers?: WebHeadersInit
  method?: string
  signal?: AbortSignal
}

export class WebRequest {
  readonly credentials = 'omit'
  readonly headers: WebHeaders
  readonly method: string
  readonly signal?: AbortSignal
  readonly url: string
  private bodyBytes?: Uint8Array
  private used = false

  constructor(input: WebRequestInfo, init: WebRequestInit = {}) {
    const source = input instanceof WebRequest ? input : undefined
    if (source?.bodyUsed && init.body == null) throw new TypeError('Body has already been consumed')
    if (init.credentials != null && init.credentials !== 'omit') {
      throw new TypeError('Only credentials=omit is supported')
    }
    try {
      const url = new URL(source?.url ?? input.toString())
      url.hash = ''
      this.url = url.toString()
    } catch {
      throw new TypeError('Request URL must be absolute')
    }
    this.method = normalizeMethod(init.method ?? source?.method)
    this.headers = new WebHeaders(init.headers ?? source?.headers)
    this.signal = init.signal ?? source?.signal
    this.bodyBytes = cloneBodyBytes(init.body ?? source?.peekBody())
    if (typeof init.body === 'string' && !this.headers.has('content-type')) {
      this.headers.set('content-type', 'text/plain;charset=UTF-8')
    }
    if ((this.method === 'GET' || this.method === 'HEAD') && this.bodyBytes != null) {
      throw new TypeError('GET and HEAD requests cannot have a body')
    }
  }

  get bodyUsed() {
    return this.used
  }

  get body() {
    return this.bodyBytes == null ? null : this.bodyBytes.slice()
  }

  clone() {
    if (this.used) throw new TypeError('Body has already been consumed')
    return new WebRequest(this)
  }

  async arrayBuffer() {
    return this.consume().buffer
  }

  async text() {
    return decodeUtf8(this.consume())
  }

  async json() {
    return JSON.parse(await this.text()) as unknown
  }

  consumeForFetch() {
    if (this.bodyBytes == null) return undefined
    return this.consume()
  }

  private peekBody() {
    return this.bodyBytes?.slice()
  }

  private consume() {
    if (this.used) throw new TypeError('Body has already been consumed')
    this.used = this.bodyBytes != null
    return this.bodyBytes?.slice() ?? new Uint8Array()
  }
}
