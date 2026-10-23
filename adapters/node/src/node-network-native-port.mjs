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
  sendNetworkFailure,
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
    if (exchange?.finishCallToken === callToken && exchange.phase === 'pending') {
      exchange.phase = 'terminal'
    }
    if (exchange?.reader?.callToken === callToken) {
      exchange.reader = undefined
      exchange.phase = 'terminal'
      this.#returnUpstream(exchange)
    }
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
      exchange.phase = 'terminal'
      this.#returnUpstream(exchange)
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
    if (exchange.upstream != null) {
      reader.credits += credits
      void this.#pumpUpstream(exchange, reader)
      return
    }
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
    exchange.finishCallToken = context.callToken
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
      if (!this.#isCurrentFinish(exchange, context.callToken)) {
        this.#discardResponseBody(response?.body)
        return
      }
      const responseBody = this.#selectResponseBody(response)
      exchange.chunks = responseBody.chunks
      exchange.upstream = responseBody.upstream
      exchange.phase = 'response'
      sendNetworkResponse(sink, request.id, response, responseBody.hasBody)
    } catch (error) {
      if (!this.#isCurrentFinish(exchange, context.callToken)) return
      const hostCode = error?.code
      if (hostCode === 'response_too_large') {
        sendNetworkFailure(sink, request.id, 'network.response_too_large')
        return
      }
      const code = hostCode === 'aborted'
        ? 'cancelled'
        : hostCode === 'timeout'
        ? 'timeout'
        : hostCode === 'connection_refused'
        ? 'connection_refused'
        : hostCode === 'protocol_error'
        ? 'protocol_error'
        : 'unavailable'
      rejectNetworkCall(
        sink,
        request.id,
        code,
        code === 'timeout' || code === 'connection_refused' || code === 'unavailable' ? 'network' : undefined
      )
    } finally {
      body?.fill(0)
      if (this.#calls.get(context.callToken) === exchange) this.#calls.delete(context.callToken)
    }
  }

  #read(exchange, request, context, sink) {
    if (exchange.phase !== 'response' || exchange.reader != null || request.binary != null) {
      return rejectNetworkCall(sink, request.id, 'invalid_request')
    }
    exchange.reader = { callToken: context.callToken, credits: 0, id: request.id, index: 0, sequence: 0, sink }
    this.#calls.set(context.callToken, exchange)
  }

  #close(exchange, revoke = false) {
    if (!this.#exchanges.delete(exchange.providerToken)) return
    exchange.phase = 'closed'
    exchange.abort?.abort()
    this.#returnUpstream(exchange)
    for (const item of exchange.body ?? []) item.fill(0)
    for (const item of exchange.chunks ?? []) item.fill(0)
    if (exchange.reader != null) rejectNetworkCall(exchange.reader.sink, exchange.reader.id, 'resource_invalid')
    for (const [callToken, value] of this.#calls) if (value === exchange) this.#calls.delete(callToken)
    if (revoke) exchange.resourceSink({ providerToken: exchange.providerToken, type: 'revoke' })
  }

  #selectResponseBody(response) {
    const body = response?.body
    if (body instanceof Uint8Array) {
      const chunks = splitNetworkBody(body, this.#maxChunkBytes)
      return { chunks, hasBody: response.hasBody ?? chunks.length > 0, upstream: undefined }
    }
    const iterator = this.#responseIterator(body)
    if (iterator != null) {
      if (response.hasBody === false) {
        void this.#returnIterator(iterator)
        return { chunks: [], hasBody: false, upstream: undefined }
      }
      return { chunks: [], hasBody: true, upstream: { closed: false, iterator } }
    }
    if (body == null && response?.hasBody === false) {
      return { chunks: [], hasBody: false, upstream: undefined }
    }
    throw Object.assign(new Error('Invalid Host response body'), { code: 'protocol_error' })
  }

  #responseIterator(body) {
    if (body == null || typeof body !== 'object') return undefined
    if (typeof body[Symbol.asyncIterator] === 'function') {
      const iterator = body[Symbol.asyncIterator]()
      return iterator != null && typeof iterator.next === 'function' ? iterator : undefined
    }
    if (typeof body.getReader === 'function') {
      const reader = body.getReader()
      if (reader == null || typeof reader.read !== 'function') return undefined
      let released = false
      const release = () => {
        if (released) return
        released = true
        reader.releaseLock?.()
      }
      return {
        next: async () => {
          const result = await reader.read()
          if (result?.done === true) release()
          return result
        },
        return: async reason => {
          try {
            if (typeof reader.cancel === 'function') await reader.cancel(reason)
            return { done: true, value: undefined }
          } finally {
            release()
          }
        }
      }
    }
    if (typeof body.next === 'function') return body
    return undefined
  }

  async #pumpUpstream(exchange, reader) {
    if (reader.pumping) return
    reader.pumping = true
    try {
      while (
        reader.credits > 0 && exchange.reader === reader && exchange.phase === 'response' &&
        exchange.upstream != null && !exchange.upstream.closed
      ) {
        reader.credits -= 1
        let result
        try {
          result = await exchange.upstream.iterator.next()
        } catch (error) {
          if (exchange.reader !== reader || exchange.phase !== 'response') return
          this.#finishUpstreamReader(exchange, reader, error)
          return
        }
        if (exchange.reader !== reader || exchange.phase !== 'response') {
          this.#returnUpstream(exchange)
          return
        }
        if (result == null || typeof result !== 'object' || typeof result.done !== 'boolean') {
          this.#finishUpstreamReader(exchange, reader, { code: 'protocol_error' })
          return
        }
        if (result.done) {
          exchange.upstream.closed = true
          exchange.phase = 'terminal'
          reader.sink({ id: reader.id, type: 'end', value: networkSuccess({ closed: true }) })
          exchange.reader = undefined
          this.#calls.delete(reader.callToken)
          return
        }
        if (
          !(result.value instanceof Uint8Array) || result.value.byteLength === 0 ||
          result.value.byteLength > this.#maxChunkBytes
        ) {
          this.#finishUpstreamReader(exchange, reader, { code: 'protocol_error' })
          return
        }
        const chunk = result.value.slice()
        reader.sink({
          binary: [{ data: chunk, handle: `node-network:${reader.sequence}` }],
          id: reader.id,
          sequence: reader.sequence++,
          type: 'chunk',
          value: networkSuccess({ kind: 'body' })
        })
      }
    } finally {
      reader.pumping = false
      if (reader.credits > 0 && exchange.reader === reader && exchange.phase === 'response') {
        void this.#pumpUpstream(exchange, reader)
      }
    }
  }

  #finishUpstreamReader(exchange, reader, error) {
    const hostCode = error?.code
    exchange.phase = 'terminal'
    exchange.reader = undefined
    this.#calls.delete(reader.callToken)
    this.#returnUpstream(exchange)
    if (hostCode === 'response_too_large') {
      reader.sink({ id: reader.id, type: 'end', value: { error: 'network.response_too_large', ok: false } })
      return
    }
    const code = hostCode === 'aborted'
      ? 'cancelled'
      : hostCode === 'timeout'
      ? 'timeout'
      : hostCode === 'connection_refused'
      ? 'connection_refused'
      : hostCode === 'protocol_error'
      ? 'protocol_error'
      : 'unavailable'
    rejectNetworkCall(
      reader.sink,
      reader.id,
      code,
      code === 'timeout' || code === 'connection_refused' || code === 'unavailable' ? 'network' : undefined
    )
  }

  #returnUpstream(exchange) {
    const upstream = exchange?.upstream
    if (upstream == null || upstream.closed) return
    upstream.closed = true
    void this.#returnIterator(upstream.iterator)
  }

  async #returnIterator(iterator) {
    try {
      await iterator.return?.()
    } catch {
      // A late Host cleanup failure cannot produce a second NativePort terminal.
    }
  }

  #discardResponseBody(body) {
    if (body instanceof Uint8Array) {
      body.fill(0)
      return
    }
    const iterator = this.#responseIterator(body)
    if (iterator != null) void this.#returnIterator(iterator)
  }

  #isCurrentFinish(exchange, callToken) {
    return this.#exchanges.has(exchange.providerToken) && exchange.phase === 'pending' &&
      exchange.finishCallToken === callToken && this.#calls.get(callToken) === exchange &&
      !exchange.abort.signal.aborted
  }
}
