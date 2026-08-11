import { randomBytes, randomUUID } from 'node:crypto'

import { CdpBodyAccumulator } from './cdp-body-accumulator.mjs'
import { CdpResponseBodyCache } from './cdp-body-cache.mjs'
import { CdpNetworkProjector } from './cdp-network.mjs'
import {
  CdpRequestIds,
  cdpError,
  createInspectorEndpoint,
  emitInspectorUpstream,
  processKey,
  safeSessionSink
} from './cdp-session-support.mjs'
import { serviceError } from './errors.mjs'
import { InspectorResumeCoordinator } from './inspector-resume-coordinator.mjs'
import { requireIdentifier, requireRecord, tokensEqual } from './validation.mjs'

export class InspectorCdpProxy {
  #bodyCache
  #bodyAccumulator
  #baseUrl
  #diagnosticSubscriptions = new Map()
  #leases = new Map()
  #network
  #requestIds
  #resumes = new InspectorResumeCoordinator()
  #sessions = new Map()
  constructor(options = {}) {
    this.#bodyCache = options.bodyCache ?? new CdpResponseBodyCache(options)
    this.#bodyAccumulator = new CdpBodyAccumulator(this.#bodyCache, options)
    this.#network = new CdpNetworkProjector(options)
    this.#requestIds = new CdpRequestIds(options)
  }
  configureEndpoint(baseUrl) {
    const url = new URL(baseUrl)
    this.#baseUrl = url
  }
  configureResume(handler) {
    this.#resumes.configure(handler)
  }
  attach(input) {
    const inspector = requireRecord(input.inspector, 'Inspector lease')
    const process = requireRecord(input.process, 'Runtime process')
    if (inspector.processId !== process.id || inspector.generation !== process.generation) {
      throw serviceError('service.precondition_failed', 'Inspector lease is stale')
    }
    if (typeof input.transport?.send !== 'function') {
      throw serviceError('service.invalid_request', 'Inspector transport is invalid')
    }
    this.closeLease(inspector.id)
    const lease = {
      generation: process.generation,
      inspectorId: inspector.id,
      processId: process.id,
      token: randomBytes(32).toString('base64url'),
      transport: input.transport,
      unsubscribe: undefined,
      unsubscribeDiagnostics: undefined
    }
    if (typeof input.transport.subscribe === 'function') {
      lease.unsubscribe = input.transport.subscribe(message => emitInspectorUpstream(this.#sessions, lease, message))
    }
    if (typeof input.diagnostics?.subscribe === 'function') {
      lease.unsubscribeDiagnostics = input.diagnostics.subscribe(entry => {
        try {
          this.emitDiagnostic(process.id, process.generation, entry?.event ?? entry)
        } catch {
          // Diagnostics never participates in runtime fetch completion.
        }
      })
    }
    this.#leases.set(inspector.id, lease)
    return createInspectorEndpoint(this.#baseUrl, lease)
  }
  attachDiagnostics(process, diagnostics) {
    if (typeof diagnostics?.subscribe !== 'function') return false
    const key = processKey(process.id, process.generation)
    this.#diagnosticSubscriptions.get(key)?.()
    const unsubscribe = diagnostics.subscribe(event => {
      try {
        this.emitDiagnostic(process.id, process.generation, event)
      } catch {
        // Diagnostics never participates in runtime execution.
      }
    })
    this.#diagnosticSubscriptions.set(key, unsubscribe)
    return true
  }
  connect(inspectorId, sink) {
    requireIdentifier(inspectorId, 'Inspector lease id')
    const lease = this.#leases.get(inspectorId)
    if (lease == null) throw serviceError('service.not_found', 'Inspector transport is unavailable')
    if (typeof sink !== 'function') throw serviceError('service.invalid_request', 'Inspector sink is invalid')
    const id = `${inspectorId}:${randomUUID()}`
    const session = { enabled: false, id, lease, sink }
    this.#sessions.set(id, session)
    return Object.freeze({
      close: () => this.#sessions.delete(id),
      id,
      receive: async message => await this.#receive(session, message)
    })
  }
  connectAuthorized(inspectorId, token, sink) {
    const lease = this.#leases.get(inspectorId)
    if (lease == null || !tokensEqual(token, lease.token)) {
      throw serviceError('service.unauthorized', 'Inspector access token is invalid')
    }
    return this.connect(inspectorId, sink)
  }
  emitDiagnostic(processId, generation, event) {
    try {
      const value = requireRecord(event, 'Network diagnostic')
      const key = processKey(processId, generation)
      const internalId = value.requestId
      const requestId = value.type === 'requestWillBeSent'
        ? this.#requestIds.open(key, internalId)
        : this.#requestIds.get(key, internalId)
      this.#bodyAccumulator.ingest(key, requestId, value)
      const messages = this.#network.project(key, { ...value, requestId }, {
        loaderId: `holonomy-loader-${generation}`
      })
      for (const message of messages) {
        for (const session of [...this.#sessions.values()]) {
          if (
            session.enabled && session.lease.processId === processId &&
            session.lease.generation === generation
          ) safeSessionSink(this.#sessions, session, message)
        }
      }
      if (value.type === 'loadingFinished' || value.type === 'loadingFailed') {
        this.#requestIds.close(key, internalId)
      }
      return true
    } catch {
      return false
    }
  }
  closeLease(inspectorId) {
    const lease = this.#leases.get(inspectorId)
    if (lease == null) return false
    this.#leases.delete(inspectorId)
    lease.unsubscribe?.()
    lease.unsubscribeDiagnostics?.()
    lease.transport.close?.()
    for (const [id, session] of this.#sessions) {
      if (session.lease === lease) this.#sessions.delete(id)
    }
    return true
  }
  closeProcess(processId, generation) {
    for (const lease of [...this.#leases.values()]) {
      if (lease.processId === processId && lease.generation === generation) this.closeLease(lease.inspectorId)
    }
    const key = processKey(processId, generation)
    this.#diagnosticSubscriptions.get(key)?.()
    this.#diagnosticSubscriptions.delete(key)
    this.#bodyCache.clearProcess(key)
    this.#bodyAccumulator.clear(key)
    this.#network.clear(key)
    this.#requestIds.clear(key)
  }

  async close() {
    for (const id of [...this.#leases.keys()]) this.closeLease(id)
    for (const unsubscribe of this.#diagnosticSubscriptions.values()) unsubscribe()
    this.#diagnosticSubscriptions.clear()
  }

  async #receive(session, input) {
    const message = requireRecord(input, 'CDP message')
    if (!Number.isSafeInteger(message.id) || typeof message.method !== 'string') return cdpError(message.id)
    if (this.#sessions.get(session.id) !== session) return cdpError(message.id)
    if (this.#leases.get(session.lease.inspectorId) !== session.lease) return cdpError(message.id)
    try {
      if (message.method === 'Network.enable') {
        session.enabled = true
        return { id: message.id, result: {} }
      }
      if (message.method === 'Network.disable') {
        session.enabled = false
        return { id: message.id, result: {} }
      }
      if (message.method === 'Network.getResponseBody') {
        const requestId = requireIdentifier(message.params?.requestId, 'Request id')
        return {
          id: message.id,
          result: this.#bodyCache.get(processKey(session.lease.processId, session.lease.generation), requestId)
        }
      }
      if (message.method.startsWith('Network.')) return cdpError(message.id)
      const response = await session.lease.transport.send(message)
      if (this.#sessions.get(session.id) !== session) return cdpError(message.id)
      if (this.#leases.get(session.lease.inspectorId) !== session.lease) return cdpError(message.id)
      return await this.#resumes.afterResponse(session.lease, message, response)
    } catch {
      return cdpError(message.id)
    }
  }
}
