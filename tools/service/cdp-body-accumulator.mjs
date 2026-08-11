import { Buffer } from 'node:buffer'

const decodeBase64 = value => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return undefined
  return Buffer.from(value, 'base64')
}

export class CdpBodyAccumulator {
  #bodyCache
  #maxPendingPerProcess
  #maxPendingTotal
  #maxProcessBytes
  #maxResponseBytes
  #maxTotalBytes
  #now
  #pending = new Map()
  #processBytes = new Map()
  #totalBytes = 0
  #ttlMs

  constructor(bodyCache, options = {}) {
    this.#bodyCache = bodyCache
    this.#maxPendingPerProcess = options.maxActiveRequestsPerProcess ?? 4_096
    this.#maxPendingTotal = options.maxActiveRequests ?? 16_384
    this.#maxProcessBytes = options.maxProcessBodyBytes ?? 16 * 1024 * 1024
    this.#maxResponseBytes = options.maxResponseBodyBytes ?? 2 * 1024 * 1024
    this.#maxTotalBytes = options.maxServiceBodyBytes ?? 64 * 1024 * 1024
    this.#now = options.now ?? Date.now
    this.#ttlMs = options.requestTtlMs ?? 5 * 60_000
  }

  ingest(processKey, requestId, event) {
    this.#prune()
    const requests = this.#pending.get(processKey) ?? new Map()
    if (event.type === 'requestWillBeSent') {
      this.#drop(processKey, requestId)
      const totalPending = [...this.#pending.values()].reduce((sum, values) => sum + values.size, 0)
      if (requests.size >= this.#maxPendingPerProcess || totalPending >= this.#maxPendingTotal) return false
      requests.set(requestId, { bytes: 0, chunks: [], unavailable: false, updatedAt: this.#now() })
      this.#pending.set(processKey, requests)
    }
    const pending = requests.get(requestId)
    if (pending != null) pending.updatedAt = this.#now()
    if (event.type === 'dataReceived' && pending != null) this.#append(processKey, pending, event)
    if (event.type === 'loadingFinished') {
      if (pending != null && !pending.unavailable) this.#commit(processKey, requestId, pending)
      this.#drop(processKey, requestId)
    }
    if (event.type === 'loadingFailed') this.#drop(processKey, requestId)
    return true
  }

  clear(processKey) {
    for (const requestId of this.#pending.get(processKey)?.keys() ?? []) this.#drop(processKey, requestId)
    this.#pending.delete(processKey)
    this.#processBytes.delete(processKey)
  }

  snapshot() {
    this.#prune()
    return {
      bytes: this.#totalBytes,
      processes: this.#pending.size,
      requests: [...this.#pending.values()].reduce((sum, requests) => sum + requests.size, 0)
    }
  }

  #append(processKey, pending, event) {
    if (event.bodyUnavailable === true) {
      this.#release(processKey, pending)
      pending.unavailable = true
    }
    if (typeof event.dataBase64 !== 'string' || pending.unavailable) return
    const chunk = decodeBase64(event.dataBase64)
    if (chunk == null) {
      this.#release(processKey, pending)
      pending.unavailable = true
      return
    }
    const processBytes = this.#processBytes.get(processKey) ?? 0
    if (
      pending.bytes + chunk.byteLength > this.#maxResponseBytes ||
      processBytes + chunk.byteLength > this.#maxProcessBytes ||
      this.#totalBytes + chunk.byteLength > this.#maxTotalBytes
    ) {
      this.#release(processKey, pending)
      pending.unavailable = true
      return
    }
    pending.bytes += chunk.byteLength
    pending.chunks.push(chunk)
    this.#processBytes.set(processKey, processBytes + chunk.byteLength)
    this.#totalBytes += chunk.byteLength
  }

  #commit(processKey, requestId, pending) {
    try {
      this.#bodyCache.put(processKey, requestId, new Uint8Array(Buffer.concat(pending.chunks)))
    } catch {
      // Body caching is lossy and never blocks the terminal diagnostic.
    }
  }

  #drop(processKey, requestId) {
    const requests = this.#pending.get(processKey)
    const pending = requests?.get(requestId)
    if (pending == null) return
    this.#release(processKey, pending)
    requests.delete(requestId)
    if (requests.size === 0) this.#pending.delete(processKey)
  }

  #release(processKey, pending) {
    if (pending.bytes === 0) return
    this.#totalBytes = Math.max(0, this.#totalBytes - pending.bytes)
    const processBytes = Math.max(0, (this.#processBytes.get(processKey) ?? 0) - pending.bytes)
    if (processBytes === 0) this.#processBytes.delete(processKey)
    else this.#processBytes.set(processKey, processBytes)
    pending.bytes = 0
    pending.chunks = []
  }

  #prune() {
    const cutoff = this.#now() - this.#ttlMs
    for (const [processKey, requests] of this.#pending) {
      for (const [requestId, pending] of requests) {
        if (pending.updatedAt <= cutoff) this.#drop(processKey, requestId)
      }
    }
  }
}
