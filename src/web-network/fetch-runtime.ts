/* eslint-disable max-lines -- fetch redirect, response resource and pull body share one owner. */

import { authorizeNetworkUrl, resolveNetworkAuthority } from './authority.js'
import { WEB_NETWORK_OPERATIONS } from './contract.js'
import { createWebNetworkError } from './errors.js'
import { NetworkBridgeClient, decodeNetworkValue } from './network-bridge-client.js'
import { emitNetworkDiagnostic } from './network-diagnostics.js'
import { validateRequestShape } from './request-validation.js'
import { WebAbortController, WebAbortSignal } from './web-abort.js'
import { WebBodyController } from './web-body.js'
import { WebHeaders, sanitizeResponseHeaders, validateRawHeaderEntries } from './web-headers.js'
import { WebRequest } from './web-request.js'
import { WebResponse } from './web-response.js'

import type { NativeResourceHandle, NativeStream } from '../native-port/types.js'
import type { NetworkBridgeCallOptions } from './network-bridge-client.js'
import type {
  NetworkDiagnosticsEvent,
  NetworkDiagnosticsResponse,
  NetworkHeaderEntries,
  ResolvedNetworkAuthority,
  WebFetchInit,
  WebNetworkRuntime,
  WebNetworkRuntimeOptions
} from './types.js'
import type { WebBodySource } from './web-body.js'
import type { WebRequestInfo } from './web-request.js'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const BODY_REPRESENTATION_HEADERS = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-type'
] as const

interface ConnectionLease {
  body?: NativeResponseBody
  released: boolean
  resource?: NativeResourceHandle
}

interface DiagnosticsTrace {
  bodyCaptureBytes: number
  bodyUnavailable: boolean
  hop: number
  requestId: string
  source: 'mock' | 'real'
  terminal: boolean
}

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'set-cookie'])
const SENSITIVE_QUERY_PARTS = ['auth', 'credential', 'key', 'password', 'secret', 'token'] as const
const APPLY = Reflect.apply
const SET_HAS = Set.prototype.has
const STRING_INCLUDES = String.prototype.includes
const STRING_TO_LOWER_CASE = String.prototype.toLowerCase
const lower = (value: string) => APPLY(STRING_TO_LOWER_CASE, value, [])
const includes = (value: string, search: string) => APPLY(STRING_INCLUDES, value, [search])
const setHas = <T>(set: Set<T>, value: T) => APPLY(SET_HAS, set, [value]) as boolean
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const encodeDiagnosticBase64 = (bytes: Uint8Array) => {
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    output += BASE64[first >> 2]
    output += BASE64[((first & 3) << 4) | ((second ?? 0) >> 4)]
    output += second == null ? '=' : BASE64[((second & 15) << 2) | ((third ?? 0) >> 6)]
    output += third == null ? '=' : BASE64[third & 63]
  }
  return output
}

const diagnosticHeaders = (headers: WebHeaders): NetworkHeaderEntries =>
  Object.freeze(
    [...headers].map(([name, value]) =>
      Object.freeze(
        [
          name,
          setHas(SENSITIVE_HEADERS, lower(name)) ? '<redacted>' : value
        ] as const
      )
    )
  )

const diagnosticUrl = (input: URL | string) => {
  const url = new URL(input.toString())
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    const normalized = lower(key)
    let sensitive = false
    for (let index = 0; index < SENSITIVE_QUERY_PARTS.length; index += 1) {
      if (includes(normalized, SENSITIVE_QUERY_PARTS[index]!)) sensitive = true
    }
    if (sensitive) url.searchParams.set(key, '<redacted>')
  }
  return url.toString()
}

const readHostConstructor = <TConstructor>(name: string) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  return descriptor != null && 'value' in descriptor && typeof descriptor.value === 'function'
    ? descriptor.value as TConstructor
    : undefined
}

const readRecord = (value: unknown) => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw createWebNetworkError('network.protocol_error')
  }
  return value as Record<string, unknown>
}

const readResponseHead = (
  value: unknown,
  requestedUrl: URL,
  authority: ResolvedNetworkAuthority
) => {
  const record = readRecord(value)
  const status = record.status
  const statusText = record.statusText
  const hasBody = record.hasBody
  const responseUrl = record.url
  const source = (record.source ?? 'real') as unknown
  if (
    !Number.isInteger(status) || (status as number) < 100 || (status as number) > 599 ||
    typeof statusText !== 'string' || /[\0\r\n]/u.test(statusText) ||
    typeof hasBody !== 'boolean' || typeof responseUrl !== 'string' ||
    (source !== 'mock' && source !== 'real')
  ) throw createWebNetworkError('network.protocol_error')
  let parsedResponseUrl: URL
  try {
    parsedResponseUrl = new URL(responseUrl)
  } catch {
    throw createWebNetworkError('network.protocol_error')
  }
  if (parsedResponseUrl.toString() !== requestedUrl.toString()) {
    throw createWebNetworkError('network.protocol_error')
  }
  authorizeNetworkUrl(authority, responseUrl, 'http')
  const limits = authority.limits
  let headers: WebHeaders
  try {
    headers = sanitizeResponseHeaders(validateRawHeaderEntries(record.headers, limits, false))
  } catch {
    throw createWebNetworkError('network.protocol_error')
  }
  return {
    hasBody,
    headers,
    source: source as DiagnosticsTrace['source'],
    status: status as number,
    statusText,
    url: responseUrl
  }
}

const getResponseResource = (result: { resources?: readonly NativeResourceHandle[] }) => {
  if (result.resources == null || result.resources.length !== 1 || result.resources[0]?.type !== 'network.http') {
    for (const resource of result.resources ?? []) resource.close('unexpected_network_resource')
    throw createWebNetworkError('network.protocol_error')
  }
  return result.resources[0]
}

class NativeResponseBody implements WebBodySource {
  private cancellationEpoch = 0
  private closed = false
  private stream?: NativeStream
  private totalBytes = 0
  private abortListener?: () => void

  constructor(
    private readonly client: NetworkBridgeClient,
    private readonly resource: NativeResourceHandle,
    private readonly options: NetworkBridgeCallOptions,
    private readonly authority: ResolvedNetworkAuthority,
    private readonly isCurrent: () => boolean,
    private readonly release: () => void,
    private readonly onData: (chunk: Uint8Array) => void,
    private readonly onFinished: (totalBytes: number) => void,
    private readonly onFailed: (code: string, cancelled: boolean) => void
  ) {
    if (options.signal != null) {
      this.abortListener = () => this.cancel('abort')
      options.signal.addEventListener('abort', this.abortListener, { once: true })
    }
  }

  async pull(): Promise<Uint8Array | undefined> {
    if (this.closed) throw createWebNetworkError('network.cancelled')
    const cancellationEpoch = this.cancellationEpoch
    this.stream ??= this.client.stream(
      WEB_NETWORK_OPERATIONS.http.readBody,
      { response: this.resource },
      this.options
    )
    let result: Awaited<ReturnType<NativeStream['next']>>
    try {
      result = await this.stream.next()
    } catch (error) {
      if (!this.isPullCurrent(cancellationEpoch)) {
        this.close('late_response_body')
        throw createWebNetworkError('network.cancelled')
      }
      this.close('read_error')
      this.onFailed((error as { code?: string })?.code ?? 'network.internal', false)
      throw this.client.normalizeError(error)
    }
    if (!this.isPullCurrent(cancellationEpoch)) {
      this.close('late_response_body')
      throw createWebNetworkError('network.cancelled')
    }
    if (result.done) {
      try {
        decodeNetworkValue(result.value?.value)
        this.onFinished(this.totalBytes)
      } catch (error) {
        this.onFailed((error as { code?: string })?.code ?? 'network.protocol_error', false)
        throw this.client.normalizeError(error)
      } finally {
        this.close('response_end')
      }
      return undefined
    }
    const value = readRecord(decodeNetworkValue(result.value.value))
    const binary = result.value.binary
    if (
      value.kind !== 'body' || binary == null || binary.length !== 1 ||
      binary[0].data.byteLength > this.authority.limits.maxChunkBytes
    ) {
      this.cancel('protocol_error')
      throw createWebNetworkError('network.protocol_error')
    }
    this.totalBytes += binary[0].data.byteLength
    if (this.totalBytes > this.authority.limits.maxResponseBodyBytes) {
      this.cancel('response_too_large')
      throw createWebNetworkError('network.response_too_large')
    }
    if (!this.isPullCurrent(cancellationEpoch)) {
      this.close('late_response_body')
      throw createWebNetworkError('network.cancelled')
    }
    const chunk = binary[0].data.slice()
    this.onData(chunk)
    return chunk
  }

  cancel(reason?: string) {
    if (this.closed) return
    this.cancellationEpoch += 1
    this.stream?.close(reason)
    void this.client.request(WEB_NETWORK_OPERATIONS.http.cancel, {
      response: this.resource
    }).catch(() => undefined)
    this.onFailed('network.cancelled', true)
    this.close(reason ?? 'response_cancelled')
  }

  private close(reason: string) {
    if (this.closed) return
    this.closed = true
    if (this.options.signal != null && this.abortListener != null) {
      this.options.signal.removeEventListener('abort', this.abortListener)
    }
    void this.client.request(WEB_NETWORK_OPERATIONS.http.close, {
      response: this.resource
    }).catch(() => undefined)
    this.resource.close(reason)
    this.release()
  }

  private isPullCurrent(cancellationEpoch: number) {
    return !this.closed && this.cancellationEpoch === cancellationEpoch && this.isCurrent()
  }
}

class FetchRuntimeController {
  private readonly activeConnections = new Set<ConnectionLease>()
  private readonly authority: ResolvedNetworkAuthority
  private readonly client: NetworkBridgeClient
  private disposed = false
  private generation = 0
  private nextDiagnosticRequest = 1

  constructor(private readonly options: WebNetworkRuntimeOptions) {
    this.authority = resolveNetworkAuthority(options.authority)
    this.client = new NetworkBridgeClient(options.bridge)
  }

  createRuntime(): WebNetworkRuntime {
    const abort = this.options.constructors
    const hostAbortController = readHostConstructor<typeof globalThis.AbortController>('AbortController')
    const hostAbortSignal = readHostConstructor<typeof globalThis.AbortSignal>('AbortSignal')
    return Object.freeze({
      AbortController: abort?.AbortController ?? hostAbortController ?? WebAbortController,
      AbortSignal: abort?.AbortSignal ?? hostAbortSignal ?? WebAbortSignal,
      Headers: WebHeaders,
      Request: WebRequest,
      Response: WebResponse,
      dispose: () => this.dispose(),
      fetch: (input: WebRequestInfo, init?: WebFetchInit) => this.fetch(input, init)
    }) as WebNetworkRuntime
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    for (const lease of [...this.activeConnections]) {
      lease.body?.cancel('runtime_disposed')
      lease.resource?.close('runtime_disposed')
      this.releaseConnection(lease)
    }
    this.client.dispose()
  }

  async fetch(input: WebRequestInfo, init: WebFetchInit = {}) {
    if (this.disposed) throw createWebNetworkError('network.cancelled')
    const generation = this.generation
    const trace: DiagnosticsTrace = {
      bodyCaptureBytes: 0,
      bodyUnavailable: false,
      hop: 0,
      requestId: `${generation}.${this.nextDiagnosticRequest++}`,
      source: 'real',
      terminal: false
    }
    const request = new WebRequest(input, init)
    let url = authorizeNetworkUrl(this.authority, request.url, 'http')
    let method = request.method
    const headers = new WebHeaders(request.headers)
    let body = request.consumeForFetch()
    validateRequestShape(method, headers, body, this.authority)
    const options: NetworkBridgeCallOptions = {
      ...(init.deadlineMs == null ? {} : { deadlineMs: init.deadlineMs }),
      signal: init.signal ?? request.signal,
      ...(init.timeoutMs == null ? {} : { timeoutMs: init.timeoutMs })
    }
    const redirect = init.redirect ?? 'follow'
    let redirectResponse: NetworkDiagnosticsResponse | undefined
    if (redirect !== 'follow' && redirect !== 'error' && redirect !== 'manual') {
      throw new TypeError('Invalid redirect mode')
    }
    try {
      for (let count = 0;; count += 1) {
        this.emit({
          headers: diagnosticHeaders(headers),
          hasPostData: body !== undefined,
          hop: trace.hop,
          method,
          ...(redirectResponse === undefined ? {} : { redirectResponse }),
          requestId: trace.requestId,
          timestampMs: this.timestamp(),
          type: 'requestWillBeSent',
          url: diagnosticUrl(url)
        })
        const response = await this.issue(url, method, headers, body, options, generation)
        this.assertCurrent(generation, response.lease)
        trace.source = response.head.source
        this.emit({
          headers: diagnosticHeaders(response.head.headers),
          hop: trace.hop,
          requestId: trace.requestId,
          source: trace.source,
          status: response.head.status,
          statusText: response.head.statusText,
          timestampMs: this.timestamp(),
          type: 'responseReceived',
          url: diagnosticUrl(response.head.url)
        })
        const location = response.head.headers.get('location')
        if (!REDIRECT_STATUSES.has(response.head.status) || location == null || redirect === 'manual') {
          return this.toResponse(response, count > 0, method, generation, trace)
        }
        this.closeConnection(response.lease, 'redirect')
        if (redirect === 'error' || count >= this.authority.limits.maxRedirects) {
          throw createWebNetworkError('network.redirect_limit')
        }
        const previousOrigin = url.origin
        redirectResponse = Object.freeze({
          headers: diagnosticHeaders(response.head.headers),
          source: trace.source,
          status: response.head.status,
          statusText: response.head.statusText,
          url: diagnosticUrl(response.head.url)
        })
        let redirectUrl: URL
        try {
          redirectUrl = new URL(location, url)
        } catch {
          throw createWebNetworkError('network.protocol_error')
        }
        redirectUrl.hash = ''
        url = authorizeNetworkUrl(this.authority, redirectUrl, 'http')
        trace.hop += 1
        if (url.origin !== previousOrigin) headers.delete('authorization')
        const rewriteToGet = (
          response.head.status === 303 && method !== 'GET' && method !== 'HEAD'
        ) || (
          (response.head.status === 301 || response.head.status === 302) && method === 'POST'
        )
        if (rewriteToGet) {
          method = 'GET'
          body = undefined
          for (const name of BODY_REPRESENTATION_HEADERS) headers.delete(name)
        }
      }
    } catch (error) {
      this.failTrace(trace, (error as { code?: string })?.code ?? 'network.internal')
      throw error
    }
  }

  private async issue(
    url: URL,
    method: string,
    headers: WebHeaders,
    body: Uint8Array | undefined,
    options: NetworkBridgeCallOptions,
    generation: number
  ) {
    const lease = this.acquireConnection()
    try {
      const started = await this.client.request(WEB_NETWORK_OPERATIONS.http.request, {
        headers: [...headers].map(([name, value]) => [name, value]),
        method,
        url: url.toString()
      }, options)
      const resource = getResponseResource(started)
      lease.resource = resource
      this.assertCurrent(generation, lease)
      const accepted = readRecord(decodeNetworkValue(started.value)).accepted
      if (accepted !== true) throw createWebNetworkError('network.protocol_error')
      await this.upload(resource, body ?? new Uint8Array(), options, generation, lease)
      const finished = await this.client.request(WEB_NETWORK_OPERATIONS.http.finishBody, {
        response: resource
      }, options)
      this.assertCurrent(generation, lease)
      return {
        head: readResponseHead(decodeNetworkValue(finished.value), url, this.authority),
        lease,
        options,
        resource
      }
    } catch (error) {
      this.closeConnection(lease, 'request_failed')
      throw error
    }
  }

  private async upload(
    resource: NativeResourceHandle,
    body: Uint8Array,
    options: NetworkBridgeCallOptions,
    generation: number,
    lease: ConnectionLease
  ) {
    const opened = await this.client.request(WEB_NETWORK_OPERATIONS.http.openBody, {
      response: resource
    }, options)
    this.assertCurrent(generation, lease)
    let credit = readCredit(decodeNetworkValue(opened.value), this.authority.limits.maxChunkBytes)
    for (let offset = 0; offset < body.byteLength;) {
      const size = Math.min(credit, this.authority.limits.maxChunkBytes, body.byteLength - offset)
      const write = await this.client.request(
        WEB_NETWORK_OPERATIONS.http.writeBody,
        {
          response: resource
        },
        options,
        [body.slice(offset, offset + size)]
      )
      this.assertCurrent(generation, lease)
      offset += size
      if (offset < body.byteLength) {
        credit = readCredit(decodeNetworkValue(write.value), this.authority.limits.maxChunkBytes)
      }
    }
  }

  private toResponse(
    response: Awaited<ReturnType<FetchRuntimeController['issue']>>,
    redirected: boolean,
    method: string,
    generation: number,
    trace: DiagnosticsTrace
  ) {
    this.assertCurrent(generation, response.lease)
    if (response.options.signal?.aborted) {
      this.closeConnection(response.lease, 'aborted_before_response')
      throw createWebNetworkError('network.cancelled')
    }
    if (
      response.head.hasBody &&
      (method === 'HEAD' || response.head.status === 204 || response.head.status === 205 ||
        response.head.status === 304)
    ) {
      this.closeConnection(response.lease, 'invalid_no_content_body')
      throw createWebNetworkError('network.protocol_error')
    }
    const body = response.head.hasBody
      ? new NativeResponseBody(
        this.client,
        response.resource,
        response.options,
        this.authority,
        () => {
          return this.isCurrent(generation)
        },
        () => this.releaseConnection(response.lease),
        chunk => this.emitData(trace, chunk),
        totalBytes => this.finishTrace(trace, totalBytes),
        (code, cancelled) => this.failTrace(trace, code, cancelled)
      )
      : undefined
    response.lease.body = body
    if (!response.head.hasBody) {
      this.closeConnection(response.lease, 'no_response_body')
      this.finishTrace(trace, 0)
    }
    return WebResponse.fromNetwork({
      body: new WebBodyController(body),
      headers: response.head.headers,
      maxBodyBytes: this.authority.limits.maxResponseBodyBytes,
      redirected,
      status: response.head.status,
      statusText: response.head.statusText,
      url: response.head.url
    })
  }

  private acquireConnection() {
    if (this.activeConnections.size >= this.authority.limits.maxConcurrentConnections) {
      throw createWebNetworkError('network.protocol_error')
    }
    const lease: ConnectionLease = { released: false }
    this.activeConnections.add(lease)
    return lease
  }

  private closeConnection(lease: ConnectionLease, reason: string) {
    lease.resource?.close(reason)
    this.releaseConnection(lease)
  }

  private releaseConnection(lease: ConnectionLease) {
    if (lease.released) return
    lease.released = true
    this.activeConnections.delete(lease)
  }

  private assertCurrent(generation: number, lease?: ConnectionLease) {
    if (!this.isCurrent(generation)) {
      if (lease != null) this.closeConnection(lease, 'network_runtime_disposed')
      throw createWebNetworkError('network.cancelled')
    }
  }

  private isCurrent(generation: number) {
    return !this.disposed && this.generation === generation
  }

  private emit(event: NetworkDiagnosticsEvent) {
    emitNetworkDiagnostic(this.options.diagnostics, Object.freeze(event))
  }

  private emitData(trace: DiagnosticsTrace, chunk: Uint8Array) {
    const limit = this.options.diagnosticsBodyLimitBytes ?? 0
    const canCapture = !trace.bodyUnavailable && limit > 0 && trace.bodyCaptureBytes + chunk.byteLength <= limit
    if (canCapture) trace.bodyCaptureBytes += chunk.byteLength
    else if (limit > 0) trace.bodyUnavailable = true
    this.emit({
      ...(canCapture ? { dataBase64: encodeDiagnosticBase64(chunk) } : {}),
      ...(trace.bodyUnavailable ? { bodyUnavailable: true } : {}),
      dataLength: chunk.byteLength,
      requestId: trace.requestId,
      source: trace.source,
      timestampMs: this.timestamp(),
      type: 'dataReceived'
    })
  }

  private failTrace(trace: DiagnosticsTrace, code: string, cancelled = code === 'network.cancelled') {
    if (trace.terminal) return
    trace.terminal = true
    this.emit({
      cancelled,
      code,
      requestId: trace.requestId,
      source: trace.source,
      timestampMs: this.timestamp(),
      type: 'loadingFailed'
    })
  }

  private finishTrace(trace: DiagnosticsTrace, totalBytes: number) {
    if (trace.terminal) return
    trace.terminal = true
    this.emit({
      requestId: trace.requestId,
      source: trace.source,
      timestampMs: this.timestamp(),
      totalBytes,
      type: 'loadingFinished'
    })
  }

  private timestamp() {
    try {
      const value = this.options.diagnosticsNow?.() ?? Date.now()
      return Number.isFinite(value) && value >= 0 ? value : 0
    } catch {
      return 0
    }
  }
}

const readCredit = (value: unknown, maximum: number) => {
  const credit = readRecord(value).creditBytes
  if (!Number.isSafeInteger(credit) || (credit as number) <= 0 || (credit as number) > maximum) {
    throw createWebNetworkError('network.protocol_error')
  }
  return credit as number
}

export const createFetchRuntime = (options: WebNetworkRuntimeOptions) => (
  new FetchRuntimeController(options).createRuntime()
)

export const installWebNetworkGlobals = (
  target: import('./types.js').WebNetworkGlobalTarget,
  options: WebNetworkRuntimeOptions,
  install: import('./types.js').WebNetworkInstallOptions = {}
) => {
  const runtime = createFetchRuntime(options)
  const previous = {
    AbortController: target.AbortController,
    AbortSignal: target.AbortSignal,
    Headers: target.Headers,
    Request: target.Request,
    Response: target.Response,
    fetch: target.fetch
  }
  target.fetch = runtime.fetch
  target.Headers = runtime.Headers
  target.Request = runtime.Request
  target.Response = runtime.Response
  if (!install.preserveExistingAbortGlobals || target.AbortController == null) {
    target.AbortController = runtime.AbortController
  }
  if (!install.preserveExistingAbortGlobals || target.AbortSignal == null) {
    target.AbortSignal = runtime.AbortSignal
  }
  return Object.freeze({
    restore: () => {
      target.AbortController = previous.AbortController
      target.AbortSignal = previous.AbortSignal
      target.Headers = previous.Headers
      target.Request = previous.Request
      target.Response = previous.Response
      target.fetch = previous.fetch
    },
    runtime
  })
}
