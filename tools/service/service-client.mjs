/* eslint-disable max-lines -- the public client keeps one method per Service operation. */

import process from 'node:process'

import { serviceError } from './errors.mjs'
import { readServiceEndpoint, readServiceToken, resolveHolonomyHome, serviceHomePaths } from './service-home.mjs'
import { requestJson } from './service-http-client.mjs'

const validateRemoteBaseUrl = input => {
  const url = new URL(input)
  const loopback = ['127.0.0.1', '[::1]', '::1', 'localhost'].includes(url.hostname)
  if (!loopback && url.protocol !== 'https:') {
    throw serviceError('service.invalid_request', 'Remote Holonomy Service requires TLS')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw serviceError('service.invalid_request', 'Holonomy Service URL is invalid')
  }
}

export class HolonomyServiceClient {
  #baseUrl
  #ca
  #paths
  #request
  #token
  #tokenFile

  constructor(options = {}) {
    const environment = options.environment ?? process.env
    this.#paths = options.paths ?? serviceHomePaths(options.home ?? resolveHolonomyHome(options.environment))
    const openapiUrl = options.openapiUrl ?? environment.HOLONOMY_OPENAPI_URL
    this.#baseUrl = options.baseUrl ?? environment.HOLONOMY_SERVICE_URL ?? (
      openapiUrl == null ? undefined : new URL(openapiUrl).origin
    )
    if (this.#baseUrl != null) validateRemoteBaseUrl(this.#baseUrl)
    this.#ca = options.ca
    this.#request = options.request ?? requestJson
    this.#token = options.token ?? environment.HOLONOMY_OPENAPI_TOKEN ?? environment.HOLONOMY_SERVICE_TOKEN
    this.#tokenFile = options.tokenFile ?? environment.HOLONOMY_OPENAPI_TOKEN_FILE ??
      environment.HOLONOMY_SERVICE_TOKEN_FILE
  }

  async status() {
    const endpoint = this.#baseUrl == null
      ? await readServiceEndpoint(this.#paths.endpoint)
      : { baseUrl: this.#baseUrl }
    if (endpoint == null) return { running: false }
    try {
      const health = await this.#request(endpoint.baseUrl, '/healthz', {})
      return { endpoint, health, running: true }
    } catch {
      return { endpoint, running: false }
    }
  }

  async call(path, options = {}) {
    const endpoint = this.#baseUrl == null
      ? await readServiceEndpoint(this.#paths.endpoint)
      : { baseUrl: this.#baseUrl }
    const token = options.token ?? this.#token ?? await readServiceToken(
      options.tokenFile ?? this.#tokenFile ?? this.#paths.token
    )
    if (endpoint == null || token == null) throw serviceError('service.unavailable', 'Holonomy Service is unavailable')
    return await this.#request(endpoint.baseUrl, path, { ca: this.#ca, ...options, token })
  }

  async launchProcess(input, idempotencyKey) {
    return await this.call('/v1/processes', {
      body: input,
      headers: { 'idempotency-key': idempotencyKey },
      method: 'POST'
    })
  }

  async getProcess(processId) {
    return await this.call(`/v1/processes/${encodeURIComponent(processId)}`)
  }

  async getOperation(operationId) {
    return await this.call(`/v1/operations/${encodeURIComponent(operationId)}`)
  }

  async processAction(processId, action, expectedGeneration, idempotencyKey) {
    return await this.call(`/v1/processes/${encodeURIComponent(processId)}:${action}`, {
      body: { expectedGeneration },
      headers: { 'idempotency-key': idempotencyKey },
      method: 'POST'
    })
  }

  async removeProcess(processId, expectedGeneration, idempotencyKey) {
    return await this.call(`/v1/processes/${encodeURIComponent(processId)}`, {
      body: { expectedGeneration },
      headers: { 'idempotency-key': idempotencyKey },
      method: 'DELETE'
    })
  }

  async openInspector(processId, expectedGeneration, idempotencyKey, openDevTools = false) {
    return await this.call(`/v1/processes/${encodeURIComponent(processId)}/inspector-leases`, {
      body: { expectedGeneration, openDevTools },
      headers: { 'idempotency-key': idempotencyKey },
      method: 'POST'
    })
  }

  async closeInspector(processId, inspectorId, expectedGeneration, idempotencyKey) {
    return await this.call(
      `/v1/processes/${encodeURIComponent(processId)}/inspector-leases/${encodeURIComponent(inspectorId)}`,
      {
        body: { expectedGeneration },
        headers: { 'idempotency-key': idempotencyKey },
        method: 'DELETE'
      }
    )
  }

  async listEmulators() {
    return await this.call('/v1/emulators')
  }

  async emulatorAction(emulatorId, action, input = {}, idempotencyKey) {
    if (!['restart', 'start', 'stop'].includes(action)) {
      throw serviceError('service.invalid_request', 'Emulator action is invalid')
    }
    return await this.call(`/v1/emulators/${encodeURIComponent(emulatorId)}:${action}`, {
      body: input,
      headers: { 'idempotency-key': idempotencyKey },
      method: 'POST'
    })
  }

  async readEvents(after = 0) {
    return await this.call(`/v1/events/page?after=${after}`)
  }

  async *streamEvents(options = {}) {
    let cursor = options.after ?? 0
    const pollIntervalMs = options.pollIntervalMs ?? 250
    while (!options.signal?.aborted) {
      const events = await this.readEvents(cursor)
      for (const event of events) {
        cursor = Math.max(cursor, event.cursor)
        yield event
      }
      if (events.length === 0) {
        await new Promise(resolve => {
          let abortListener
          const finish = () => {
            options.signal?.removeEventListener('abort', abortListener)
            resolve()
          }
          const timer = setTimeout(finish, pollIntervalMs)
          timer.unref?.()
          abortListener = () => {
            clearTimeout(timer)
            finish()
          }
          options.signal?.addEventListener('abort', abortListener, { once: true })
        })
      }
    }
  }

  async readLogs(processId, options = {}) {
    const query = new URLSearchParams({
      after: String(options.after ?? 0),
      limit: String(options.limit ?? 128),
      waitMs: String(options.waitMs ?? 0)
    })
    return await this.call(`/v1/processes/${encodeURIComponent(processId)}/logs?${query}`)
  }

  async replaceNetworkRules(processId, input, expectedRevision, idempotencyKey) {
    return await this.call(`/v1/processes/${encodeURIComponent(processId)}/network/rules`, {
      body: input,
      headers: { 'idempotency-key': idempotencyKey, 'if-match': expectedRevision },
      method: 'PUT'
    })
  }

  async replaceRuntimePlugins(processId, input, expectedRevision, idempotencyKey) {
    return await this.call(`/v1/processes/${encodeURIComponent(processId)}/runtime-plugins`, {
      body: input,
      headers: { 'idempotency-key': idempotencyKey, 'if-match': String(expectedRevision) },
      method: 'PUT'
    })
  }

  async removeProcessNetworkRules(processId, expectedGeneration, expectedRevision, idempotencyKey) {
    return await this.call(`/v1/processes/${encodeURIComponent(processId)}/network/rules`, {
      body: { expectedGeneration },
      headers: { 'idempotency-key': idempotencyKey, 'if-match': expectedRevision },
      method: 'DELETE'
    })
  }

  async removeNetworkRules(id, expectedGeneration, expectedRevision, idempotencyKey) {
    return await this.call(`/v1/network-rules/${encodeURIComponent(id)}`, {
      body: { expectedGeneration },
      headers: { 'idempotency-key': idempotencyKey, 'if-match': expectedRevision },
      method: 'DELETE'
    })
  }
}

export const createHolonomyServiceClient = options => new HolonomyServiceClient(options)
