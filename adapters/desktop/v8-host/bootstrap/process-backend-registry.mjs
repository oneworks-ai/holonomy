import { normalizeProcessBackendDescriptorV1 } from '../../../../packages/capabilities/process/src/kernel/process-backend.ts'

// Keep the existing private registry error stable for v86 installations.
const invalid = () => {
  throw new TypeError('Invalid native v86 Process Backend')
}
const exact = (value, keys) => {
  if (
    value == null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !keys.includes(key))
  ) return invalid()
  return value
}
const identifier = value =>
  typeof value === 'string' && /^[A-Za-z0-9][\w.-]{0,127}$/u.test(value)
    ? value
    : invalid()

/** One Host-only registry for selected Native and VM Process backends. */
export class NativeProcessBackendRegistryV1 {
  #backends = new Map()

  constructor(backends = []) {
    for (const backend of backends) this.register(backend)
  }
  descriptors() {
    return Object.freeze([...this.#backends.values()].map(item => item.descriptor))
  }
  get(backendId) {
    return this.#backends.get(backendId)
  }

  register(value) {
    if (value == null || typeof value !== 'object') return invalid()
    const descriptor = normalizeProcessBackendDescriptorV1(value.descriptor)
    if (
      this.#backends.has(descriptor.backendId) ||
      [
        'closeGeneration',
        'normalizeConfiguration',
        'normalizeExecutable',
        'prepareLaunch',
        'spawn',
        'validateProfile',
        'poll'
      ].some(name => typeof value[name] !== 'function') ||
      (descriptor.features.synchronousSpawn && typeof value.spawnSync !== 'function')
    ) return invalid()
    this.#backends.set(descriptor.backendId, Object.freeze({ ...value, descriptor }))
    return this
  }

  normalizeProfileBackend(value) {
    const input = exact(value, ['backendId', 'configuration'])
    const backendId = identifier(input.backendId)
    const backend = this.#backends.get(backendId)
    if (backend == null) return invalid()
    return Object.freeze({ backendId, configuration: backend.normalizeConfiguration(input.configuration) })
  }

  normalizeExecutable(backendId, value) {
    const backend = this.#backends.get(backendId)
    if (backend == null) return invalid()
    return backend.normalizeExecutable(value)
  }
}
