/* eslint-disable max-lines -- mock and passthrough resource lifecycles share one NativePort owner. */

import { authorizeNetworkUrl, resolveNetworkAuthority } from './authority.js'
import { WEB_NETWORK_MODULE, WEB_NETWORK_OPERATIONS, networkFailure, networkSuccess } from './contract.js'
import { NetworkMockRuleStore } from './network-rules.js'
import { normalizeMethod } from './request-validation.js'
import { encodeUtf8 } from './utf8.js'
import { validateRawHeaderEntries } from './web-headers.js'

import type {
  NativeCallToken,
  NativeDispatchContext,
  NativePort,
  NativePortErrorData,
  NativePortEvent,
  NativePortEventSink,
  NativePortRequest,
  NativePortResourceBinding,
  NativePortResourceEventSink,
  NativePortResourceReference,
  NativeProviderToken
} from '@holonomyjs/runtime/native-port/types'
import type { NetworkAuthority, NetworkMockRuleSet, NetworkMockRuleSetSnapshot } from './types.js'

export interface NetworkMockRouterOptions {
  authority: NetworkAuthority
  bodySha256?: (body: Uint8Array) => string
  bodySha256Chunks?: (body: readonly Uint8Array[]) => string
  delay?: (milliseconds: number) => Promise<void>
  initialRules?: NetworkMockRuleSet
  passthrough: NativePort
}

interface DownstreamResource {
  ownerCallToken: NativeCallToken
  providerToken: NativeProviderToken
  reference: NativePortResourceReference
}

interface Reader {
  callToken: NativeCallToken
  id: string
  index: number
  sequence: number
  sink: NativePortEventSink
}

interface Exchange {
  body: Uint8Array[]
  bodyBytes: number
  capabilityBindingId: string | null
  downstream?: DownstreamResource
  headers: Array<[string, string]>
  method: string
  mockBody: Uint8Array[]
  ownerCallToken: NativeCallToken
  phase: 'accepted' | 'closed' | 'reading' | 'response' | 'uploading'
  principal: string
  providerToken: NativeProviderToken
  reader?: Reader
  resourceSink: NativePortResourceEventSink
  ruleSnapshot: NetworkMockRuleSetSnapshot
  ruleSnapshotId: string
  url: string
}

interface LogicalRuleSnapshot {
  activeProviderToken?: NativeProviderToken
  principal: string
  snapshot: NetworkMockRuleSetSnapshot
}

const HTTP_OPERATIONS = new Set<string>(Object.values(WEB_NETWORK_OPERATIONS.http))
const MAX_CONTIGUOUS_MATCH_BODY_BYTES = 1024 * 1024
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'set-cookie'])
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const hasNetworkCapability = (context: Readonly<NativeDispatchContext>) => (
  context.authority.capabilities.includes('host.network.http') ||
  context.authority.capabilities.includes('host.network.mock')
)

const record = (value: unknown) => (
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
)

const hasExactKeys = (value: Record<string, unknown> | undefined, keys: readonly string[]) => (
  value != null && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
)

const reject = (sink: NativePortEventSink, id: string, code: NativePortErrorData['code']) => {
  sink({ error: { code }, id, type: 'error' })
}

const decodeBase64 = (value: string) => {
  const clean = value.replace(/=+$/u, '')
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const character of clean) {
    const digit = BASE64.indexOf(character)
    if (digit < 0) throw new TypeError('Invalid base64')
    buffer = (buffer << 6) | digit
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xFF)
    }
  }
  return new Uint8Array(bytes)
}

const copyBody = (parts: readonly Uint8Array[]) => {
  const bytes = parts.reduce((total, part) => total + part.byteLength, 0)
  const body = new Uint8Array(bytes)
  let offset = 0
  for (const part of parts) {
    body.set(part, offset)
    offset += part.byteLength
  }
  return body
}

export class NetworkMockRouter implements NativePort {
  readonly rules = new NetworkMockRuleStore()
  private readonly authority: ReturnType<typeof resolveNetworkAuthority>
  private readonly calls = new Map<NativeCallToken, NativeCallToken>()
  private readonly exchanges = new Map<NativeProviderToken, Exchange>()
  private readonly logicalRuleSnapshots = new Map<string, LogicalRuleSnapshot>()
  private readonly passthrough: NativePort
  private activeConnections = 0
  private disposed = false
  private nextCall = 1
  private nextResource = 1
  private nextRuleSnapshot = 1

  constructor(private readonly options: NetworkMockRouterOptions) {
    this.authority = resolveNetworkAuthority(options.authority)
    this.passthrough = options.passthrough
    if (options.initialRules != null) this.rules.replace(options.initialRules)
  }

  cancel(callToken: NativeCallToken, reason?: string) {
    const downstream = this.calls.get(callToken)
    this.calls.delete(callToken)
    if (downstream != null) return this.passthrough.cancel(downstream, reason)
    for (const exchange of this.exchanges.values()) {
      if (exchange.reader?.callToken === callToken) this.closeReader(exchange, 'cancelled')
    }
  }

  closeResource(ownerCallToken: NativeCallToken, providerToken: NativeProviderToken, reason?: string) {
    const exchange = this.exchanges.get(providerToken)
    if (exchange == null || exchange.ownerCallToken !== ownerCallToken) return
    return this.closeExchange(exchange, reason ?? 'resource_closed')
  }

  dispatch(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink,
    resourceSink: NativePortResourceEventSink
  ) {
    if (this.disposed) return reject(sink, request.id, 'disposed')
    if (
      request.module !== WEB_NETWORK_MODULE || !HTTP_OPERATIONS.has(request.operation) ||
      !hasNetworkCapability(context)
    ) return reject(sink, request.id, 'capability_unsupported')
    const expectedMode = request.operation === WEB_NETWORK_OPERATIONS.http.readBody ? 'stream' : 'result'
    if (context.mode !== expectedMode) return reject(sink, request.id, 'invalid_request')
    if (request.operation === WEB_NETWORK_OPERATIONS.http.request) {
      return this.openRequest(request, context, sink, resourceSink)
    }
    if (request.operation === WEB_NETWORK_OPERATIONS.http.releaseRules) {
      return this.releaseRuleSnapshot(request, context, sink)
    }
    const exchange = this.resolveExchange(request, context)
    if (exchange == null || !this.reauthorize(exchange, context)) {
      return reject(sink, request.id, 'resource_invalid')
    }
    if (request.operation === WEB_NETWORK_OPERATIONS.http.openBody) {
      if (exchange.phase !== 'accepted' || request.binary != null) return reject(sink, request.id, 'invalid_request')
      exchange.phase = 'uploading'
      sink({
        id: request.id,
        type: 'result',
        value: networkSuccess({ creditBytes: this.authority.limits.maxChunkBytes })
      })
      return
    }
    if (request.operation === WEB_NETWORK_OPERATIONS.http.writeBody) {
      return this.writeBody(exchange, request, sink)
    }
    if (request.operation === WEB_NETWORK_OPERATIONS.http.finishBody) {
      return this.finishBody(exchange, request, context, sink)
    }
    if (request.operation === WEB_NETWORK_OPERATIONS.http.readBody) {
      return this.readBody(exchange, request, context, sink)
    }
    if (request.operation === WEB_NETWORK_OPERATIONS.http.cancel) {
      return this.cancelExchange(exchange, request, context, sink)
    }
    if (request.operation === WEB_NETWORK_OPERATIONS.http.close) {
      return this.closeOperation(exchange, request, context, sink)
    }
    reject(sink, request.id, 'operation_unsupported')
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const exchange of [...this.exchanges.values()]) await this.closeExchange(exchange, 'mock_router_disposed')
    this.calls.clear()
    this.logicalRuleSnapshots.clear()
    await this.passthrough.dispose()
  }

  grantCredits(callToken: NativeCallToken, credits: number) {
    const downstream = this.calls.get(callToken)
    if (downstream != null) return this.passthrough.grantCredits(downstream, credits)
    if (!Number.isSafeInteger(credits) || credits <= 0) return
    for (const exchange of this.exchanges.values()) {
      const reader = exchange.reader
      if (reader?.callToken !== callToken || exchange.phase !== 'reading') continue
      for (let remaining = credits; remaining > 0; remaining -= 1) {
        const chunk = exchange.mockBody[reader.index]
        if (chunk == null) {
          reader.sink({ id: reader.id, type: 'end', value: networkSuccess({ closed: true }) })
          exchange.reader = undefined
          exchange.phase = 'response'
          return
        }
        reader.sink({
          binary: [{ data: chunk.slice(), handle: `network-mock:${reader.sequence}` }],
          id: reader.id,
          sequence: reader.sequence++,
          type: 'chunk',
          value: networkSuccess({ kind: 'body' })
        })
        reader.index += 1
      }
    }
  }

  private async cancelExchange(
    exchange: Exchange,
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink
  ) {
    if (exchange.downstream != null) {
      const { callToken, event } = await this.downstreamUnary(
        exchange,
        request,
        context,
        WEB_NETWORK_OPERATIONS.http.cancel
      )
      if (!await this.validateDownstreamUnary(callToken, event, false)) {
        return reject(sink, request.id, 'protocol_error')
      }
      this.forwardUnary(request.id, event, sink)
      return
    }
    this.closeReader(exchange, 'cancelled')
    sink({ id: request.id, type: 'result', value: networkSuccess({ cancelled: true }) })
  }

  private async closeExchange(exchange: Exchange, reason: string) {
    if (!this.exchanges.has(exchange.providerToken)) return
    exchange.phase = 'closed'
    this.closeReader(exchange, 'resource_invalid')
    this.exchanges.delete(exchange.providerToken)
    this.activeConnections -= 1
    const logical = this.logicalRuleSnapshots.get(exchange.ruleSnapshotId)
    if (logical?.activeProviderToken === exchange.providerToken) logical.activeProviderToken = undefined
    if (exchange.downstream != null) {
      await this.passthrough.closeResource(
        exchange.downstream.ownerCallToken,
        exchange.downstream.providerToken,
        reason
      )
    }
    for (const part of exchange.body) part.fill(0)
  }

  private async closeOperation(
    exchange: Exchange,
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink
  ) {
    if (exchange.downstream != null) {
      const { callToken, event } = await this.downstreamUnary(
        exchange,
        request,
        context,
        WEB_NETWORK_OPERATIONS.http.close
      )
      if (!await this.validateDownstreamUnary(callToken, event, false)) {
        reject(sink, request.id, 'protocol_error')
        await this.closeExchange(exchange, 'mock_close_protocol_error')
        return
      }
      this.forwardUnary(request.id, event, sink)
    } else sink({ id: request.id, type: 'result', value: networkSuccess({ closed: true }) })
    await this.closeExchange(exchange, 'mock_close')
  }

  private closeReader(exchange: Exchange, code: 'cancelled' | 'resource_invalid') {
    if (exchange.reader == null) return
    exchange.reader.sink({ error: { code }, id: exchange.reader.id, type: 'error' })
    this.calls.delete(exchange.reader.callToken)
    exchange.reader = undefined
  }

  private createContext(
    exchange: Exchange,
    source: Readonly<NativeDispatchContext>,
    callToken: NativeCallToken,
    mode: 'result' | 'stream'
  ): NativeDispatchContext {
    const downstream = exchange.downstream
    const resources: readonly NativePortResourceBinding[] = downstream == null
      ? []
      : [{
        ownerCallToken: downstream.ownerCallToken,
        providerToken: downstream.providerToken,
        reference: downstream.reference,
        type: 'network.http'
      }]
    return { authority: source.authority, callToken, mode, resources }
  }

  private async downstreamUnary(
    exchange: Exchange,
    outerRequest: NativePortRequest,
    outerContext: Readonly<NativeDispatchContext>,
    operation: string,
    binary?: NativePortRequest['binary']
  ) {
    const callToken = this.newCallToken()
    this.calls.set(outerContext.callToken, callToken)
    const reference = exchange.downstream?.reference
    const request: NativePortRequest = {
      args: operation === WEB_NETWORK_OPERATIONS.http.request
        ? {
          capabilityBindingId: exchange.capabilityBindingId,
          headers: exchange.headers,
          method: exchange.method,
          url: exchange.url
        }
        : { response: reference! },
      ...(binary == null ? {} : { binary }),
      id: `${outerRequest.id}:passthrough`,
      module: WEB_NETWORK_MODULE,
      operation
    }
    const event = await new Promise<NativePortEvent>(resolve => {
      let settled = false
      const settle = (event: NativePortEvent) => {
        if (settled || event.type === 'chunk') return
        settled = true
        this.calls.delete(outerContext.callToken)
        resolve(event)
      }
      try {
        const pending = this.passthrough.dispatch(
          request,
          this.createContext(exchange, outerContext, callToken, 'result'),
          settle,
          event => {
            if (exchange.downstream?.providerToken !== event.providerToken || exchange.phase === 'closed') return
            exchange.downstream = undefined
            exchange.resourceSink({ providerToken: exchange.providerToken, type: 'revoke' })
            void this.closeExchange(exchange, 'passthrough_revoked')
          }
        )
        if (pending != null) {
          void Promise.resolve(pending).catch(() =>
            settle({
              error: { code: 'internal' },
              id: request.id,
              type: 'error'
            })
          )
        }
      } catch {
        settle({ error: { code: 'internal' }, id: request.id, type: 'error' })
      }
    })
    return { callToken, event }
  }

  private async finishBody(
    exchange: Exchange,
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink
  ) {
    if (exchange.phase !== 'uploading' || request.binary != null) return reject(sink, request.id, 'invalid_request')
    const body = exchange.bodyBytes <= MAX_CONTIGUOUS_MATCH_BODY_BYTES
      ? copyBody(exchange.body)
      : new Uint8Array(0)
    let bodySha256: string | undefined
    if (
      this.options.bodySha256Chunks != null ||
      (this.options.bodySha256 != null && body.byteLength === exchange.bodyBytes)
    ) {
      try {
        const value = this.options.bodySha256Chunks == null
          ? this.options.bodySha256!(body)
          : this.options.bodySha256Chunks(exchange.body)
        if (/^[0-9a-f]{64}$/u.test(value)) bodySha256 = value
      } catch {
        // A digest seam failure makes sha256 rules non-matching, not authoritative.
      }
    }
    const match = this.rules.match(
      {
        body,
        bodyLength: exchange.bodyBytes,
        bodySha256,
        headers: exchange.headers,
        sensitiveHeaderSha256: this.options.bodySha256 == null
          ? undefined
          : exchange.headers.flatMap(([name, value]) => {
            if (!SENSITIVE_HEADERS.has(name)) return []
            try {
              const digest = this.options.bodySha256!(encodeUtf8(value))
              return /^[0-9a-f]{64}$/u.test(digest) ? [[name, digest] as const] : []
            } catch {
              return []
            }
          }),
        method: exchange.method,
        url: exchange.url
      },
      Date.now(),
      exchange.ruleSnapshot
    )
    if ('delayMs' in match.action && match.action.delayMs != null && match.action.delayMs > 0) {
      if (this.options.delay == null) {
        sink({ id: request.id, type: 'result', value: networkFailure('network.not_supported') })
        return
      }
      await this.options.delay(match.action.delayMs)
    }
    if (!this.exchanges.has(exchange.providerToken)) return
    if (match.action.type === 'fail') {
      const code = match.action.code === 'timeout'
        ? 'network.timeout'
        : match.action.code === 'connection_refused'
        ? 'network.connection_refused'
        : 'network.offline'
      sink({ id: request.id, type: 'result', value: networkFailure(code) })
      return
    }
    if (match.action.type === 'respond') {
      try {
        const headers = validateRawHeaderEntries(match.action.headers ?? [], this.authority.limits, false)
        exchange.mockBody = this.responseBody(match.action.body)
        const total = exchange.mockBody.reduce((sum, chunk) => sum + chunk.byteLength, 0)
        if (
          total > this.authority.limits.maxResponseBodyBytes ||
          exchange.mockBody.some(chunk => chunk.byteLength > this.authority.limits.maxChunkBytes)
        ) throw new RangeError('mock body limits')
        exchange.phase = 'response'
        sink({
          id: request.id,
          type: 'result',
          value: networkSuccess({
            hasBody: total > 0,
            headers: [...headers].map(([name, value]) => [name, value]),
            source: 'mock',
            status: match.action.status,
            statusText: '',
            url: exchange.url
          })
        })
      } catch {
        sink({ id: request.id, type: 'result', value: networkFailure('network.protocol_error') })
      }
      return
    }
    await this.finishPassthrough(exchange, request, context, sink)
  }

  private async finishPassthrough(
    exchange: Exchange,
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink
  ) {
    if (!context.authority.capabilities.includes('host.network.http')) {
      reject(sink, request.id, 'capability_unsupported')
      return
    }
    const openedResult = await this.downstreamUnary(exchange, request, context, WEB_NETWORK_OPERATIONS.http.request)
    const { callToken: ownerCallToken, event: opened } = openedResult
    if (!await this.validateDownstreamUnary(ownerCallToken, opened, true)) {
      reject(sink, request.id, 'protocol_error')
      return
    }
    if (opened.type !== 'result') {
      this.forwardUnary(request.id, opened, sink)
      return
    }
    const grant = opened.resources?.[0]
    if (grant == null) return reject(sink, request.id, 'protocol_error')
    exchange.downstream = {
      ownerCallToken,
      providerToken: grant.providerToken,
      reference: { resource: `resource:${this.nextResource++}` }
    }
    const openBodyResult = await this.downstreamUnary(exchange, request, context, WEB_NETWORK_OPERATIONS.http.openBody)
    if (!await this.validateDownstreamUnary(openBodyResult.callToken, openBodyResult.event, false)) {
      return reject(sink, request.id, 'protocol_error')
    }
    if (openBodyResult.event.type !== 'result') return this.forwardUnary(request.id, openBodyResult.event, sink)
    for (let index = 0; index < exchange.body.length; index += 1) {
      const part = exchange.body[index]!
      const writtenResult = await this.downstreamUnary(
        exchange,
        request,
        context,
        WEB_NETWORK_OPERATIONS.http.writeBody,
        [{ data: part.slice(), handle: `${request.id}:mock-upload:${index}` }]
      )
      if (!await this.validateDownstreamUnary(writtenResult.callToken, writtenResult.event, false)) {
        return reject(sink, request.id, 'protocol_error')
      }
      if (writtenResult.event.type !== 'result') return this.forwardUnary(request.id, writtenResult.event, sink)
    }
    const finishedResult = await this.downstreamUnary(
      exchange,
      request,
      context,
      WEB_NETWORK_OPERATIONS.http.finishBody
    )
    if (!await this.validateDownstreamUnary(finishedResult.callToken, finishedResult.event, false)) {
      return reject(sink, request.id, 'protocol_error')
    }
    exchange.phase = 'response'
    this.forwardUnary(request.id, finishedResult.event, sink, true)
  }

  private forwardUnary(id: string, event: NativePortEvent, sink: NativePortEventSink, stripResources = false) {
    if (event.type === 'error') sink({ ...event, id })
    else if (event.type === 'result') {
      sink({
        ...(event.binary == null ? {} : { binary: event.binary }),
        id,
        ...(stripResources || event.resources == null ? {} : { resources: event.resources }),
        type: 'result',
        ...(event.value === undefined ? {} : { value: event.value })
      })
    } else reject(sink, id, 'protocol_error')
  }

  private newCallToken() {
    return `network-mock-call:${this.nextCall++}` as NativeCallToken
  }

  private async validateDownstreamUnary(
    owner: NativeCallToken,
    event: NativePortEvent,
    expectResource: boolean
  ) {
    if (event.type === 'error') return true
    if (event.type !== 'result' || (event.binary?.length ?? 0) !== 0) return false
    const resources = event.resources ?? []
    const valid = expectResource
      ? resources.length === 1 && resources[0]?.type === 'network.http'
      : resources.length === 0
    if (valid) return true
    for (const grant of resources) {
      await this.passthrough.closeResource(owner, grant.providerToken, 'unexpected_network_resource')
    }
    return false
  }

  private openRequest(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink,
    resourceSink: NativePortResourceEventSink
  ) {
    const args = record(request.args)
    if (
      args == null ||
      !(
        hasExactKeys(args, ['headers', 'method', 'url']) ||
        hasExactKeys(args, ['capabilityBindingId', 'headers', 'method', 'url']) ||
        hasExactKeys(args, ['headers', 'method', 'ruleSnapshotId', 'url']) ||
        hasExactKeys(args, ['capabilityBindingId', 'headers', 'method', 'ruleSnapshotId', 'url'])
      ) ||
      request.binary != null ||
      context.resources.length !== 0 ||
      typeof args.url !== 'string' || typeof args.method !== 'string' ||
      args.capabilityBindingId != null && typeof args.capabilityBindingId !== 'string' ||
      args.ruleSnapshotId != null && typeof args.ruleSnapshotId !== 'string'
    ) return reject(sink, request.id, 'invalid_request')
    let method: string
    let headers: Array<[string, string]>
    let url: URL
    try {
      method = normalizeMethod(args.method)
      if (method !== args.method) throw new TypeError('method')
      const parsed = validateRawHeaderEntries(args.headers, this.authority.limits, true)
      headers = [...parsed].map(([name, value]) => [name, value])
      if (encodeUtf8(args.url).byteLength > (this.authority.limits.maxUrlBytes ?? 64 * 1024)) {
        throw new TypeError('url')
      }
      url = authorizeNetworkUrl(this.authority, args.url, 'http')
      if (url.toString() !== args.url || url.hash !== '') throw new TypeError('url')
    } catch {
      return reject(sink, request.id, 'invalid_request')
    }
    if (this.activeConnections >= this.authority.limits.maxConcurrentConnections) {
      return reject(sink, request.id, 'limit_exceeded')
    }
    const providerToken = `network-mock:${this.nextResource++}` as NativeProviderToken
    let ruleSnapshotId: string
    let ruleSnapshot: NetworkMockRuleSetSnapshot
    if (args.ruleSnapshotId == null) {
      if (this.logicalRuleSnapshots.size >= this.authority.limits.maxConcurrentConnections) {
        return reject(sink, request.id, 'limit_exceeded')
      }
      ruleSnapshotId = `network-rules:${this.nextRuleSnapshot++}`
      ruleSnapshot = this.rules.getSnapshot()
      this.logicalRuleSnapshots.set(ruleSnapshotId, {
        activeProviderToken: providerToken,
        principal: context.authority.principal,
        snapshot: ruleSnapshot
      })
    } else {
      ruleSnapshotId = args.ruleSnapshotId
      const logical = this.logicalRuleSnapshots.get(ruleSnapshotId)
      if (
        logical == null || logical.principal !== context.authority.principal ||
        logical.activeProviderToken != null
      ) return reject(sink, request.id, 'resource_invalid')
      logical.activeProviderToken = providerToken
      ruleSnapshot = logical.snapshot
    }
    const exchange: Exchange = {
      body: [],
      bodyBytes: 0,
      capabilityBindingId: args.capabilityBindingId as string | null,
      headers,
      method,
      mockBody: [],
      ownerCallToken: context.callToken,
      phase: 'accepted',
      principal: context.authority.principal,
      providerToken,
      resourceSink,
      ruleSnapshot,
      ruleSnapshotId,
      url: url.toString()
    }
    this.exchanges.set(providerToken, exchange)
    this.activeConnections += 1
    sink({
      id: request.id,
      resources: [{ providerToken, type: 'network.http' }],
      type: 'result',
      value: networkSuccess({ accepted: true, ruleSnapshotId })
    })
  }

  private releaseRuleSnapshot(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink
  ) {
    const args = record(request.args)
    if (
      args == null || !hasExactKeys(args, ['ruleSnapshotId']) || request.binary != null ||
      context.resources.length !== 0 ||
      typeof args.ruleSnapshotId !== 'string'
    ) return reject(sink, request.id, 'invalid_request')
    const logical = this.logicalRuleSnapshots.get(args.ruleSnapshotId)
    if (logical == null || logical.principal !== context.authority.principal) {
      return reject(sink, request.id, 'resource_invalid')
    }
    this.logicalRuleSnapshots.delete(args.ruleSnapshotId)
    sink({ id: request.id, type: 'result', value: networkSuccess({ released: true }) })
  }

  private readBody(
    exchange: Exchange,
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink
  ) {
    if (exchange.phase !== 'response' || request.binary != null || exchange.reader != null) {
      return reject(sink, request.id, 'invalid_request')
    }
    if (exchange.downstream == null) {
      exchange.phase = 'reading'
      exchange.reader = { callToken: context.callToken, id: request.id, index: 0, sequence: 0, sink }
      return
    }
    const downstreamCallToken = this.newCallToken()
    this.calls.set(context.callToken, downstreamCallToken)
    const downstreamRequest: NativePortRequest = {
      args: { response: exchange.downstream.reference },
      id: `${request.id}:passthrough`,
      module: WEB_NETWORK_MODULE,
      operation: WEB_NETWORK_OPERATIONS.http.readBody
    }
    const emit: NativePortEventSink = event => {
      if ('resources' in event && (event.resources?.length ?? 0) > 0) {
        for (const grant of event.resources ?? []) {
          void this.passthrough.closeResource(downstreamCallToken, grant.providerToken, 'unexpected_network_resource')
        }
        this.calls.delete(context.callToken)
        reject(sink, request.id, 'protocol_error')
        return
      }
      if (event.type === 'chunk') sink({ ...event, id: request.id })
      else if (event.type === 'end') {
        this.calls.delete(context.callToken)
        sink({ ...event, id: request.id })
      } else if (event.type === 'error') {
        this.calls.delete(context.callToken)
        sink({ ...event, id: request.id })
      } else {
        this.calls.delete(context.callToken)
        reject(sink, request.id, 'protocol_error')
      }
    }
    try {
      const pending = this.passthrough.dispatch(
        downstreamRequest,
        this.createContext(exchange, context, downstreamCallToken, 'stream'),
        emit,
        () => {}
      )
      if (pending != null) {
        void Promise.resolve(pending).catch(() =>
          emit({
            error: { code: 'internal' },
            id: downstreamRequest.id,
            type: 'error'
          })
        )
      }
    } catch {
      emit({ error: { code: 'internal' }, id: downstreamRequest.id, type: 'error' })
    }
  }

  private reauthorize(exchange: Exchange, context: Readonly<NativeDispatchContext>) {
    if (
      context.authority.principal !== exchange.principal ||
      !hasNetworkCapability(context)
    ) return false
    try {
      authorizeNetworkUrl(this.authority, exchange.url, 'http')
      return true
    } catch {
      return false
    }
  }

  private resolveExchange(request: NativePortRequest, context: Readonly<NativeDispatchContext>) {
    const args = record(request.args)
    if (args == null || Reflect.ownKeys(args).length !== 1 || context.resources.length !== 1) return undefined
    const binding = context.resources[0]
    if (binding == null || binding.reference !== args.response || binding.type !== 'network.http') return undefined
    return this.exchanges.get(binding.providerToken)
  }

  private responseBody(
    body: { chunks?: readonly string[]; kind: 'base64' | 'json' | 'utf8'; value?: unknown } | undefined
  ) {
    if (body == null) return []
    if (body.chunks != null) {
      return body.chunks.map(value => body.kind === 'base64' ? decodeBase64(value) : encodeUtf8(value))
    }
    if (body.kind === 'base64') return [decodeBase64(body.value as string)]
    if (body.kind === 'json') return [encodeUtf8(JSON.stringify(body.value))]
    return [encodeUtf8(body.value as string)]
  }

  private writeBody(exchange: Exchange, request: NativePortRequest, sink: NativePortEventSink) {
    const data = request.binary?.[0]?.data
    if (
      exchange.phase !== 'uploading' || request.binary?.length !== 1 || data == null ||
      data.byteLength > this.authority.limits.maxChunkBytes
    ) return reject(sink, request.id, 'limit_exceeded')
    exchange.bodyBytes += data.byteLength
    if (exchange.bodyBytes > this.authority.limits.maxRequestBodyBytes) {
      return reject(sink, request.id, 'limit_exceeded')
    }
    exchange.body.push(data.slice())
    sink({
      id: request.id,
      type: 'result',
      value: networkSuccess({ creditBytes: this.authority.limits.maxChunkBytes })
    })
  }
}

export const createNetworkMockRouter = (options: NetworkMockRouterOptions) => new NetworkMockRouter(options)
