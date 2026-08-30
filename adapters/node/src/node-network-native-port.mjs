/* eslint-disable max-lines -- HTTP upload, response credits and opaque-resource cleanup share one provider owner. */

import {
  DEFAULT_NETWORK_CHUNK_BYTES,
  MAX_NETWORK_CHUNK_BYTES,
  NODE_NETWORK_MODULE,
  NODE_NETWORK_OPERATIONS,
  consumeNetworkBody,
  hasExactKeys,
  networkSuccess,
  rejectNetworkCall,
  sendNetworkResponse,
  sendNetworkResult,
  splitNetworkBody
} from './node-network-protocol.mjs'

export class NodeNetworkNativePort {
  #calls = new Map()
  #disposed = false
  #exchanges = new Map()
  #host
  #maxChunkBytes
  #nextResource = 1

  constructor(host, { maxChunkBytes = DEFAULT_NETWORK_CHUNK_BYTES } = {}) {
    if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1 || maxChunkBytes > MAX_NETWORK_CHUNK_BYTES) {
      throw new TypeError('Invalid Node network chunk limit')
    }
    this.#host = host
    this.#maxChunkBytes = maxChunkBytes
  }

  cancel(callToken) {
    const exchange = this.#calls.get(callToken)
    this.#calls.delete(callToken)
    exchange?.abort?.abort()
    if (exchange?.reader?.callToken === callToken) exchange.reader = undefined
  }

  closeResource(ownerCallToken, providerToken) {
    const exchange = this.#exchanges.get(providerToken)
    if (exchange?.ownerCallToken === ownerCallToken) this.#close(exchange)
  }

  dispatch(request, context, sink, resourceSink) {
    if (this.#disposed) return rejectNetworkCall(sink, request.id, 'disposed')
    if (request.module !== NODE_NETWORK_MODULE || !context.authority?.capabilities?.includes('host.network.http')) {
      return rejectNetworkCall(sink, request.id, 'capability_unsupported')
    }
    if (!Object.values(NODE_NETWORK_OPERATIONS).includes(request.operation)) {
      return rejectNetworkCall(sink, request.id, 'operation_unsupported')
    }
    if (context.mode !== (request.operation === NODE_NETWORK_OPERATIONS.read ? 'stream' : 'result')) {
      return rejectNetworkCall(sink, request.id, 'invalid_request')
    }
    if (request.operation === NODE_NETWORK_OPERATIONS.request) {
      return this.#openRequest(request, context, sink, resourceSink)
    }
    const exchange = this.#resolve(request, context)
    if (exchange == null) return rejectNetworkCall(sink, request.id, 'resource_invalid')
    if (request.operation === NODE_NETWORK_OPERATIONS.open) return this.#openBody(exchange, request, sink)
    if (request.operation === NODE_NETWORK_OPERATIONS.write) return this.#writeBody(exchange, request, sink)
    if (request.operation === NODE_NETWORK_OPERATIONS.finish) return this.#finish(exchange, request, context, sink)
    if (request.operation === NODE_NETWORK_OPERATIONS.read) return this.#read(exchange, request, context, sink)
    if (request.operation === NODE_NETWORK_OPERATIONS.cancel) {
      if (request.binary != null) return rejectNetworkCall(sink, request.id, 'invalid_request')
      exchange.abort?.abort()
      sendNetworkResult(sink, request.id, { cancelled: true })
      return
    }
    if (request.binary != null) return rejectNetworkCall(sink, request.id, 'invalid_request')
    this.#close(exchange)
    sendNetworkResult(sink, request.id, { closed: true })
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    for (const exchange of [...this.#exchanges.values()]) this.#close(exchange, true)
    this.#calls.clear()
  }

  grantCredits(callToken, credits) {
    const exchange = this.#calls.get(callToken)
    const reader = exchange?.reader
    if (reader == null || !Number.isSafeInteger(credits) || credits <= 0) return
    for (let remaining = credits; remaining > 0; remaining -= 1) {
      const chunk = exchange.chunks[reader.index]
      if (chunk == null) {
        reader.sink({ id: reader.id, type: 'end', value: networkSuccess({ closed: true }) })
        exchange.reader = undefined
        this.#calls.delete(callToken)
        return
      }
      reader.sink({
        binary: [{ data: chunk.slice(), handle: `node-network:${reader.sequence}` }],
        id: reader.id,
        sequence: reader.sequence++,
        type: 'chunk',
        value: networkSuccess({ kind: 'body' })
      })
      reader.index += 1
    }
  }

  #openRequest(request, context, sink, resourceSink) {
    const requestKeys = ['headers', 'method', 'url']
    const capabilityRequestKeys = ['capabilityBindingId', ...requestKeys]
    if (
      !hasExactKeys(request.args, requestKeys) && !hasExactKeys(request.args, capabilityRequestKeys) ||
      request.binary != null ||
      context.resources.length !== 0 || !Array.isArray(request.args.headers) ||
      typeof request.args.method !== 'string' || typeof request.args.url !== 'string' ||
      request.args.capabilityBindingId != null && typeof request.args.capabilityBindingId !== 'string'
    ) return rejectNetworkCall(sink, request.id, 'invalid_request')
    const providerToken = `node-network:${this.#nextResource++}`
    const exchange = {
      body: [],
      capabilityBindingId: request.args.capabilityBindingId,
      headers: request.args.headers,
      method: request.args.method,
      ownerCallToken: context.callToken,
      phase: 'accepted',
      principal: context.authority.principal,
      providerToken,
      resourceSink,
      url: request.args.url
    }
    this.#exchanges.set(providerToken, exchange)
    sendNetworkResult(sink, request.id, { accepted: true }, [{ providerToken, type: 'network.http' }])
  }

  #resolve(request, context) {
    if (!hasExactKeys(request.args, ['response']) || context.resources.length !== 1) return undefined
    const binding = context.resources[0]
    const exchange = this.#exchanges.get(binding?.providerToken)
    return exchange != null && binding.reference === request.args.response && binding.type === 'network.http' &&
        binding.ownerCallToken === exchange.ownerCallToken && context.authority.principal === exchange.principal
      ? exchange
      : undefined
  }

  #openBody(exchange, request, sink) {
    if (exchange.phase !== 'accepted' || request.binary != null) {
      return rejectNetworkCall(sink, request.id, 'invalid_request')
    }
    exchange.phase = 'uploading'
    sendNetworkResult(sink, request.id, { creditBytes: this.#maxChunkBytes })
  }

  #writeBody(exchange, request, sink) {
    const bytes = request.binary?.[0]?.data
    if (
      exchange.phase !== 'uploading' || request.binary?.length !== 1 ||
      bytes.byteLength > this.#maxChunkBytes
    ) {
      return rejectNetworkCall(sink, request.id, 'invalid_request')
    }
    exchange.body.push(Uint8Array.from(bytes))
    sendNetworkResult(sink, request.id, { creditBytes: this.#maxChunkBytes })
  }

  async #finish(exchange, request, context, sink) {
    if (exchange.phase !== 'uploading' || request.binary != null) {
      return rejectNetworkCall(sink, request.id, 'invalid_request')
    }
    exchange.phase = 'pending'
    exchange.abort = new AbortController()
    this.#calls.set(context.callToken, exchange)
    let body
    try {
      body = consumeNetworkBody(exchange.body)
      exchange.body = []
      const response = await this.#host.request({
        body,
        capabilityBindingId: exchange.capabilityBindingId,
        headers: exchange.headers,
        method: exchange.method,
        signal: exchange.abort.signal,
        url: exchange.url
      })
      if (!this.#exchanges.has(exchange.providerToken) || exchange.phase === 'closed') {
        response.body.fill(0)
        return rejectNetworkCall(sink, request.id, 'resource_invalid')
      }
      exchange.chunks = splitNetworkBody(response.body, this.#maxChunkBytes)
      exchange.phase = 'response'
      sendNetworkResponse(sink, request.id, response, exchange.chunks.length > 0)
    } catch (error) {
      const code = error?.code === 'aborted' ? 'cancelled' : error?.code === 'timeout' ? 'timeout' : 'unavailable'
      rejectNetworkCall(
        sink,
        request.id,
        code,
        code === 'timeout' || code === 'unavailable' ? 'network' : undefined
      )
    } finally {
      body?.fill(0)
      this.#calls.delete(context.callToken)
    }
  }

  #read(exchange, request, context, sink) {
    if (exchange.phase !== 'response' || exchange.reader != null || request.binary != null) {
      return rejectNetworkCall(sink, request.id, 'invalid_request')
    }
    exchange.reader = { callToken: context.callToken, id: request.id, index: 0, sequence: 0, sink }
    this.#calls.set(context.callToken, exchange)
  }

  #close(exchange, revoke = false) {
    if (!this.#exchanges.delete(exchange.providerToken)) return
    exchange.phase = 'closed'
    exchange.abort?.abort()
    for (const item of exchange.body ?? []) item.fill(0)
    for (const item of exchange.chunks ?? []) item.fill(0)
    if (exchange.reader != null) rejectNetworkCall(exchange.reader.sink, exchange.reader.id, 'resource_invalid')
    for (const [callToken, value] of this.#calls) if (value === exchange) this.#calls.delete(callToken)
    if (revoke) exchange.resourceSink({ providerToken: exchange.providerToken, type: 'revoke' })
  }
}
