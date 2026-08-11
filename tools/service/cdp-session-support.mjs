import { randomUUID } from 'node:crypto'

import { serviceError } from './errors.mjs'

export const processKey = (processId, generation) => `${processId}:${generation}`
export const cdpError = id => ({ error: { code: -32_000, message: 'Inspector operation failed' }, id })

export const createInspectorEndpoint = (baseUrl, lease) => {
  if (baseUrl == null) return {}
  const protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  const target = new URL(`/v1/inspectors/${encodeURIComponent(lease.inspectorId)}/cdp`, baseUrl)
  target.protocol = protocol
  target.searchParams.set('access_token', lease.token)
  const frontend = new URL('devtools://devtools/bundled/js_app.html')
  frontend.searchParams.set(protocol === 'wss:' ? 'wss' : 'ws', `${target.host}${target.pathname}${target.search}`)
  return { devtoolsFrontendUrl: frontend.toString(), webSocketDebuggerUrl: target.toString() }
}

export class CdpRequestIds {
  #maxPerProcess
  #maxTotal
  #now
  #processes = new Map()
  #ttlMs

  constructor(options = {}) {
    this.#maxPerProcess = options.maxActiveRequestsPerProcess ?? 4_096
    this.#maxTotal = options.maxActiveRequests ?? 16_384
    this.#now = options.now ?? Date.now
    this.#ttlMs = options.requestTtlMs ?? 5 * 60_000
  }

  open(key, internalId) {
    this.#prune()
    this.#validate(internalId)
    const ids = this.#processes.get(key) ?? new Map()
    const existing = ids.get(internalId)
    if (existing != null) {
      existing.updatedAt = this.#now()
      return existing.publicId
    }
    const total = [...this.#processes.values()].reduce((count, values) => count + values.size, 0)
    if (ids.size >= this.#maxPerProcess || total >= this.#maxTotal) {
      throw serviceError('service.limit_exceeded', 'Network diagnostic request inventory exceeds its limit')
    }
    const publicId = `request_${randomUUID().replaceAll('-', '')}`
    ids.set(internalId, { publicId, updatedAt: this.#now() })
    this.#processes.set(key, ids)
    return publicId
  }

  get(key, internalId) {
    this.#prune()
    this.#validate(internalId)
    const entry = this.#processes.get(key)?.get(internalId)
    if (entry == null) throw serviceError('service.not_found', 'Network diagnostic request is not active')
    entry.updatedAt = this.#now()
    return entry.publicId
  }

  close(key, internalId) {
    const ids = this.#processes.get(key)
    if (ids == null) return false
    const removed = ids.delete(internalId)
    if (ids.size === 0) this.#processes.delete(key)
    return removed
  }

  snapshot() {
    this.#prune()
    return {
      processes: this.#processes.size,
      requests: [...this.#processes.values()].reduce((sum, ids) => sum + ids.size, 0)
    }
  }

  #validate(internalId) {
    if (typeof internalId !== 'string' || internalId.length === 0 || internalId.length > 4_096) {
      throw serviceError('service.invalid_request', 'Network diagnostic request id is invalid')
    }
  }

  #prune() {
    const cutoff = this.#now() - this.#ttlMs
    for (const [key, ids] of this.#processes) {
      for (const [internalId, entry] of ids) {
        if (entry.updatedAt <= cutoff) ids.delete(internalId)
      }
      if (ids.size === 0) this.#processes.delete(key)
    }
  }

  clear(key) {
    this.#processes.delete(key)
  }
}

export const safeSessionSink = (sessions, session, message) => {
  try {
    session.sink(message)
  } catch {
    sessions.delete(session.id)
  }
}

export const emitInspectorUpstream = (sessions, lease, message) => {
  if (typeof message?.method === 'string' && message.method.startsWith('Network.')) return
  for (const session of [...sessions.values()]) {
    if (session.lease === lease) safeSessionSink(sessions, session, message)
  }
}
