/* eslint-disable max-lines -- deterministic HTTP script state is intentionally owned by one fake provider. */

import { authorizeNetworkUrl, authorizeResolvedAddress, resolveNetworkAuthority } from './authority.js'
import { WEB_NETWORK_MODULE, WEB_NETWORK_OPERATIONS, networkFailure, networkSuccess } from './contract.js'
import { normalizeMethod } from './request-validation.js'
import { encodeUtf8 } from './utf8.js'
import { validateRawHeaderEntries } from './web-headers.js'

import type {
  NativeCallToken,
  NativeDispatchContext,
  NativeJsonValue,
  NativePort,
  NativePortEventSink,
  NativePortRequest,
  NativePortResourceEventSink,
  NativeProviderToken
} from '@holonomyjs/runtime/native-port/types'
import type { WebNetworkErrorCode } from './errors.js'
import type { NetworkAuthority } from './types.js'

export interface ScriptedHttpResponse {
  body?: readonly (string | Uint8Array)[]
  error?: WebNetworkErrorCode
  extraResources?: readonly ScriptedResourceGrantPhase[]
  headers?: readonly NativeJsonValue[]
  status?: number
  statusText?: string
  url?: string
}

export type ScriptedResourceGrantPhase =
  | 'finish-body'
  | 'open-body'
  | 'read-chunk'
  | 'read-end'
  | 'request'
  | 'write-body'

export interface ScriptedHttpExchange {
  method?: string
  resolvedAddress: string
  response: ScriptedHttpResponse
  url: string
}

export interface ScriptedNetworkProviderOptions {
  authority: NetworkAuthority
  http: readonly ScriptedHttpExchange[]
}

type ResourcePhase = 'accepted' | 'cancelled' | 'closed' | 'reading' | 'response' | 'uploading'

interface ResourceState {
  body: Uint8Array[]
  exchange: ScriptedHttpExchange
  phase: ResourcePhase
  read?: ReadState
  received: Uint8Array[]
  requestBodyBytes: number
}

interface ReadState {
  id: string
  index: number
  sequence: number
  sink: NativePortEventSink
}

const HTTP_OPERATIONS = new Set<string>(Object.values(WEB_NETWORK_OPERATIONS.http))

const record = (value: unknown) => (
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
)

const readString = (value: unknown) => typeof value === 'string' ? value : undefined

const hasExactKeys = (value: Record<string, unknown> | undefined, keys: readonly string[]) => (
  value != null && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
)

const reject = (
  sink: NativePortEventSink,
  id: string,
  code: 'capability_unsupported' | 'invalid_request' | 'limit_exceeded' | 'operation_unsupported' | 'resource_invalid'
) => {
  sink({ error: { code }, id, type: 'error' })
}

export class ScriptedNetworkProvider implements NativePort {
  cancelCount = 0
  closedResourceCount = 0
  readonly grantedCredits: Array<{ callToken: NativeCallToken; credits: number }> = []
  readonly receivedBodies = new Map<string, Uint8Array[]>()
  readonly receivedRequests: Array<{ headers: string[][]; method: string; url: string }> = []
  readonly seenCallTokens: NativeCallToken[] = []
  private readonly authority: ReturnType<typeof resolveNetworkAuthority>
  private readonly calls = new Map<NativeCallToken, ResourceState>()
  private readonly resources = new Map<NativeProviderToken, ResourceState>()
  private activeConnections = 0
  private readonly extraResources = new Set<NativeProviderToken>()
  private nextResource = 1
  private readonly scripts: ScriptedHttpExchange[]
  private readonly used = new Set<ScriptedHttpExchange>()

  constructor(options: ScriptedNetworkProviderOptions) {
    this.authority = resolveNetworkAuthority(options.authority)
    this.scripts = [...options.http]
  }

  get activeConnectionCount() {
    return this.activeConnections
  }

  cancel(callToken: NativeCallToken) {
    this.cancelCount += 1
    const resource = this.calls.get(callToken)
    this.calls.delete(callToken)
    if (resource?.read != null) {
      resource.read = undefined
      if (resource.phase === 'reading') resource.phase = 'response'
    }
  }

  closeResource(
    _ownerCallToken: NativeCallToken,
    providerToken: NativeProviderToken
  ) {
    if (this.extraResources.delete(providerToken)) {
      this.closedResourceCount += 1
      return
    }
    const resource = this.resources.get(providerToken)
    if (resource == null) return
    this.closeState(resource, true)
  }

  dispatch(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink,
    _resourceSink: NativePortResourceEventSink
  ) {
    this.seenCallTokens.push(context.callToken)
    if (
      request.module !== WEB_NETWORK_MODULE ||
      !context.authority.capabilities.includes('host.network.http')
    ) {
      reject(sink, request.id, 'capability_unsupported')
      return
    }
    if (!HTTP_OPERATIONS.has(request.operation)) {
      reject(sink, request.id, 'operation_unsupported')
      return
    }
    const expectedMode = request.operation === WEB_NETWORK_OPERATIONS.http.readBody ? 'stream' : 'result'
    if (context.mode !== expectedMode) {
      reject(sink, request.id, 'invalid_request')
      return
    }
    if (request.operation === WEB_NETWORK_OPERATIONS.http.request) {
      this.openRequest(request, context, sink)
      return
    }
    const resource = this.resolveResource(request, context)
    if (resource == null || resource.phase === 'closed') {
      reject(sink, request.id, 'resource_invalid')
      return
    }
    try {
      const url = authorizeNetworkUrl(this.authority, resource.exchange.url, 'http')
      if (url.hash !== '') throw new TypeError('fragment')
      authorizeResolvedAddress(this.authority, resource.exchange.resolvedAddress)
    } catch {
      reject(sink, request.id, 'capability_unsupported')
      return
    }
    this.dispatchResourceOperation(request, context, resource, sink)
  }

  dispose() {
    for (const resource of this.resources.values()) this.closeState(resource, false)
    this.calls.clear()
  }

  grantCredits(callToken: NativeCallToken, credits: number) {
    this.grantedCredits.push({ callToken, credits })
    const resource = this.calls.get(callToken)
    if (
      resource?.read == null || resource.phase !== 'reading' ||
      !Number.isSafeInteger(credits) || credits <= 0
    ) return
    for (let remaining = credits; remaining > 0 && resource.phase === 'reading'; remaining -= 1) {
      const read = resource.read
      if (read == null) return
      const chunk = resource.body[read.index]
      if (chunk == null) {
        read.sink({
          id: read.id,
          resources: this.grantExtra(resource, 'read-end'),
          type: 'end',
          value: networkSuccess({ closed: true })
        })
        resource.read = undefined
        this.calls.delete(callToken)
        return
      }
      read.sink({
        binary: [{ data: chunk.slice(), handle: `network:body:${read.sequence}` }],
        id: read.id,
        resources: this.grantExtra(resource, 'read-chunk'),
        sequence: read.sequence,
        type: 'chunk',
        value: networkSuccess({ kind: 'body' })
      })
      read.index += 1
      read.sequence += 1
    }
  }

  private dispatchResourceOperation(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    resource: ResourceState,
    sink: NativePortEventSink
  ) {
    if (request.operation === WEB_NETWORK_OPERATIONS.http.openBody) {
      if (!this.validateResourceRequest(resource, request, 'accepted', false)) {
        return reject(sink, request.id, 'invalid_request')
      }
      resource.phase = 'uploading'
      sink({
        id: request.id,
        resources: this.grantExtra(resource, 'open-body'),
        type: 'result',
        value: networkSuccess({ creditBytes: this.authority.limits.maxChunkBytes })
      })
      return
    }
    if (request.operation === WEB_NETWORK_OPERATIONS.http.writeBody) {
      if (!this.validateResourceRequest(resource, request, 'uploading', true)) {
        return reject(sink, request.id, 'invalid_request')
      }
      this.writeBody(request, resource, sink)
      return
    }
    if (request.operation === WEB_NETWORK_OPERATIONS.http.finishBody) {
      if (!this.validateResourceRequest(resource, request, 'uploading', false)) {
        return reject(sink, request.id, 'invalid_request')
      }
      resource.phase = 'response'
      this.finish(request, resource, sink)
      return
    }
    if (request.operation === WEB_NETWORK_OPERATIONS.http.readBody) {
      if (!this.validateResourceRequest(resource, request, 'response', false)) {
        return reject(sink, request.id, 'invalid_request')
      }
      resource.phase = 'reading'
      resource.read = { id: request.id, index: 0, sequence: 0, sink }
      this.calls.set(context.callToken, resource)
      return
    }
    if (request.operation === WEB_NETWORK_OPERATIONS.http.cancel) {
      if (!this.validateResourceRequest(resource, request, undefined, false)) {
        return reject(sink, request.id, 'invalid_request')
      }
      this.terminateRead(resource, 'cancelled')
      resource.phase = 'cancelled'
      sink({ id: request.id, type: 'result', value: networkSuccess({ cancelled: true }) })
      return
    }
    if (request.operation === WEB_NETWORK_OPERATIONS.http.close) {
      if (!this.validateResourceRequest(resource, request, undefined, false)) {
        return reject(sink, request.id, 'invalid_request')
      }
      this.closeState(resource, true)
      sink({ id: request.id, type: 'result', value: networkSuccess({ closed: true }) })
    }
  }

  private openRequest(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>,
    sink: NativePortEventSink
  ) {
    const args = record(request.args)
    const urlValue = readString(args?.url)
    const methodValue = readString(args?.method)
    if (
      !hasExactKeys(args, ['headers', 'method', 'url']) &&
        !hasExactKeys(args, ['capabilityBindingId', 'headers', 'method', 'url']) ||
      urlValue == null || methodValue == null || request.binary != null ||
      context.resources.length !== 0 ||
      args?.capabilityBindingId != null && typeof args.capabilityBindingId !== 'string'
    ) {
      reject(sink, request.id, 'invalid_request')
      return
    }
    try {
      const method = normalizeMethod(methodValue)
      if (method !== methodValue) throw new TypeError('method normalization')
      const headers = validateRawHeaderEntries(args?.headers, this.authority.limits, true)
      const url = authorizeNetworkUrl(this.authority, urlValue, 'http')
      if (url.hash !== '' || url.toString() !== urlValue) throw new TypeError('non-canonical URL')
      const requestBytes = headers.getInputMetrics().bytes + encodeUtf8(method).byteLength +
        encodeUtf8(urlValue).byteLength
      if (requestBytes > this.authority.limits.maxHeaderBytes + this.authority.limits.maxRequestBodyBytes) {
        throw new RangeError('request aggregate')
      }
    } catch (error) {
      reject(sink, request.id, error instanceof RangeError ? 'limit_exceeded' : 'invalid_request')
      return
    }
    if (this.activeConnections >= this.authority.limits.maxConcurrentConnections) {
      reject(sink, request.id, 'limit_exceeded')
      return
    }
    const exchange = this.scripts.find(item => (
      !this.used.has(item) && item.url === urlValue && (item.method ?? 'GET') === methodValue
    ))
    if (exchange == null) {
      sink({
        error: { code: 'unavailable', domain: 'network', details: { resource: 'host' } },
        id: request.id,
        type: 'error'
      })
      return
    }
    try {
      authorizeResolvedAddress(this.authority, exchange.resolvedAddress)
    } catch {
      reject(sink, request.id, 'capability_unsupported')
      return
    }
    this.used.add(exchange)
    this.receivedRequests.push({
      headers: (args?.headers as string[][]).map(entry => [entry[0]!, entry[1]!]),
      method: methodValue,
      url: urlValue
    })
    const providerToken = `scripted-network:${this.nextResource++}` as NativeProviderToken
    const resource: ResourceState = {
      body: (exchange.response.body ?? []).map(value => typeof value === 'string' ? encodeUtf8(value) : value.slice()),
      exchange,
      phase: 'accepted',
      received: [],
      requestBodyBytes: 0
    }
    this.resources.set(providerToken, resource)
    this.activeConnections += 1
    const extras = this.grantExtra(resource, 'request')
    sink({
      id: request.id,
      resources: [{ providerToken, type: 'network.http' }, ...extras],
      type: 'result',
      value: networkSuccess({ accepted: true })
    })
  }

  private resolveResource(
    request: NativePortRequest,
    context: Readonly<NativeDispatchContext>
  ) {
    const args = record(request.args)
    if (!hasExactKeys(args, ['response']) || context.resources.length !== 1) return undefined
    const binding = context.resources[0]
    if (binding == null || binding.reference !== args?.response || binding.type !== 'network.http') return undefined
    return this.resources.get(binding.providerToken)
  }

  private validateResourceRequest(
    resource: ResourceState,
    request: NativePortRequest,
    phase: ResourcePhase | undefined,
    binary: boolean
  ) {
    return resource.phase !== 'closed' &&
      (phase == null || resource.phase === phase) &&
      (binary ? request.binary?.length === 1 : request.binary == null)
  }

  private writeBody(request: NativePortRequest, resource: ResourceState, sink: NativePortEventSink) {
    const data = request.binary?.[0]?.data
    if (data == null || data.byteLength > this.authority.limits.maxChunkBytes) {
      reject(sink, request.id, 'limit_exceeded')
      return
    }
    resource.requestBodyBytes += data.byteLength
    if (resource.requestBodyBytes > this.authority.limits.maxRequestBodyBytes) {
      reject(sink, request.id, 'limit_exceeded')
      return
    }
    resource.received.push(data.slice())
    sink({
      id: request.id,
      resources: this.grantExtra(resource, 'write-body'),
      type: 'result',
      value: networkSuccess({ creditBytes: this.authority.limits.maxChunkBytes })
    })
  }

  private finish(request: NativePortRequest, resource: ResourceState, sink: NativePortEventSink) {
    this.receivedBodies.set(resource.exchange.url, resource.received.map(value => value.slice()))
    const response = resource.exchange.response
    const limitError = this.validateResponseLimits(resource)
    if (limitError != null) {
      sink({ id: request.id, type: 'result', value: networkFailure(limitError) })
      return
    }
    if (response.error != null) {
      sink({ id: request.id, type: 'result', value: networkFailure(response.error) })
      return
    }
    sink({
      id: request.id,
      resources: this.grantExtra(resource, 'finish-body'),
      type: 'result',
      value: networkSuccess({
        hasBody: (response.body?.length ?? 0) > 0,
        headers: response.headers == null ? [] : [...response.headers],
        status: response.status ?? 200,
        statusText: response.statusText ?? '',
        url: response.url ?? resource.exchange.url
      })
    })
  }

  private closeState(resource: ResourceState, notifyReader: boolean) {
    if (resource.phase === 'closed') return
    resource.phase = 'closed'
    this.closedResourceCount += 1
    this.activeConnections -= 1
    if (notifyReader) this.terminateRead(resource, 'resource_invalid')
    else resource.read = undefined
    for (const [callToken, value] of this.calls) {
      if (value === resource) this.calls.delete(callToken)
    }
  }

  private terminateRead(resource: ResourceState, code: 'cancelled' | 'resource_invalid') {
    if (resource.read == null) return
    resource.read.sink({ error: { code }, id: resource.read.id, type: 'error' })
    resource.read = undefined
    for (const [callToken, value] of this.calls) {
      if (value === resource) this.calls.delete(callToken)
    }
  }

  private grantExtra(resource: ResourceState, phase: ScriptedResourceGrantPhase) {
    if (!resource.exchange.response.extraResources?.includes(phase)) return []
    const providerToken = `scripted-network-extra:${this.nextResource++}` as NativeProviderToken
    this.extraResources.add(providerToken)
    return [{ providerToken, type: 'network.http' }]
  }

  private validateResponseLimits(resource: ResourceState): WebNetworkErrorCode | undefined {
    let total = 0
    for (const chunk of resource.body) {
      if (chunk.byteLength > this.authority.limits.maxChunkBytes) return 'network.response_too_large'
      total += chunk.byteLength
      if (total > this.authority.limits.maxResponseBodyBytes) return 'network.response_too_large'
    }
    return undefined
  }
}
