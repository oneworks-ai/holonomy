import { atomicWriteJson, readJsonFile } from './state-files.mjs'
import { cloneJson, requireInteger, requireRecord, requireString } from './validation.mjs'

const MAX_LEASES = 512
const keyOf = lease =>
  [
    lease.kind,
    lease.serial,
    lease.processId ?? '',
    lease.generation ?? 0,
    lease.localPort ?? 0,
    lease.remotePort ?? 0
  ].join(':')

const normalize = input => {
  const lease = requireRecord(input, 'Android ADB lease')
  const kind = requireString(lease.kind, 'Android ADB lease kind')
  if (!['control-forward', 'fixture-reverse', 'inspector-forward'].includes(kind)) {
    throw new TypeError('Invalid Android ADB lease kind')
  }
  return {
    ...(lease.generation == null ? {} : {
      generation: requireInteger(lease.generation, 'Android ADB lease generation', { min: 1 })
    }),
    kind,
    localPort: requireInteger(lease.localPort, 'Android ADB lease local port', { max: 65_535, min: 1 }),
    ...(lease.processId == null ? {} : { processId: requireString(lease.processId, 'Android ADB lease process') }),
    ...(lease.remotePort == null ? {} : {
      remotePort: requireInteger(lease.remotePort, 'Android ADB lease remote port', { max: 65_535, min: 1 })
    }),
    serial: requireString(lease.serial, 'Android ADB lease serial'),
    ...(lease.socketName == null ? {} : { socketName: requireString(lease.socketName, 'Android ADB lease socket') })
  }
}

export class AndroidAdbLeaseStore {
  #file
  #leases = new Map()
  #opened = false
  #tail = Promise.resolve()

  constructor(options = {}) {
    this.#file = options.file
  }

  async open() {
    return await this.#enqueue(async () => await this.#load())
  }

  list(predicate = () => true) {
    return [...this.#leases.values()].filter(predicate).map(cloneJson)
  }

  async add(input) {
    const lease = normalize(input)
    return await this.#enqueue(async () => {
      await this.#load()
      if (!this.#leases.has(keyOf(lease)) && this.#leases.size >= MAX_LEASES) {
        throw new TypeError('Android ADB lease state exceeds its limit')
      }
      this.#leases.set(keyOf(lease), lease)
      await this.#persist()
      return cloneJson(lease)
    })
  }

  async remove(predicate) {
    return await this.#enqueue(async () => {
      await this.#load()
      let removed = 0
      for (const [key, lease] of this.#leases) {
        if (!predicate(lease)) continue
        this.#leases.delete(key)
        removed += 1
      }
      if (removed > 0) await this.#persist()
      return removed
    })
  }

  async #persist() {
    if (this.#file != null) {
      await atomicWriteJson(this.#file, { leases: [...this.#leases.values()], version: 1 }, 512 * 1024)
    }
  }

  async #load() {
    if (this.#opened) return
    const persisted = this.#file == null ? undefined : await readJsonFile(this.#file)
    if (persisted != null && (persisted.version !== 1 || !Array.isArray(persisted.leases))) {
      throw new TypeError('Invalid Android ADB lease state')
    }
    const inputs = persisted?.leases ?? []
    if (inputs.length > MAX_LEASES) throw new TypeError('Android ADB lease state exceeds its limit')
    this.#leases = new Map(inputs.map(input => {
      const lease = normalize(input)
      return [keyOf(lease), lease]
    }))
    this.#opened = true
  }

  async #enqueue(work) {
    const pending = this.#tail.then(work, work)
    this.#tail = pending.then(() => undefined, () => undefined)
    return await pending
  }
}
