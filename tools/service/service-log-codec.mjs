import { Buffer } from 'node:buffer'

import { DEFAULT_EVENT_RETENTION_MS } from './constants.mjs'
import { serviceError } from './errors.mjs'
import {
  canonicalJson,
  cloneJson,
  requireIdentifier,
  requireInteger,
  requireRecord,
  requireString
} from './validation.mjs'

export const LOG_SCHEMA_VERSION = 1
export const HARD_LOG_LIMITS = Object.freeze({
  maxEntriesPerProcess: 16_384,
  maxProcessBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxTotalEntries: 65_536,
  maxPageSize: 1_024
})
export const DEFAULT_LOG_LIMITS = Object.freeze({
  maxEntriesPerProcess: 4_096,
  maxProcessBytes: 4 * 1024 * 1024,
  maxTotalBytes: HARD_LOG_LIMITS.maxTotalBytes,
  maxTotalEntries: HARD_LOG_LIMITS.maxTotalEntries,
  maxPageSize: HARD_LOG_LIMITS.maxPageSize,
  ttlMs: DEFAULT_EVENT_RETENTION_MS
})

const corrupt = () => serviceError('service.state_corrupt', 'Holonomy Service process log state is unreadable')
export const logEventBytes = event => Buffer.byteLength(canonicalJson(event), 'utf8')

export const createLogLimits = options => {
  const bounded = (name, label) =>
    requireInteger(options[name] ?? DEFAULT_LOG_LIMITS[name], label, {
      max: HARD_LOG_LIMITS[name],
      min: 1
    })
  return Object.freeze({
    maxEntriesPerProcess: bounded('maxEntriesPerProcess', 'Per-process log entry limit'),
    maxPageSize: bounded('maxPageSize', 'Process log page limit'),
    maxProcessBytes: bounded('maxProcessBytes', 'Per-process log byte limit'),
    maxTotalBytes: bounded('maxTotalBytes', 'Total log byte limit'),
    maxTotalEntries: bounded('maxTotalEntries', 'Total log entry limit'),
    ttlMs: requireInteger(options.ttlMs ?? DEFAULT_LOG_LIMITS.ttlMs, 'Process log retention', { min: 1 })
  })
}

export const createLogRecord = processId => ({
  events: [],
  floorSequence: 0,
  nextSequence: 1,
  processId,
  schemaVersion: LOG_SCHEMA_VERSION,
  totalBytes: 0
})

export const cloneLogRecords = records =>
  new Map([...records].map(([id, record]) => [id, {
    ...record,
    events: record.events.map(event => ({ ...event }))
  }]))

export const countLogEntries = records => {
  let count = 0
  for (const record of records.values()) count += record.events.length
  return count
}

export const normalizeLogInput = (input, sequence, at) => {
  const value = requireRecord(input, 'Process log entry')
  if (typeof value.chunk !== 'string') {
    throw serviceError('service.invalid_request', 'Process log chunk is invalid')
  }
  const source = value.sourceSequence ?? value.sequence
  return {
    at,
    chunk: value.chunk,
    generation: requireInteger(value.generation, 'Process log generation', { min: 1 }),
    sequence,
    ...(source == null ? {} : { sourceSequence: requireInteger(source, 'Process log source sequence', { min: 0 }) }),
    stream: requireString(value.stream, 'Process log stream', { max: 64 })
  }
}

export const publicLogEvent = event => {
  const { at: _at, ...value } = event
  return cloneJson(value)
}

const shift = (record, changed) => {
  const removed = record.events.shift()
  if (removed == null) return 0
  const bytes = logEventBytes(removed)
  record.floorSequence = Math.max(record.floorSequence, removed.sequence)
  record.totalBytes -= bytes
  changed.add(record.processId)
  return bytes
}

export const pruneLogRecords = (records, now, limits) => {
  const changed = new Set()
  for (const record of records.values()) {
    while (record.events[0]?.at < now - limits.ttlMs) shift(record, changed)
    while (record.events.length > limits.maxEntriesPerProcess || record.totalBytes > limits.maxProcessBytes) {
      shift(record, changed)
    }
  }
  let bytes = 0
  let entries = 0
  const ordered = []
  for (const record of records.values()) {
    bytes += record.totalBytes
    entries += record.events.length
    for (const event of record.events) ordered.push({ event, record })
  }
  ordered.sort((left, right) =>
    left.event.at - right.event.at || left.event.sequence - right.event.sequence ||
    left.record.processId.localeCompare(right.record.processId)
  )
  let index = 0
  while (entries > limits.maxTotalEntries || bytes > limits.maxTotalBytes) {
    const candidate = ordered[index++]
    if (candidate == null) throw corrupt()
    if (candidate.record.events[0]?.sequence !== candidate.event.sequence) continue
    bytes -= shift(candidate.record, changed)
    entries -= 1
  }
  return changed
}

export const pageLogRecord = (record, after, limit, generation) => {
  if (after < record.floorSequence) {
    throw serviceError('service.cursor_expired', 'The requested process log cursor has expired', {
      details: { earliestCursor: record.floorSequence + 1 }
    })
  }
  let cursor = after
  const events = []
  for (const event of record.events) {
    if (event.sequence <= after) continue
    cursor = event.sequence
    if (generation != null && event.generation !== generation) continue
    events.push(publicLogEvent(event))
    if (events.length === limit) break
  }
  return { cursor, events }
}

export const validatePersistedLogRecord = input => {
  try {
    const value = requireRecord(input, 'Persisted process logs')
    if (
      value.schemaVersion !== LOG_SCHEMA_VERSION || !Array.isArray(value.events) ||
      value.events.length > HARD_LOG_LIMITS.maxEntriesPerProcess
    ) throw corrupt()
    const record = createLogRecord(requireIdentifier(value.processId, 'Persisted process id'))
    record.floorSequence = requireInteger(value.floorSequence, 'Persisted process log floor', { min: 0 })
    record.nextSequence = requireInteger(value.nextSequence, 'Persisted process log cursor', {
      min: record.floorSequence + 1
    })
    let previous = record.floorSequence
    for (const inputEvent of value.events) {
      const eventValue = requireRecord(inputEvent, 'Persisted process log entry')
      const event = normalizeLogInput(
        { ...eventValue, sequence: undefined },
        requireInteger(
          eventValue.sequence,
          'Persisted process log sequence',
          { max: previous + 1, min: previous + 1 }
        ),
        requireInteger(eventValue.at, 'Persisted process log timestamp', { min: 0 })
      )
      record.events.push(event)
      record.totalBytes += logEventBytes(event)
      previous = event.sequence
    }
    if (record.nextSequence !== previous + 1) throw corrupt()
    if (record.totalBytes !== requireInteger(value.totalBytes, 'Persisted process log bytes', { min: 0 })) {
      throw corrupt()
    }
    return record
  } catch {
    throw corrupt()
  }
}
