import { invalidPolicy } from './errors.js'
import { normalizeObserverOverflowPayloadV1 } from './observer-overflow.js'
import { OBSERVER_EVENTS_V1 } from './registry-types.js'
import type { RuntimeObserverSelectableEventNameV1 } from './registry-types.js'
import { deepFreeze, exact, finiteNumber, integer, literal, required } from './validation.js'

export type RuntimeObserverEventV1 = Readonly<{
  correlationId?: string
  event: RuntimeObserverSelectableEventNameV1 | 'observer.overflow'
  generation: number
  observedAt: number
  payload: Readonly<Record<string, unknown>>
  schemaVersion: 1
  sequence: number
}>

const observerId = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[\w.:-]{1,128}$/u.test(value)) return invalidPolicy()
  return value
}

const optionalId = (input: Record<string, unknown>, key: string): string | undefined =>
  Object.hasOwn(input, key) ? observerId(input[key]) : undefined

const scriptPayload = (
  event: RuntimeObserverEventV1['event'],
  value: unknown
): Readonly<Record<string, unknown>> | undefined => {
  if (event === 'script.compiled') {
    const input = exact(value, ['origin', 'scriptId', 'sourceBytes', 'sourceSha256'])
    const sha = required(input, 'sourceSha256')
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/u.test(sha)) return invalidPolicy()
    const result: Record<string, unknown> = {
      scriptId: observerId(required(input, 'scriptId')),
      sourceBytes: integer(required(input, 'sourceBytes'), 0, 16 * 1024 * 1024),
      sourceSha256: sha
    }
    if (Object.hasOwn(input, 'origin')) {
      if (typeof input.origin !== 'string' || input.origin.length === 0 || input.origin.length > 4096) {
        return invalidPolicy()
      }
      result.origin = input.origin
    }
    return Object.freeze(result)
  }
  if (event === 'script.execution-started') {
    const input = exact(value, ['executionId', 'scriptId'])
    return Object.freeze({
      executionId: observerId(required(input, 'executionId')),
      scriptId: observerId(required(input, 'scriptId'))
    })
  }
  if (event === 'script.execution-finished') {
    const input = exact(value, ['executionId', 'outcome', 'scriptId'])
    return Object.freeze({
      executionId: observerId(required(input, 'executionId')),
      outcome: literal(required(input, 'outcome'), ['completed', 'terminated', 'threw'] as const),
      scriptId: observerId(required(input, 'scriptId'))
    })
  }
  return undefined
}

const payload = (
  event: RuntimeObserverEventV1['event'],
  value: unknown
): Readonly<Record<string, unknown>> => {
  if (event === 'observer.overflow') {
    return normalizeObserverOverflowPayloadV1(value) as unknown as Readonly<Record<string, unknown>>
  }
  const script = scriptPayload(event, value)
  if (script) return script
  if (event === 'promise.rejected' || event === 'runtime.exception') {
    const input = exact(value, ['code', 'scriptId'])
    const scriptId = optionalId(input, 'scriptId')
    return Object.freeze({ code: observerId(required(input, 'code')), ...(scriptId && { scriptId }) })
  }
  if (event === 'runtime.terminated') {
    const input = exact(value, ['reason'])
    return Object.freeze({
      reason: literal(required(input, 'reason'), ['completed', 'failed', 'lost', 'stopped'] as const)
    })
  }
  if (event === 'memory.pressure') {
    const input = exact(value, ['level'])
    return Object.freeze({
      level: literal(required(input, 'level'), ['critical', 'moderate'] as const)
    })
  }
  const input = exact(value, ['durationMs', 'reclaimedBytes'])
  const result: Record<string, unknown> = {
    durationMs: finiteNumber(required(input, 'durationMs'), 0, 120_000)
  }
  if (Object.hasOwn(input, 'reclaimedBytes')) {
    result.reclaimedBytes = integer(input.reclaimedBytes, 0, Number.MAX_SAFE_INTEGER)
  }
  return Object.freeze(result)
}

export const normalizeRuntimeObserverEventV1 = (value: unknown): RuntimeObserverEventV1 => {
  const input = exact(value, [
    'correlationId',
    'event',
    'generation',
    'observedAt',
    'payload',
    'schemaVersion',
    'sequence'
  ])
  if (required(input, 'schemaVersion') !== 1) return invalidPolicy()
  const event = literal(required(input, 'event'), [...OBSERVER_EVENTS_V1, 'observer.overflow'] as const)
  const correlationId = optionalId(input, 'correlationId')
  return deepFreeze({
    ...(correlationId && { correlationId }),
    event,
    generation: integer(required(input, 'generation'), 1, Number.MAX_SAFE_INTEGER),
    observedAt: finiteNumber(required(input, 'observedAt'), 0, Number.MAX_VALUE),
    payload: payload(event, required(input, 'payload')),
    schemaVersion: 1 as const,
    sequence: integer(required(input, 'sequence'), 1, Number.MAX_SAFE_INTEGER)
  })
}
