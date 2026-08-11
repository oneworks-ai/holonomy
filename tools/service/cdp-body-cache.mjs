import { Buffer } from 'node:buffer'

import { serviceError } from './errors.mjs'

const DEFAULTS = Object.freeze({
  maxProcessBytes: 16 * 1024 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
  maxServiceBytes: 64 * 1024 * 1024,
  ttlMs: 5 * 60 * 1_000
})

export class CdpResponseBodyCache {
  #bytes = 0
  #limits
  #now
  #processes = new Map()

  constructor(options = {}) {
    this.#limits = { ...DEFAULTS, ...options }
    this.#now = options.now ?? Date.now
  }

  get(processKey, requestId) {
    this.prune()
    const entry = this.#processes.get(processKey)?.entries.get(requestId)
    if (entry == null) throw serviceError('service.not_found', 'Inspector response body is unavailable')
    entry.accessedAt = this.#now()
    return { base64Encoded: entry.base64Encoded, body: entry.body }
  }

  put(processKey, requestId, value) {
    const normalized = normalizeBody(value)
    if (normalized.bytes > this.#limits.maxResponseBytes) {
      throw serviceError('service.limit_exceeded', 'Inspector response body exceeds its limit')
    }
    this.prune()
    const bucket = this.#processes.get(processKey) ?? { bytes: 0, entries: new Map() }
    this.#processes.set(processKey, bucket)
    this.#removeEntry(bucket, requestId)
    this.#evictUntil(bucket, normalized.bytes)
    if (
      bucket.bytes + normalized.bytes > this.#limits.maxProcessBytes ||
      this.#bytes + normalized.bytes > this.#limits.maxServiceBytes
    ) {
      throw serviceError('service.limit_exceeded', 'Inspector response body cache is full')
    }
    const entry = { ...normalized, accessedAt: this.#now(), expiresAt: this.#now() + this.#limits.ttlMs }
    bucket.entries.set(requestId, entry)
    bucket.bytes += entry.bytes
    this.#bytes += entry.bytes
  }

  clearProcess(processKey) {
    const bucket = this.#processes.get(processKey)
    if (bucket == null) return
    this.#bytes = Math.max(0, this.#bytes - bucket.bytes)
    this.#processes.delete(processKey)
  }

  prune() {
    const now = this.#now()
    for (const [processKey, bucket] of this.#processes) {
      for (const [requestId, entry] of bucket.entries) {
        if (entry.expiresAt <= now) this.#removeEntry(bucket, requestId)
      }
      if (bucket.entries.size === 0) this.#processes.delete(processKey)
    }
  }

  snapshot() {
    return { bytes: this.#bytes, processes: this.#processes.size }
  }

  #evictUntil(bucket, additional) {
    const oldest = () =>
      [...bucket.entries.entries()].sort((left, right) => left[1].accessedAt - right[1].accessedAt)[0]
    while (bucket.bytes + additional > this.#limits.maxProcessBytes && bucket.entries.size > 0) {
      this.#removeEntry(bucket, oldest()[0])
    }
    while (this.#bytes + additional > this.#limits.maxServiceBytes) {
      const candidates = [...this.#processes.values()].flatMap(candidate =>
        [...candidate.entries.entries()].map(
          ([requestId, entry]) => ({ bucket: candidate, entry, requestId })
        )
      )
      candidates.sort((left, right) => left.entry.accessedAt - right.entry.accessedAt)
      if (candidates.length === 0) break
      this.#removeEntry(candidates[0].bucket, candidates[0].requestId)
    }
  }

  #removeEntry(bucket, requestId) {
    const entry = bucket.entries.get(requestId)
    if (entry == null) return
    bucket.entries.delete(requestId)
    bucket.bytes = Math.max(0, bucket.bytes - entry.bytes)
    this.#bytes = Math.max(0, this.#bytes - entry.bytes)
  }
}

function normalizeBody(value) {
  if (typeof value === 'string') {
    return { base64Encoded: false, body: value, bytes: Buffer.byteLength(value) }
  }
  if (value instanceof Uint8Array) {
    return { base64Encoded: true, body: Buffer.from(value).toString('base64'), bytes: value.byteLength }
  }
  throw serviceError('service.invalid_request', 'Inspector response body is invalid')
}
