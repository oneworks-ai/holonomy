import { invalidPolicy } from './errors.js'
import {
  array,
  boundedText,
  deepFreeze,
  exact,
  finiteNumber,
  identifier,
  integer,
  literal,
  required
} from './validation.js'

export type InvocationSnapshotNodeV1 =
  | Readonly<{ kind: 'scalar'; value: null | boolean | number | string }>
  | Readonly<{ items: readonly InvocationSnapshotNodeV1[]; kind: 'array' }>
  | Readonly<{
    entries: readonly Readonly<{ key: string; value: InvocationSnapshotNodeV1 }>[]
    kind: 'object'
  }>
  | Readonly<{ bindingId: string; byteLength: number; kind: 'binary'; sha256: string }>
  | Readonly<{
    bindingId: string
    bindingType: 'abortSignal' | 'callback' | 'resource'
    generation: number
    kind: 'binding'
  }>
  | Readonly<{ code: string; kind: 'stableError' }>

export interface InvocationSnapshotEnvelopeV1 {
  readonly direction: 'argument' | 'result'
  readonly root: InvocationSnapshotNodeV1
  readonly schemaVersion: 1
}

interface SnapshotState {
  nodes: number
}

const sha256 = (value: unknown): string => {
  const text = boundedText(value, 64)
  if (!/^[0-9a-f]{64}$/u.test(text)) return invalidPolicy()
  return text
}

const scalar = (value: unknown): null | boolean | number | string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    return Object.is(value, -0)
      ? 0
      : finiteNumber(value, -Number.MAX_VALUE, Number.MAX_VALUE)
  }
  return invalidPolicy()
}

const bindingId = (value: unknown): string => identifier(value)

const compareCodePoints = (left: string, right: string): number => {
  const leftPoints = [...left]
  const rightPoints = [...right]
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}

const node = (
  value: unknown,
  direction: InvocationSnapshotEnvelopeV1['direction'],
  state: SnapshotState,
  depth = 0
): InvocationSnapshotNodeV1 => {
  if (depth > 16 || ++state.nodes > 1024) return invalidPolicy()
  const input = exact(value, [
    'bindingId',
    'bindingType',
    'byteLength',
    'code',
    'entries',
    'generation',
    'items',
    'kind',
    'sha256',
    'value'
  ])
  const kind = literal(
    required(input, 'kind'),
    [
      'array',
      'binary',
      'binding',
      'object',
      'scalar',
      'stableError'
    ] as const
  )
  if (kind === 'scalar') return Object.freeze({ kind, value: scalar(required(input, 'value')) })
  if (kind === 'array') {
    return Object.freeze({
      items: Object.freeze(array(required(input, 'items')).map(item => node(item, direction, state, depth + 1))),
      kind
    })
  }
  if (kind === 'object') {
    const entries = array(required(input, 'entries')).map(item => {
      const entry = exact(item, ['key', 'value'])
      const key = boundedText(required(entry, 'key'), 16 * 1024)
      return Object.freeze({ key, value: node(required(entry, 'value'), direction, state, depth + 1) })
    })
    if (new Set(entries.map(entry => entry.key)).size !== entries.length) return invalidPolicy()
    entries.sort((left, right) => compareCodePoints(left.key, right.key))
    return Object.freeze({ entries: Object.freeze(entries), kind })
  }
  if (kind === 'binary') {
    return Object.freeze({
      bindingId: bindingId(required(input, 'bindingId')),
      byteLength: integer(required(input, 'byteLength'), 0, 256 * 1024 * 1024),
      kind,
      sha256: sha256(required(input, 'sha256'))
    })
  }
  if (kind === 'stableError') {
    return Object.freeze({
      code: boundedText(required(input, 'code'), 128),
      kind
    })
  }
  const bindingType = literal(
    required(input, 'bindingType'),
    [
      'abortSignal',
      'callback',
      'resource'
    ] as const
  )
  if (direction === 'result' && bindingType !== 'resource') return invalidPolicy()
  return Object.freeze({
    bindingId: bindingId(required(input, 'bindingId')),
    bindingType,
    generation: integer(required(input, 'generation'), 1, Number.MAX_SAFE_INTEGER),
    kind
  })
}

export const normalizeInvocationSnapshotEnvelopeV1 = (
  value: unknown
): InvocationSnapshotEnvelopeV1 => {
  const input = exact(value, ['direction', 'root', 'schemaVersion'])
  if (required(input, 'schemaVersion') !== 1) return invalidPolicy()
  const direction = literal(required(input, 'direction'), ['argument', 'result'] as const)
  return deepFreeze({
    direction,
    root: node(required(input, 'root'), direction, { nodes: 0 }),
    schemaVersion: 1 as const
  })
}
