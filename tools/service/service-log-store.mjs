import { HolonomyServiceError, serviceError } from './errors.mjs'
import {
  cloneLogRecords,
  countLogEntries,
  createLogLimits,
  createLogRecord,
  logEventBytes,
  normalizeLogInput,
  pageLogRecord,
  pruneLogRecords,
  publicLogEvent
} from './service-log-codec.mjs'
import { ServiceLogPersistence } from './service-log-persistence.mjs'
import { requireIdentifier, requireInteger, requireRecord } from './validation.mjs'

const stableStorageError = error =>
  error instanceof HolonomyServiceError
    ? error
    : serviceError('service.unavailable', 'Holonomy Service process log storage is unavailable', {
      retryable: true
    })

const stateCorrupt = () =>
  serviceError(
    'service.state_corrupt',
    'Holonomy Service process log state is unreadable'
  )

export class ServiceLogStore {
  #limits
  #now
  #opened = false
  #persistence
  #poisoned = false
  #records = new Map()
  #tail = Promise.resolve()

  constructor(options = {}) {
    const value = requireRecord(options, 'Process log store options')
    this.#limits = createLogLimits(value)
    this.#now = value.now ?? Date.now
    if (typeof this.#now !== 'function') {
      throw serviceError('service.invalid_request', 'Process log clock must be a function')
    }
    this.#persistence = new ServiceLogPersistence({ directory: value.directory, limits: this.#limits })
  }

  static async open(options) {
    const store = new ServiceLogStore(options)
    await store.open()
    return store
  }

  async open() {
    return await this.#enqueue(async () => {
      if (this.#opened) return this
      try {
        const records = await this.#persistence.load()
        const working = cloneLogRecords(records)
        const changed = pruneLogRecords(working, this.#timestamp(), this.#limits)
        await this.#persistence.writeChanged(records, working, changed)
        this.#records = working
        this.#opened = true
        this.#poisoned = false
        return this
      } catch (error) {
        throw stableStorageError(error)
      }
    })
  }

  async append(processId, input) {
    const id = requireIdentifier(processId, 'Runtime process id')
    const batch = Array.isArray(input)
    const inputs = batch ? input : [input]
    if (inputs.length === 0) return []
    if (inputs.length > this.#limits.maxTotalEntries) {
      throw serviceError('service.limit_exceeded', 'Process log append exceeds its limit')
    }
    return await this.#enqueue(async () => {
      this.#assertReady()
      const working = cloneLogRecords(this.#records)
      const record = working.get(id) ?? createLogRecord(id)
      const now = this.#timestamp()
      const appended = []
      working.set(id, record)
      for (const value of inputs) {
        if (record.nextSequence >= Number.MAX_SAFE_INTEGER) {
          throw serviceError('service.limit_exceeded', 'Process log cursor is exhausted')
        }
        const event = normalizeLogInput(value, record.nextSequence++, now)
        const bytes = logEventBytes(event)
        if (bytes > this.#limits.maxProcessBytes || bytes > this.#limits.maxTotalBytes) {
          throw serviceError('service.limit_exceeded', 'Process log entry exceeds its limit')
        }
        record.events.push(event)
        record.totalBytes += bytes
        appended.push(publicLogEvent(event))
      }
      const changed = pruneLogRecords(working, now, this.#limits)
      changed.add(id)
      await this.#commit(working, changed, id)
      return batch ? appended : appended[0]
    })
  }

  async appendMany(processId, inputs) {
    if (!Array.isArray(inputs)) {
      throw serviceError('service.invalid_request', 'Process log entries must be an array')
    }
    return await this.append(processId, inputs)
  }

  page(processId, options = {}) {
    this.#assertReady()
    const id = requireIdentifier(processId, 'Runtime process id')
    const value = requireRecord(options, 'Process log page options')
    const after = requireInteger(value.after ?? 0, 'Process log cursor', { min: 0 })
    const limit = requireInteger(value.limit ?? this.#limits.maxPageSize, 'Process log page limit', {
      max: this.#limits.maxPageSize,
      min: 1
    })
    const generation = value.generation == null
      ? undefined
      : requireInteger(value.generation, 'Runtime process generation', { min: 1 })
    const record = this.#records.get(id)
    return record == null ? { cursor: after, events: [] } : pageLogRecord(record, after, limit, generation)
  }

  async prune() {
    return await this.#enqueue(async () => {
      this.#assertReady()
      const working = cloneLogRecords(this.#records)
      const before = countLogEntries(working)
      const changed = pruneLogRecords(working, this.#timestamp(), this.#limits)
      if (changed.size === 0) return 0
      await this.#commit(working, changed)
      return before - countLogEntries(working)
    })
  }

  async remove(processId) {
    const id = requireIdentifier(processId, 'Runtime process id')
    return await this.#enqueue(async () => {
      this.#assertReady()
      if (!this.#records.has(id)) return false
      try {
        await this.#persistence.remove(id)
      } catch (error) {
        this.#poisoned = true
        throw stableStorageError(error)
      }
      this.#records.delete(id)
      return true
    })
  }

  async close() {
    return await this.#enqueue(async () => {
      this.#opened = false
      this.#records = new Map()
    })
  }

  async #commit(working, changed, appendProcessId) {
    try {
      await this.#persistence.writeChanged(this.#records, working, changed, appendProcessId)
    } catch (error) {
      this.#poisoned = true
      throw stableStorageError(error)
    }
    this.#records = working
  }

  #assertReady() {
    if (!this.#opened) {
      throw serviceError('service.unavailable', 'Holonomy Service process log storage is not open')
    }
    if (this.#poisoned) throw stateCorrupt()
  }

  #timestamp() {
    return requireInteger(this.#now(), 'Process log clock', { min: 0 })
  }

  async #enqueue(operation) {
    const pending = this.#tail.then(operation, operation)
    this.#tail = pending.then(() => undefined, () => undefined)
    return await pending
  }
}
