import { normalizeServiceError, serviceError } from './errors.mjs'
import { atomicWriteJson, readJsonFile } from './state-files.mjs'
import { cloneJson, fingerprintJson, requireString } from './validation.mjs'

const RETENTION_MS = 24 * 60 * 60 * 1_000
const MAX_RECORDS = 1_024

export class DurableMutationCoordinator {
  #file
  #loaded = false
  #now
  #readJson
  #records = {}
  #tail = Promise.resolve()

  constructor(options = {}) {
    this.#file = options.file
    this.#now = options.now ?? Date.now
    this.#readJson = options.readJson ?? readJsonFile
  }

  async execute(scope, key, input, work) {
    const task = this.#tail.then(
      () => this.#execute(scope, key, input, work),
      () => this.#execute(scope, key, input, work)
    )
    this.#tail = task.then(() => undefined, () => undefined)
    return await task
  }

  async #execute(scopeInput, keyInput, input, work) {
    await this.#load()
    const scope = requireString(scopeInput, 'Mutation scope', { max: 256 })
    const key = requireString(keyInput, 'Idempotency key', { max: 200 })
    const fingerprint = fingerprintJson(input)
    const recordKey = fingerprintJson([scope, key])
    const existing = this.#records[recordKey]
    if (existing != null && existing.expiresAt > this.#now()) {
      if (existing.fingerprint !== fingerprint) {
        throw serviceError('service.conflict', 'Idempotency key was reused with different input')
      }
      if (existing.state === 'pending') {
        throw serviceError('service.conflict', 'Mutation outcome requires reconciliation')
      }
      if (existing.state === 'failed') throw serviceError(existing.error.code, existing.error.message, existing.error)
      return cloneJson(existing.response)
    }
    this.#prune()
    if (Object.keys(this.#records).length >= MAX_RECORDS) {
      throw serviceError('service.limit_exceeded', 'Mutation history exceeds its limit')
    }
    const record = {
      expiresAt: this.#now() + RETENTION_MS,
      fingerprint,
      scope,
      state: 'pending'
    }
    this.#records[recordKey] = record
    await this.#persist()
    try {
      const response = await work()
      Object.assign(record, { response: cloneJson(response), state: 'succeeded' })
      await this.#persist()
      return response
    } catch (error) {
      const normalized = normalizeServiceError(error)
      Object.assign(record, {
        error: {
          code: normalized.code,
          message: normalized.message,
          retryable: normalized.retryable,
          status: normalized.status
        },
        state: 'failed'
      })
      await this.#persist()
      throw normalized
    }
  }

  async #load() {
    if (this.#loaded) return
    if (this.#file == null) {
      this.#loaded = true
      return
    }
    const persisted = await this.#readJson(this.#file)
    if (persisted == null) {
      this.#loaded = true
      return
    }
    if (persisted.version !== 1 || typeof persisted.records !== 'object' || persisted.records == null) {
      throw serviceError('service.state_corrupt', 'Mutation history is invalid')
    }
    this.#records = persisted.records
    this.#prune()
    this.#loaded = true
  }

  #prune() {
    const now = this.#now()
    for (const [key, record] of Object.entries(this.#records)) {
      if (!Number.isSafeInteger(record?.expiresAt) || record.expiresAt <= now) delete this.#records[key]
    }
  }

  async #persist() {
    if (this.#file != null) await atomicWriteJson(this.#file, { records: this.#records, version: 1 }, 1024 * 1024)
  }
}

export const createDurableMutationCoordinator = options => new DurableMutationCoordinator(options)
