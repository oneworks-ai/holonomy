import process from 'node:process'

import { PROCESS_TERMINAL_STATES, SERVICE_API_VERSION } from './constants.mjs'
import { serviceError } from './errors.mjs'
import { createServiceToken } from './http-utils.mjs'
import { activeOwnedResourceCount, drainOwnedResources } from './lifecycle-owned-resources.mjs'
import { processIsRunning } from './process-identity.mjs'
import { createHolonomyService } from './server.mjs'
import { HolonomyServiceClient } from './service-client.mjs'
import {
  acquireServiceLock,
  ensureServiceToken,
  prepareServiceHome,
  readServiceLock,
  removeServiceEndpoint,
  removeStaleServiceLock,
  resolveHolonomyHome,
  serviceHomePaths,
  writePrivateText,
  writeServiceEndpoint
} from './service-home.mjs'

export class HolonomyServiceLifecycleManager {
  #client
  #createService
  #home
  #lock
  #options
  #paths
  #service
  #stopping

  constructor(options = {}) {
    this.#home = options.home ?? resolveHolonomyHome(options.environment)
    this.#paths = serviceHomePaths(this.#home)
    this.#client = options.client ?? new HolonomyServiceClient({ paths: this.#paths })
    this.#createService = options.createService ?? createHolonomyService
    this.#options = options
  }

  async ensure() {
    await prepareServiceHome(this.#home)
    const current = await this.#client.status()
    if (current.running) return { ...current, reused: true }
    this.#lock = await acquireServiceLock(this.#paths.lock)
    if (this.#lock == null) {
      const raced = await this.#client.status()
      if (raced.running) return { ...raced, reused: true }
      const lock = await readServiceLock(this.#paths.lock)
      if (processIsRunning(lock?.pid)) throw serviceError('service.conflict', 'Holonomy Service is starting')
      await removeStaleServiceLock(this.#paths.lock)
      this.#lock = await acquireServiceLock(this.#paths.lock)
      if (this.#lock == null) throw serviceError('service.conflict', 'Holonomy Service start raced')
    }
    try {
      return await this.#startOwnedService()
    } catch (error) {
      await this.#lock.release()
      this.#lock = undefined
      throw error
    }
  }

  async status() {
    const remote = await this.#client.status()
    if (!remote.running || this.#service == null) return remote
    const snapshot = this.#service.core.snapshot()
    return {
      ...remote,
      activeProcesses: Object.values(snapshot.resources.processes)
        .filter(resource => !PROCESS_TERMINAL_STATES.has(resource.state)).length,
      cursor: snapshot.cursor,
      owned: true
    }
  }

  async stop(options = {}) {
    if (this.#stopping != null) return await this.#stopping
    if (this.#service == null) {
      const status = await this.#client.status()
      if (!status.running) return { stopped: false }
      return await this.#client.call('/v1/service:shutdown', {
        body: { drain: options.drain === true },
        headers: { 'idempotency-key': options.idempotencyKey ?? 'service-stop' },
        method: 'POST'
      })
    }
    const stopping = this.#stopOwned(options)
    this.#stopping = stopping
    try {
      return await stopping
    } finally {
      if (this.#stopping === stopping && this.#service != null) this.#stopping = undefined
    }
  }

  async rotateToken() {
    if (this.#service == null) {
      return await this.#client.call('/v1/service/token:rotate', {
        body: {},
        headers: { 'idempotency-key': 'service-token-rotate' },
        method: 'POST'
      })
    }
    const token = createServiceToken()
    await writePrivateText(this.#paths.token, `${token}\n`)
    this.#service.rotateToken(token)
    return { rotatedAt: Date.now() }
  }

  async requestShutdown(options) {
    const active = await this.#activeOwnedResources()
    if (active > 0 && options.drain !== true) {
      throw serviceError('service.conflict', 'Holonomy Service has active owned resources')
    }
    if (options.drain === true && active > 0) {
      await drainOwnedResources(this.#service, processes => this.#drain(processes))
    }
    setImmediate(() => void this.stop(options).catch(() => undefined))
    return { accepted: true }
  }

  async #startOwnedService() {
    const token = await ensureServiceToken(this.#paths.token)
    this.#service = this.#createService({
      ...this.#options.service,
      adapterDispatcher: this.#options.adapterDispatcher,
      control: {
        rotateToken: () => this.rotateToken(),
        shutdown: input => this.requestShutdown(input),
        status: () => this.status()
      },
      journalDirectory: this.#paths.journal,
      stateDirectory: this.#paths.state,
      token
    })
    const baseUrl = await this.#service.start()
    const endpoint = {
      apiVersion: SERVICE_API_VERSION,
      baseUrl,
      createdAt: Date.now(),
      pid: process.pid,
      tls: baseUrl.startsWith('https:')
    }
    await writeServiceEndpoint(this.#paths.endpoint, endpoint)
    return { endpoint, health: { apiVersion: SERVICE_API_VERSION, status: 'ready' }, reused: false, running: true }
  }

  async #stopOwned(options) {
    const active = await this.#activeOwnedResources()
    if (active > 0 && options.drain !== true) {
      this.#stopping = undefined
      throw serviceError('service.conflict', 'Holonomy Service has active runtime processes')
    }
    if (active > 0) await drainOwnedResources(this.#service, processes => this.#drain(processes))
    await this.#service.close()
    this.#service = undefined
    await removeServiceEndpoint(this.#paths.endpoint)
    await this.#lock?.release()
    this.#lock = undefined
    return { stopped: true }
  }

  async #activeOwnedResources() {
    if (this.#service == null) return 0
    return await activeOwnedResourceCount(this.#service)
  }

  async #drain(processes) {
    const operations = []
    for (const processRecord of processes) {
      const result = await this.#service.core.stopProcess(
        processRecord.id,
        processRecord.generation,
        `service-drain:${processRecord.id}:${processRecord.generation}`
      )
      operations.push(result.value.operation.id)
    }
    for (let turn = 0; turn < 3_000; turn += 1) {
      if (
        operations.every(id =>
          ['cancelled', 'failed', 'succeeded'].includes(
            this.#service.core.get('operations', id, 'Operation').state
          )
        )
      ) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw serviceError('service.unavailable', 'Holonomy Service drain timed out')
  }
}

export const createHolonomyServiceLifecycleManager = options => new HolonomyServiceLifecycleManager(options)
