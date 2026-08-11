import { randomUUID } from 'node:crypto'

import {
  INSPECTOR_TERMINAL_STATES,
  NETWORK_RULE_TERMINAL_STATES,
  OPERATION_TERMINAL_STATES,
  PROCESS_STATES,
  PROCESS_TERMINAL_STATES
} from './constants.mjs'
import { serviceError } from './errors.mjs'
import {
  cloneJson,
  fingerprintJson,
  requireEnum,
  requireIdentifier,
  requireInteger,
  requireRecord,
  requireString
} from './validation.mjs'

export const newResourceId = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`

export const touchResource = (resource, now) => {
  resource.revision += 1
  resource.updatedAt = now
}

export const getResource = (draft, collection, id, label) => {
  const normalized = requireIdentifier(id, `${label} id`)
  const resource = draft.resources[collection][normalized]
  if (resource == null) throw serviceError('service.not_found', `${label} was not found`)
  return resource
}

export const listResources = (state, collection) => (
  Object.values(state.resources[collection]).sort((left, right) => left.id.localeCompare(right.id)).map(cloneJson)
)

export const requireExpectedGeneration = (process, generation) => {
  requireInteger(generation, 'expectedGeneration', { min: 1 })
  if (process.generation !== generation) {
    throw serviceError('service.precondition_failed', 'Runtime process generation is stale', {
      details: { actualGeneration: process.generation, expectedGeneration: generation }
    })
  }
}

export const createOperationRecord = (kind, target, now, id = newResourceId('operation')) => ({
  createdAt: now,
  id,
  kind: requireString(kind, 'Operation kind', { max: 64 }),
  revision: 1,
  state: 'queued',
  target: cloneJson(target),
  updatedAt: now
})

export const assertOperationTransition = (current, next) => {
  const allowed = {
    cancelled: [],
    failed: [],
    queued: ['cancelled', 'failed', 'running', 'succeeded'],
    running: ['cancelled', 'failed', 'succeeded'],
    succeeded: []
  }
  if (current !== next && !allowed[current]?.includes(next)) {
    throw serviceError('service.conflict', 'Operation state transition is invalid')
  }
}

export const assertProcessTransition = (current, next) => {
  requireEnum(next, PROCESS_STATES, 'Runtime process state')
  const allowed = {
    cancelled: ['queued'],
    exited: ['queued'],
    failed: ['queued'],
    lost: ['queued'],
    queued: ['cancelled', 'failed', 'staging', 'starting', 'stopping'],
    running: ['exited', 'failed', 'lost', 'stopping'],
    staging: ['cancelled', 'failed', 'starting', 'stopping'],
    starting: ['cancelled', 'exited', 'failed', 'lost', 'running', 'stopping', 'waiting_for_debugger'],
    stopping: ['cancelled', 'exited', 'failed', 'lost', 'queued'],
    waiting_for_debugger: ['failed', 'lost', 'running', 'stopping']
  }
  if (current !== next && !allowed[current]?.includes(next)) {
    throw serviceError('service.conflict', 'Runtime process state transition is invalid')
  }
}

export const useIdempotency = (draft, input, now, retentionMs, create) => {
  const key = requireString(input.key, 'Idempotency key', { max: 200 })
  const scope = requireString(input.scope, 'Idempotency scope', { max: 256 })
  const fingerprint = fingerprintJson(input.value)
  const recordKey = fingerprintJson([scope, key])
  const existing = draft.idempotency[recordKey]
  if (existing != null && existing.expiresAt > now) {
    if (existing.fingerprint !== fingerprint) {
      throw serviceError('service.conflict', 'Idempotency key was reused with different input')
    }
    return { replayed: true, value: cloneJson(existing.response) }
  }
  const value = create()
  draft.idempotency[recordKey] = {
    expiresAt: now + retentionMs,
    fingerprint,
    response: cloneJson(value),
    scope
  }
  return { replayed: false, value }
}

export const validateDeviceInput = (input, now) => {
  const value = requireRecord(input, 'Device')
  const platform = requireEnum(value.platform ?? 'android', ['android', 'node'], 'Device platform')
  return {
    ...(value.apiLevel == null ? {} : {
      apiLevel: requireInteger(value.apiLevel, 'Device API level', { min: 1 })
    }),
    ...(value.architecture == null ? {} : {
      architecture: requireString(value.architecture, 'Device architecture', { max: 64 })
    }),
    id: requireIdentifier(value.id, 'Device id'),
    kind: requireEnum(value.kind ?? 'unknown', ['emulator', 'local', 'physical', 'unknown'], 'Device kind'),
    ...(value.model == null ? {} : { model: requireString(value.model, 'Device model', { max: 256 }) }),
    observedAt: now,
    platform,
    serial: requireString(value.serial, 'Device serial', { max: 256 }),
    state: requireEnum(
      value.state,
      ['disconnected', 'offline', 'online', 'unauthorized', 'unknown'],
      'Device state'
    )
  }
}

export const terminalTime = resource => (
  PROCESS_TERMINAL_STATES.has(resource.state) || OPERATION_TERMINAL_STATES.has(resource.state) ||
    INSPECTOR_TERMINAL_STATES.has(resource.state) || NETWORK_RULE_TERMINAL_STATES.has(resource.state)
    ? resource.endedAt ?? resource.closedAt ?? resource.updatedAt
    : undefined
)
