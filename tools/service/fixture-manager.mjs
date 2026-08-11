import { startHolonomyNetworkFixture } from '../holonomy-network-fixture.mjs'

import { serviceError } from './errors.mjs'
import { cloneJson } from './validation.mjs'

const DEFAULT_MAX_FIXTURE_LEASES = 256

const persistedFixturePort = value => {
  if (value == null) return undefined
  let url
  try {
    url = new URL(value)
  } catch {
    throw serviceError('service.state_corrupt', 'Persisted Runtime fixture URL is invalid')
  }
  const port = Number(url.port)
  if (
    url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username !== '' || url.password !== '' ||
    url.pathname !== '/' || url.search !== '' || url.hash !== '' || !Number.isSafeInteger(port) || port < 1 ||
    port > 65_535
  ) {
    throw serviceError('service.state_corrupt', 'Persisted Runtime fixture URL is not a loopback origin')
  }
  return port
}

export class ConformanceFixtureManager {
  #leases = new Map()
  #maxLeases
  #startFixture

  constructor(options = {}) {
    this.#maxLeases = options.maxLeases ?? DEFAULT_MAX_FIXTURE_LEASES
    if (!Number.isSafeInteger(this.#maxLeases) || this.#maxLeases < 1) {
      throw new TypeError('Runtime fixture lease limit must be a positive integer')
    }
    this.#startFixture = options.startFixture ?? startHolonomyNetworkFixture
  }

  async start(process) {
    if (process.fixture?.kind !== 'conformance-network-v1') return undefined
    const persistedUrl = process.fixtureRuntimeUrl
    const persistedPort = persistedFixturePort(persistedUrl)
    const existing = this.#leases.get(process.id)
    if (existing != null) {
      if (
        JSON.stringify(existing.descriptor) !== JSON.stringify(process.fixture) ||
        process.generation < existing.generation ||
        (persistedUrl != null && persistedUrl !== existing.fixture.url)
      ) throw new TypeError('Runtime fixture lease does not match the process generation')
      existing.generation = process.generation
      return Object.freeze({
        baseUrl: existing.fixture.url,
        descriptor: cloneJson(existing.descriptor),
        generation: process.generation,
        processId: process.id
      })
    }
    if (this.#leases.size >= this.#maxLeases) {
      throw serviceError('service.limit_exceeded', 'Runtime fixture lease limit was reached')
    }
    const fixture = await this.#startFixture(persistedPort == null ? {} : { port: persistedPort })
    if (persistedUrl != null && fixture.url !== persistedUrl) {
      await fixture.close()
      throw serviceError('service.state_corrupt', 'Recovered Runtime fixture origin does not match persisted state')
    }
    const descriptor = cloneJson(process.fixture)
    const publicLease = Object.freeze({
      baseUrl: fixture.url,
      descriptor,
      generation: process.generation,
      processId: process.id
    })
    this.#leases.set(process.id, { descriptor, fixture, generation: process.generation })
    return publicLease
  }

  async stop(processId, generation) {
    const lease = this.#leases.get(processId)
    if (lease == null || (generation != null && lease.generation !== generation)) return false
    this.#leases.delete(processId)
    await lease.fixture.close()
    return true
  }

  async release(processId) {
    return await this.stop(processId)
  }

  async close() {
    const leases = [...this.#leases.values()]
    this.#leases.clear()
    await Promise.allSettled(leases.map(lease => lease.fixture.close()))
  }
}

export const withFixtureUrl = (process, fixtureUrl) => {
  if (fixtureUrl == null) return process
  const copy = cloneJson(process)
  copy.launch.env = { ...(copy.launch.env ?? {}), HOLONOMY_FIXTURE_URL: fixtureUrl }
  return copy
}
