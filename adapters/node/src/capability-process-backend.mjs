import process from 'node:process'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { normalizeProcessBackendDescriptorV1 } from '../../../dist/capability-runtime/index.js'

import { DARWIN_SEATBELT_PROCESS_BACKEND_V1 } from './capability-process-native-backend.mjs'

const invalid = () => {
  throw new TypeError('Invalid Node capability Runtime session')
}

const exact = (value, keys) => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid()
  return value
}

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][\w.-]{0,127}$/u.test(value) ? value : invalid()

export class NodeProcessBackendRegistryV1 {
  #backends = new Map()

  constructor(backends = []) {
    for (const backend of backends) this.register(backend)
  }

  descriptors() {
    return Object.freeze(
      [...this.#backends.values()]
        .map(backend => backend.descriptor)
        .sort((left, right) => left.backendId < right.backendId ? -1 : 1)
    )
  }

  get(backendId) {
    return this.#backends.get(backendId)
  }

  extend(backends) {
    return new NodeProcessBackendRegistryV1([...this.#backends.values(), ...backends])
  }

  normalizeProfileBackend(value) {
    const input = exact(value, ['backendId', 'configuration'])
    const backendId = identifier(input.backendId)
    const backend = this.#backends.get(backendId)
    if (backend == null) return invalid()
    return Object.freeze({
      backendId,
      configuration: backend.normalizeConfiguration(input.configuration)
    })
  }

  normalizeExecutable(backendId, value) {
    const backend = this.#backends.get(backendId)
    if (backend == null) return invalid()
    return backend.normalizeExecutable(value)
  }

  register(value) {
    if (value == null || typeof value !== 'object') return invalid()
    const descriptor = normalizeProcessBackendDescriptorV1(value.descriptor)
    if (
      this.#backends.has(descriptor.backendId) ||
      typeof value.closeGeneration !== 'function' ||
      typeof value.normalizeConfiguration !== 'function' ||
      typeof value.normalizeExecutable !== 'function' ||
      typeof value.prepareLaunch !== 'function' ||
      typeof value.spawn !== 'function' ||
      typeof value.validateProfile !== 'function' ||
      descriptor.features.synchronousSpawn && typeof value.spawnSync !== 'function'
    ) return invalid()
    this.#backends.set(descriptor.backendId, Object.freeze({ ...value, descriptor }))
    return this
  }
}

export const NODE_PROCESS_BACKEND_REGISTRY_V1 = new NodeProcessBackendRegistryV1(
  process.platform === 'darwin' ? [DARWIN_SEATBELT_PROCESS_BACKEND_V1] : []
)
