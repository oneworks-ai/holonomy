import { Buffer } from 'node:buffer'
import { chmod, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import {
  DEFAULT_EVENT_RETENTION_MS,
  DEFAULT_MAX_EVENTS_PER_READ,
  DEFAULT_MAX_EVENT_BYTES,
  DEFAULT_MAX_STATE_BYTES,
  SERVICE_SCHEMA_VERSION,
  createInitialServiceState
} from './constants.mjs'
import { serviceError } from './errors.mjs'
import {
  atomicWriteJson,
  journalName,
  readJournalRecords,
  readJsonFile,
  removeTemporaryFiles,
  validateState
} from './state-files.mjs'
import { canonicalJson, cloneJson, requireInteger, requireRecord, requireString } from './validation.mjs'

const STATE_FILE = 'state.json'
const JOURNAL_DIRECTORY = 'journal'

export { atomicWriteJson } from './state-files.mjs'

export class AtomicServiceStateStore {
  #directory
  #eventLimit
  #journalDirectory
  #maxEventBytes
  #maxStateBytes
  #now
  #opened = false
  #poisoned = false
  #retentionMs
  #state
  #subscribers = new Set()
  #tail = Promise.resolve()

  constructor(options) {
    this.#directory = options.directory
    this.#journalDirectory = options.journalDirectory ?? join(options.directory, JOURNAL_DIRECTORY)
    this.#now = options.now ?? Date.now
    this.#retentionMs = options.retentionMs ?? DEFAULT_EVENT_RETENTION_MS
    this.#maxStateBytes = options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES
    this.#maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES
    this.#eventLimit = options.maxEventsPerRead ?? DEFAULT_MAX_EVENTS_PER_READ
    if (!Number.isSafeInteger(this.#retentionMs) || this.#retentionMs <= 0) {
      throw serviceError('service.invalid_request', 'Event retention must be positive')
    }
  }

  async open() {
    return await this.#enqueue(async () => {
      if (this.#opened) return this.getSnapshot()
      await mkdir(this.#directory, { mode: 0o700, recursive: true })
      await mkdir(this.#journalDirectory, { mode: 0o700, recursive: true })
      await chmod(this.#directory, 0o700)
      await chmod(this.#journalDirectory, 0o700)
      await removeTemporaryFiles([this.#directory, this.#journalDirectory])
      const statePath = join(this.#directory, STATE_FILE)
      const persisted = await readJsonFile(statePath)
      let state = validateState(persisted ?? createInitialServiceState())
      let recovered = false
      for (const record of await readJournalRecords(this.#journalDirectory)) {
        if (record.cursor <= state.cursor) continue
        if (record.cursor !== state.cursor + 1) {
          throw serviceError('service.state_corrupt', 'Holonomy Service journal has a cursor gap')
        }
        state = record.nextState
        recovered = true
      }
      if (recovered || persisted == null) await atomicWriteJson(statePath, state, this.#maxStateBytes)
      this.#state = state
      this.#opened = true
      return this.getSnapshot()
    })
  }

  getSnapshot() {
    this.#assertReady()
    return cloneJson(this.#state)
  }

  async transact(eventInput, mutation) {
    return await this.#enqueue(async () => {
      this.#assertReady()
      const draft = cloneJson(this.#state)
      const result = mutation(draft)
      if (result != null && typeof result.then === 'function') {
        throw serviceError('service.internal', 'State mutations must be synchronous')
      }
      const cursor = this.#state.cursor + 1
      const at = this.#now()
      draft.cursor = cursor
      const descriptor = requireRecord(
        typeof eventInput === 'function' ? eventInput(result, draft) : eventInput,
        'Event'
      )
      const event = {
        at,
        cursor,
        ...(descriptor.data === undefined ? {} : { data: cloneJson(descriptor.data) }),
        ...(descriptor.subject === undefined ? {} : { subject: requireString(descriptor.subject, 'Event subject') }),
        type: requireString(descriptor.type, 'Event type', { max: 128 })
      }
      if (Buffer.byteLength(canonicalJson(event), 'utf8') > this.#maxEventBytes) {
        throw serviceError('service.limit_exceeded', 'Holonomy Service event exceeds its limit')
      }
      const nextState = validateState(draft)
      try {
        await atomicWriteJson(
          join(this.#journalDirectory, journalName(cursor)),
          { at, cursor, event, nextState, schemaVersion: SERVICE_SCHEMA_VERSION },
          this.#maxStateBytes + this.#maxEventBytes
        )
        await atomicWriteJson(join(this.#directory, STATE_FILE), nextState, this.#maxStateBytes)
      } catch (error) {
        this.#poisoned = true
        throw error
      }
      this.#state = nextState
      for (const subscriber of this.#subscribers) subscriber(cloneJson(event))
      return cloneJson(result)
    })
  }

  async readEvents(afterCursor, options = {}) {
    this.#assertReady()
    const after = afterCursor == null
      ? this.#state.eventFloor
      : requireInteger(afterCursor, 'Event cursor', { min: 0 })
    if (after < this.#state.eventFloor) {
      throw serviceError('service.cursor_expired', 'The requested event cursor has expired', {
        details: { earliestCursor: this.#state.eventFloor + 1 }
      })
    }
    const limit = requireInteger(options.limit ?? this.#eventLimit, 'Event limit', {
      max: this.#eventLimit,
      min: 1
    })
    return (await readJournalRecords(this.#journalDirectory))
      .filter(record => record.cursor > after).slice(0, limit).map(record => record.event)
  }

  subscribe(listener) {
    this.#assertReady()
    this.#subscribers.add(listener)
    return () => this.#subscribers.delete(listener)
  }

  async pruneEvents() {
    return await this.#enqueue(async () => {
      this.#assertReady()
      const cutoff = this.#now() - this.#retentionMs
      const expired = (await readJournalRecords(this.#journalDirectory))
        .filter(record => record.at < cutoff && record.cursor <= this.#state.cursor)
      if (expired.length === 0) return 0
      const state = cloneJson(this.#state)
      state.eventFloor = Math.max(state.eventFloor, ...expired.map(record => record.cursor))
      await atomicWriteJson(join(this.#directory, STATE_FILE), state, this.#maxStateBytes)
      this.#state = state
      await Promise.all(expired.map(record => unlink(join(this.#journalDirectory, journalName(record.cursor)))))
      return expired.length
    })
  }

  async #enqueue(operation) {
    const pending = this.#tail.then(operation, operation)
    this.#tail = pending.then(() => undefined, () => undefined)
    return await pending
  }

  #assertReady() {
    if (!this.#opened) throw serviceError('service.unavailable', 'Holonomy Service state is not open')
    if (this.#poisoned) throw serviceError('service.state_corrupt', 'Holonomy Service state requires recovery')
  }
}
