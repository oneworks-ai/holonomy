import { invalidPolicy } from './errors.js'
import { normalizeInvocationSnapshotEnvelopeV1 } from './invocation-snapshot.js'
import type { InvocationSnapshotEnvelopeV1, InvocationSnapshotNodeV1 } from './invocation-snapshot.js'

const trustedValueBrand = Symbol('HolonomyTrustedInvocationValueV1')

export interface TrustedInvocationValueV1<T = unknown> {
  readonly envelope: InvocationSnapshotEnvelopeV1
  readonly value: Readonly<T>
  readonly [trustedValueBrand]: true
}

const decode = (node: InvocationSnapshotNodeV1): unknown => {
  if (node.kind === 'scalar') return node.value
  if (node.kind === 'stableError') return Object.freeze({ code: node.code })
  if (node.kind === 'binary') {
    return Object.freeze({
      bindingId: node.bindingId,
      byteLength: node.byteLength,
      sha256: node.sha256
    })
  }
  if (node.kind === 'binding') {
    return Object.freeze({
      bindingId: node.bindingId,
      bindingType: node.bindingType,
      generation: node.generation
    })
  }
  if (node.kind === 'array') return Object.freeze(node.items.map(decode))
  const output = Object.create(null) as Record<string, unknown>
  for (const entry of node.entries) output[entry.key] = decode(entry.value)
  return Object.freeze(output)
}

export const trustedInvocationValueFromSnapshotV1 = <T = unknown>(
  envelopeValue: unknown,
  direction: InvocationSnapshotEnvelopeV1['direction']
): TrustedInvocationValueV1<T> => {
  const envelope = normalizeInvocationSnapshotEnvelopeV1(envelopeValue)
  if (envelope.direction !== direction) return invalidPolicy()
  return Object.freeze({
    envelope,
    value: decode(envelope.root) as Readonly<T>,
    [trustedValueBrand]: true as const
  })
}

export const isTrustedInvocationValueV1 = (
  value: unknown,
  direction?: InvocationSnapshotEnvelopeV1['direction']
): value is TrustedInvocationValueV1 =>
  value != null && typeof value === 'object' &&
  (value as Partial<TrustedInvocationValueV1>)[trustedValueBrand] === true &&
  (direction === undefined || (value as TrustedInvocationValueV1).envelope.direction === direction)
