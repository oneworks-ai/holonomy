/* eslint-disable max-lines -- Response branding and bounded body admission share one private owner. */

import { createWebNetworkError } from './errors.js'
import { cloneBodyBytes } from './request-validation.js'
import { WebBodyController, createInlineBody } from './web-body.js'
import { WebHeaders, readTrustedWebHeader } from './web-headers.js'

import type { WebBodyInit, WebNetworkCapabilityAdmissionV1, WebNetworkCapabilityHooksV1 } from './types.js'
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
  capability?: Readonly<{
    admission: WebNetworkCapabilityAdmissionV1
    hooks: WebNetworkCapabilityHooksV1
    metadata: Parameters<WebNetworkCapabilityHooksV1['authorizeResponse']>[0]['metadata']
  }>
}

const STATUS_TEXT_INVALID = /[\r\n\0]/u
const NULL_BODY_STATUSES = new Set([204, 205, 304])
const APPLY = Reflect.apply
const OBJECT_CREATE = Object.create
const OBJECT_FREEZE = Object.freeze
const OBJECT_KEYS = Object.keys
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger
const MATH_MIN = Math.min
const STRING_INDEX_OF = String.prototype.indexOf
const STRING_SLICE = String.prototype.slice
const STRING_TRIM = String.prototype.trim
const STRING_TO_LOWER_CASE = String.prototype.toLowerCase
const WEAK_MAP_GET = WeakMap.prototype.get
const WEAK_MAP_SET = WeakMap.prototype.set
const BODY_BYTES = WebBodyController.prototype.bytes
const BODY_CANCEL = WebBodyController.prototype.cancel
const BODY_CLONE = WebBodyController.prototype.clone
const trustedWasmResponses = new WeakMap<
  WebResponse,
  Readonly<{
    body: WebBodyController
    capability?: WebNetworkResponseInit['capability']
    headers: WebHeaders
    maxBodyBytes: number
    redirected: boolean
    status: number
    statusText: string
    url: string
  }>
>()
const trustedNetworkResponse = Symbol('trusted network response')

export class WebResponse {
  readonly headers: WebHeaders
  readonly redirected: boolean
  readonly status: number
  readonly statusText: string
  readonly type = 'basic'
  readonly url: string
  private readonly bodyController: WebBodyController
  private readonly maxBodyBytes: number
  private readonly capability?: WebNetworkResponseInit['capability']

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
    WebResponse.#rememberWasmResponse(this)
  }

  static fromNetwork(init: WebNetworkResponseInit, trusted?: symbol) {
    const fields = {
      bodyController: init.body,
      ...(init.capability == null ? {} : { capability: init.capability }),
      headers: new WebHeaders(init.headers),
      maxBodyBytes: init.maxBodyBytes,
      redirected: init.redirected,
      status: init.status ?? 200,
      statusText: init.statusText ?? '',
      type: 'basic',
      url: init.url
    }
    const descriptors = OBJECT_CREATE(null) as PropertyDescriptorMap
    for (const name of OBJECT_KEYS(fields) as (keyof typeof fields)[]) {
      descriptors[name] = { configurable: true, enumerable: true, value: fields[name], writable: true }
    }
    const response = OBJECT_CREATE(WebResponse.prototype, descriptors) as WebResponse
    if (trusted === trustedNetworkResponse) WebResponse.#rememberWasmResponse(response)
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
    await this.authorizeBody('Response.arrayBuffer')
    const bytes = await this.bodyController.bytes(this.maxBodyBytes)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }

  async text() {
    await this.authorizeBody('Response.text')
    return this.bodyController.text(this.maxBodyBytes)
  }

  async json() {
    await this.authorizeBody('Response.json')
    return JSON.parse(await this.bodyController.text(this.maxBodyBytes)) as unknown
  }

  async bytes() {
    await this.authorizeBody('Response.bytes')
    return await this.bodyController.bytes(this.maxBodyBytes)
  }

  clone() {
    const trusted = APPLY(WEAK_MAP_GET, trustedWasmResponses, [this]) as
      | ReturnType<typeof trustedWasmResponses.get>
      | undefined
    const sourceCapability = trusted?.capability ?? this.capability
    const admission = sourceCapability?.hooks.cloneResponse(sourceCapability.admission)
    const capability = sourceCapability == null || admission == null
      ? undefined
      : { admission, hooks: sourceCapability.hooks, metadata: sourceCapability.metadata }
    let body: WebBodyController | undefined
    try {
      body = APPLY(BODY_CLONE, trusted?.body ?? this.bodyController, [
        capability == null ? undefined : () => capability.hooks.releaseResponse(capability.admission)
      ]) as WebBodyController
      return APPLY(FROM_NETWORK, WebResponse, [{
        body,
        headers: trusted?.headers ?? this.headers,
        maxBodyBytes: trusted?.maxBodyBytes ?? this.maxBodyBytes,
        redirected: trusted?.redirected ?? this.redirected,
        status: trusted?.status ?? this.status,
        statusText: trusted?.statusText ?? this.statusText,
        url: trusted?.url ?? this.url,
        ...(capability == null ? {} : { capability })
      }, trusted == null ? undefined : trustedNetworkResponse]) as WebResponse
    } catch (error) {
      try {
        if (body == null) capability?.hooks.releaseResponse(capability.admission)
        else APPLY(BODY_CANCEL, body, ['clone_failed'])
      } catch {
        // Cleanup must not replace the selected clone failure.
      }
      throw error
    }
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

  private async authorizeBody(member: Parameters<WebNetworkCapabilityHooksV1['authorizeResponse']>[1]) {
    if (this.capability == null) return
    await this.capability.hooks.authorizeResponse({
      admission: this.capability.admission,
      metadata: this.capability.metadata
    }, member)
  }

  static #rememberWasmResponse(response: WebResponse) {
    APPLY(WEAK_MAP_SET, trustedWasmResponses, [
      response,
      OBJECT_FREEZE({
        body: response.bodyController,
        ...(response.capability == null
          ? {}
          : { capability: OBJECT_FREEZE({ ...response.capability }) }),
        headers: response.headers,
        maxBodyBytes: response.maxBodyBytes,
        redirected: response.redirected,
        status: response.status,
        statusText: response.statusText,
        url: response.url
      })
    ])
  }
}

// Capture the internal factory before Guest code can replace the public static
// method and observe the private trust token passed by Fetch or clone().
const FROM_NETWORK = WebResponse.fromNetwork

/** Adapter-only bounded reader for genuine Runtime Responses. */
export const readWasmStreamingResponse = async (input: unknown, maximumBytes: number) => {
  const state = APPLY(WEAK_MAP_GET, trustedWasmResponses, [input]) as
    | ReturnType<typeof trustedWasmResponses.get>
    | undefined
  if (state == null) throw new TypeError('WebAssembly streaming source must resolve to a Response')
  const cancel = (reason: string) => {
    try {
      APPLY(BODY_CANCEL, state.body, [reason])
    } catch {
      // Preserve the selected response or body error if the stream is locked.
    }
  }
  const mime = readTrustedWebHeader(state.headers, 'content-type')
  const separator = mime == null ? -1 : APPLY(STRING_INDEX_OF, mime, [';']) as number
  const essence = mime == null
    ? null
    : APPLY(
      STRING_TO_LOWER_CASE,
      APPLY(STRING_TRIM, separator < 0 ? mime : APPLY(STRING_SLICE, mime, [0, separator]), []),
      []
    ) as string
  if (
    state.status < 200 || state.status > 299 ||
    essence !== 'application/wasm'
  ) {
    cancel('invalid_wasm_response')
    throw new TypeError('WebAssembly streaming response must be successful application/wasm')
  }
  if (!NUMBER_IS_SAFE_INTEGER(maximumBytes) || maximumBytes < 0) {
    throw new TypeError('Invalid WebAssembly source limit')
  }
  try {
    if (state.capability != null) {
      await state.capability.hooks.authorizeResponse({
        admission: state.capability.admission,
        metadata: state.capability.metadata
      }, 'Response.bytes')
    }
    return await APPLY(BODY_BYTES, state.body, [MATH_MIN(state.maxBodyBytes, maximumBytes)]) as Uint8Array
  } catch (error) {
    cancel('wasm_response_read_failed')
    throw error
  }
}

/** Only the Fetch runtime can mark a network Response as a trusted source. */
export const createTrustedNetworkResponse = (init: WebNetworkResponseInit) => (
  APPLY(FROM_NETWORK, WebResponse, [init, trustedNetworkResponse]) as WebResponse
)
