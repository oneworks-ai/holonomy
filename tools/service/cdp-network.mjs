import { cdpHeaders, cdpResponse, ipAddressSpace } from './cdp-network-fields.mjs'

const seconds = milliseconds => milliseconds / 1_000

const networkErrorText = code =>
  ({
    'network.cancelled': 'net::ERR_ABORTED',
    'network.connection_refused': 'net::ERR_CONNECTION_REFUSED',
    'network.protocol_error': 'net::ERR_INVALID_RESPONSE',
    'network.timeout': 'net::ERR_TIMED_OUT',
    'network.unavailable': 'net::ERR_FAILED'
  })[code] ?? 'net::ERR_FAILED'

export class CdpNetworkProjector {
  #entries = new Map()
  #maxPerProcess
  #maxTotal
  #now
  #ttlMs

  constructor(options = {}) {
    this.#maxPerProcess = options.maxActiveRequestsPerProcess ?? 4_096
    this.#maxTotal = options.maxActiveRequests ?? 16_384
    this.#now = options.now ?? Date.now
    this.#ttlMs = options.requestTtlMs ?? 5 * 60_000
  }

  project(processKey, event, context = {}) {
    this.#prune()
    const loaderId = context.loaderId ?? 'holonomy-loader'
    if (event.type === 'requestWillBeSent') return this.#request(processKey, loaderId, event)
    if (event.type === 'responseReceived') return this.#response(processKey, loaderId, event)
    const message = this.#terminalOrData(event)
    if (event.type === 'loadingFinished' || event.type === 'loadingFailed') {
      this.#entries.delete(this.#key(processKey, event.requestId))
    }
    return [message]
  }

  clear(processKey) {
    for (const [key, entry] of this.#entries) {
      if (entry.processKey === processKey) this.#entries.delete(key)
    }
  }

  snapshot() {
    this.#prune()
    return { requests: this.#entries.size }
  }

  #request(processKey, loaderId, event) {
    const wallTimeMs = this.#now()
    const state = {
      processKey,
      requestHeaders: event.headers,
      requestTimestampMs: event.timestampMs,
      updatedAt: wallTimeMs,
      wallTimeMs
    }
    this.#admit(processKey, event.requestId, state)
    const redirectResponse = event.redirectResponse == null
      ? undefined
      : cdpResponse(event.redirectResponse, state, wallTimeMs)
    return [{
      method: 'Network.requestWillBeSent',
      params: {
        documentURL: event.url,
        hasUserGesture: false,
        initiator: { type: 'script' },
        loaderId,
        redirectHasExtraInfo: redirectResponse != null,
        ...(redirectResponse == null ? {} : { redirectResponse }),
        request: {
          hasPostData: event.hasPostData === true,
          headers: cdpHeaders(event.headers),
          initialPriority: 'Medium',
          method: event.method,
          mixedContentType: 'none',
          referrerPolicy: 'no-referrer',
          url: event.url
        },
        requestId: event.requestId,
        timestamp: seconds(event.timestampMs),
        type: 'Fetch',
        wallTime: wallTimeMs / 1_000
      }
    }, {
      method: 'Network.requestWillBeSentExtraInfo',
      params: {
        associatedCookies: [],
        connectTiming: { requestTime: seconds(event.timestampMs) },
        headers: cdpHeaders(event.headers),
        requestId: event.requestId,
        siteHasCookieInOtherPartition: false
      }
    }]
  }

  #response(processKey, loaderId, event) {
    const key = this.#key(processKey, event.requestId)
    const wallTimeMs = this.#now()
    const state = this.#entries.get(key) ?? {
      processKey,
      requestHeaders: [],
      requestTimestampMs: event.timestampMs,
      updatedAt: wallTimeMs,
      wallTimeMs
    }
    state.updatedAt = wallTimeMs
    this.#entries.set(key, state)
    return [{
      method: 'Network.responseReceived',
      params: {
        hasExtraInfo: true,
        loaderId,
        requestId: event.requestId,
        response: cdpResponse(event, state, wallTimeMs),
        timestamp: seconds(event.timestampMs),
        type: 'Fetch'
      }
    }, {
      method: 'Network.responseReceivedExtraInfo',
      params: {
        blockedCookies: [],
        headers: cdpHeaders(event.headers),
        requestId: event.requestId,
        resourceIPAddressSpace: ipAddressSpace(event),
        statusCode: event.status
      }
    }]
  }

  #terminalOrData(event) {
    if (event.type === 'dataReceived') {
      return {
        method: 'Network.dataReceived',
        params: {
          dataLength: event.dataLength,
          encodedDataLength: event.dataLength,
          requestId: event.requestId,
          timestamp: seconds(event.timestampMs)
        }
      }
    }
    if (event.type === 'loadingFinished') {
      return {
        method: 'Network.loadingFinished',
        params: {
          encodedDataLength: event.totalBytes,
          requestId: event.requestId,
          timestamp: seconds(event.timestampMs)
        }
      }
    }
    if (event.type !== 'loadingFailed') throw new TypeError('Unsupported Network diagnostic')
    return {
      method: 'Network.loadingFailed',
      params: {
        canceled: event.cancelled,
        errorText: networkErrorText(event.code),
        requestId: event.requestId,
        timestamp: seconds(event.timestampMs),
        type: 'Fetch'
      }
    }
  }

  #admit(processKey, requestId, state) {
    const key = this.#key(processKey, requestId)
    if (!this.#entries.has(key)) {
      const processEntries = [...this.#entries.entries()]
        .filter(([, entry]) => entry.processKey === processKey)
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
      if (processEntries.length >= this.#maxPerProcess) this.#entries.delete(processEntries[0][0])
      if (this.#entries.size >= this.#maxTotal) {
        const oldest = [...this.#entries.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0]
        if (oldest != null) this.#entries.delete(oldest[0])
      }
    }
    this.#entries.set(key, state)
  }

  #key(processKey, requestId) {
    return `${processKey}\u0000${requestId}`
  }

  #prune() {
    const cutoff = this.#now() - this.#ttlMs
    for (const [key, entry] of this.#entries) {
      if (entry.updatedAt <= cutoff) this.#entries.delete(key)
    }
  }
}
